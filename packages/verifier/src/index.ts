import type { ArtifactIndex, PluginEntry, VerificationStatus } from "@dsh-shelfry/schema";
import { SCHEMA_VERSION } from "@dsh-shelfry/schema";
import { loadCatalog, saveCatalog } from "@dsh-shelfry/collector/store";
import { scoreEntry } from "@dsh-shelfry/collector/score";
import {
  buildMeta,
  syncToWebPublic,
  writeArtifactIndex,
  writeDetailShards,
  writeIndexShards,
  writeLite,
  writeMeta,
} from "@dsh-shelfry/collector/emit";
import { resolveDshBin, readDshVersion } from "./dsh.ts";
import { Ledger } from "./ledger.ts";
import { verifyEntry } from "./verify.ts";

/**
 * 验证管道 CLI。
 *
 *   npm run verify -- --limit 200                 验证分数最高的 200 条 pending
 *   npm run verify -- --all --concurrency 4       全量（含已验证的，刷新结论）
 *   npm run verify -- --ids owner/repo,other/repo 只验证指定条目
 *   npm run verify -- --limit 300 --build         顺带重算分数并 emit 产物到 web/public
 *   DSH_BIN=/path/to/dsh npm run verify           指定 dsh CLI
 *
 * 产物在验证后必须重新生成：可装性占综合分 40%，验证结论变了，lite/pages/meta 都要跟着变。
 */

interface Args {
  limit: number;
  all: boolean;
  ids: string[];
  concurrency: number;
  l2: boolean;
  build: boolean;
  dshBin: string | null;
  silent: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { limit: 200, all: false, ids: [], concurrency: 4, l2: true, build: false, dshBin: null, silent: false };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string | undefined => argv[++i];
    switch (argv[i]) {
      case "--limit": {
        const v = Number(next());
        if (Number.isFinite(v) && v >= 0) a.limit = v;
        break;
      }
      case "--all": a.all = true; break;
      case "--ids": a.ids = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--concurrency": a.concurrency = Math.max(1, Number(next()) || a.concurrency); break;
      case "--no-l2": a.l2 = false; break;
      case "--build": a.build = true; break;
      case "--dsh-bin": a.dshBin = next() ?? null; break;
      case "--silent": a.silent = true; break;
      default: break;
    }
  }
  return a;
}

const log = (silent: boolean, ...m: unknown[]): void => { if (!silent) console.log(...m); };

/** 可验证候选：pnpm-profile 且抽到了规范化 npm 包名。 */
function isVerifiable(e: PluginEntry): boolean {
  return e.install.method === "pnpm-profile" && !!e.install.packageName;
}

/** 并发池：dsh 装包是 IO 密集（等 pnpm/网络），并发能显著缩短整体耗时。 */
async function pool<T, R>(items: T[], size: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await worker(item, i);
    }
  });
  await Promise.all(runners);
  return out;
}

/** 重算全部条目分数、排序、emit 产物并同步到 web/public。 */
function emitAll(entries: PluginEntry[], dshVersion: string | null): void {
  const now = Date.now();
  for (const e of entries) e.score = scoreEntry(e, now);
  entries.sort((a, b) => b.score.total - a.score.total || a.id.localeCompare(b.id));

  const meta = buildMeta(entries, dshVersion);
  const { pages } = writeLite(entries);
  const shards = writeDetailShards(entries);
  const index = writeIndexShards(entries);
  const artifacts: ArtifactIndex = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: meta.generatedAt,
    shards,
    index,
    pages,
    intents: null,
  };
  writeArtifactIndex(artifacts);
  writeMeta(meta);
  syncToWebPublic();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dshBin = args.dshBin ?? resolveDshBin();
  const silent = args.silent;

  const dshVersion = await readDshVersion(dshBin);
  log(silent, `[verifier] dsh CLI：${dshBin}（${dshVersion ?? "版本未知"}）`);

  const catalog = loadCatalog();
  const entries = catalog.entries;
  // 先套用历史验证证据：收录数据每次 CI 都重建，账本是唯一能跨构建累积结论的地方。
  const ledger = Ledger.load();
  // 本地首次跑 / 账本丢失时，用 store 里已有的结论回填，避免重复花时间重验。
  const seeded = ledger.seedFrom(entries);
  if (seeded > 0) ledger.save();
  const applied = ledger.applyTo(entries);
  log(silent, `[verifier] store 条目 ${entries.length} 条，账本命中 ${applied}/${ledger.size} 条（回填 ${seeded}）`);

  let candidates: PluginEntry[];
  if (dshVersion === null) {
    // 探测不到 CLI 就一条都不验：宁可用账本里的旧结论生成产物，也不要因为环境问题
    // 把整站条目批量判成 failed（那会直接毁掉站点最核心的信任信号）。
    log(silent, `[verifier] 未探测到可用的 dsh CLI（${dshBin}），本轮跳过验证`);
    candidates = [];
  } else if (args.ids.length) {
    const set = new Set(args.ids);
    candidates = entries.filter((e) => set.has(e.id) || set.has(e.install.packageName ?? ""));
  } else {
    candidates = entries.filter((e) => isVerifiable(e) && (args.all || e.verification.status === "pending"));
    // 分数降序：优先把最有价值的条目验出来，首页才先有核。
    candidates.sort((a, b) => b.score.total - a.score.total || a.id.localeCompare(b.id));
    candidates = candidates.slice(0, args.limit);
  }

  if (candidates.length === 0) {
    log(silent, "[verifier] 没有待验证条目。");
  } else {
    log(silent, `[verifier] 待验证 ${candidates.length} 条（并发 ${args.concurrency}，L2 ${args.l2 ? "开" : "关"}）`);
  }

  const byId = new Map(entries.map((e) => [e.id, e]));
  const run: Record<VerificationStatus, number> = { verified: 0, pending: 0, failed: 0 };
  let done = 0;
  const started = Date.now();

  await pool(candidates, args.concurrency, async (entry) => {
    const v = await verifyEntry(entry, { dshBin, l2: args.l2, dshVersion });
    const target = byId.get(entry.id);
    if (target) {
      target.verification = v;
      target.updatedAt = new Date().toISOString();
    }
    ledger.record(entry, v);
    run[v.status]++;
    done++;
    const tag = v.status === "verified" ? "OK  " : v.status === "failed" ? "FAIL" : "SKIP";
    const why = v.status === "pending" ? "" : ` (${v.l2?.error ?? v.l1?.error ?? v.diagnostics?.[0] ?? ""})`;
    log(
      silent,
      `[${String(done).padStart(String(candidates.length).length)}/${candidates.length}] ${tag} ${entry.id.padEnd(40)} L1=${v.l1 ? Math.round(v.l1.ms) + "ms" : "-"}${why}`,
    );
    // 每 10 条落一次盘：长跑可中断续跑（未验证的仍为 pending）。
    if (done % 10 === 0) {
      saveCatalog({ generatedAt: new Date().toISOString(), entries });
      ledger.save();
    }
    return v;
  });

  saveCatalog({ generatedAt: new Date().toISOString(), entries });
  const ledgerFile = ledger.save();
  const secs = Math.round((Date.now() - started) / 1000);
  log(silent, `[verifier] 本轮：verified=${run.verified} failed=${run.failed} pending=${run.pending}（${secs}s）`);
  log(silent, `[verifier] 账本已写入 ${ledgerFile}（累计 ${ledger.size} 条证据）`);

  const stats: Record<VerificationStatus, number> = { verified: 0, pending: 0, failed: 0 };
  for (const e of entries) stats[e.verification.status]++;
  log(silent, `[verifier] store 累计：verified=${stats.verified} pending=${stats.pending} failed=${stats.failed}`);

  if (args.build) {
    emitAll(entries, dshVersion);
    log(silent, "[verifier] 已重算分数并 emit 产物到 packages/web/public/data");
  } else {
    log(silent, "[verifier] 未加 --build：产物未重生成（分数已随验证结论写入 store）");
  }
}

main().catch((err) => {
  console.error(`[verifier] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
