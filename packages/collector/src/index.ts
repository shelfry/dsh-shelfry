import type { ArtifactIndex } from "@dsh-shelfry/schema";
import { SCHEMA_VERSION } from "@dsh-shelfry/schema";
import { loadCatalog, mergeEntries, saveCatalog, catalogPath } from "./store.ts";
import {
  buildMeta,
  syncToWebPublic,
  writeArtifactIndex,
  writeCategories,
  writeDetailShards,
  writeIdMap,
  writeIndexShards,
  writeLite,
  writeMeta,
} from "./emit.ts";
import { normalizeRecord, type RawRecord } from "./normalize.ts";
import { fetchMirrorRecords } from "./sources/mirror.ts";
import { fetchGithubRecords, fetchReposByNames } from "./sources/github.ts";
import { resolveVersions } from "./versions.ts";
import { resolveDownloads } from "./downloads.ts";
import { clearBorrowedPackageInfo } from "./identity.ts";
import { resolveEvidence, writeDroppedList } from "./evidence.ts";
import { resolveInstallCommands } from "./install-probe.ts";

/**
 * 收录管道 CLI。
 *
 *   npm run collect -- --source mirror --limit 200
 *   npm run collect -- --source github --limit 500        # 需 GITHUB_TOKEN
 *   npm run collect -- --source auto                      # 有 token 走 GitHub，否则镜像兜底
 *   npm run collect -- --source mirror --build            # 顺带把产物同步到 web/public/data
 */

interface Args {
  source: "mirror" | "github" | "auto";
  limit: number;
  queries: string[] | null;
  sync: boolean;
  silent: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { source: "auto", limit: 20000, queries: null, sync: false, silent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--source": {
        const v = next();
        if (v === "mirror" || v === "github" || v === "auto") args.source = v;
        break;
      }
      case "--limit": args.limit = Number(next()) || args.limit; break;
      case "--queries": args.queries = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--build": args.sync = true; break;
      case "--silent": args.silent = true; break;
      default: break;
    }
  }
  return args;
}

const log = (silent: boolean, ...m: unknown[]) => { if (!silent) console.log(...m); };

interface LoadedRecords {
  records: RawRecord[];
  sourceLabel: string;
  /** 走了兜底时的原因，写进 meta.json 让站上能显示出来。 */
  reason?: string;
}

async function loadRawRecords(args: Args): Promise<LoadedRecords> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  if (token) {
    // 只打形状（长度/前缀/是否含空白），值一律不落日志 —— 用来排查 Secret 粘贴脏了的情况
    console.log(`[collector] token 形状：长度 ${token.length}，前缀 ${token.slice(0, 4)}，含空白 ${/\s/.test(token)}`);
  }
  const fromMirror = async (reason?: string): Promise<LoadedRecords> => {
    if (reason) console.warn(`[collector] ${reason}，降级到镜像种子源。`);
    return { records: await fetchMirrorRecords(args.limit), sourceLabel: "mirror", ...(reason ? { reason } : {}) };
  };

  if (args.source === "mirror") return fromMirror();
  if (!token) return fromMirror("未检测到 GITHUB_TOKEN");
  if (args.source === "github") {
    // 显式指定主源时不兜底：让故障直接暴露出来，便于排查。
    const records = await fetchGithubRecords({
      token,
      perQueryLimit: args.limit,
      ...(args.queries ? { queries: args.queries } : {}),
    });
    return { records, sourceLabel: "github" };
  }

  // auto：优先自建主源，失败则降级。
  // 数据源（尤其 CI 内置 token 调不动 Search API）抖一下就整站部署失败是不可接受的，
  // 种子源足够让站点保持可用，缺失的部分靠下一次成功抓取补齐。
  try {
    const records = await fetchGithubRecords({
      token,
      perQueryLimit: args.limit,
      ...(args.queries ? { queries: args.queries } : {}),
    });
    return { records, sourceLabel: "github" };
  } catch (err) {
    return fromMirror(`GitHub 检索失败（${err instanceof Error ? err.message : String(err)}）`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();

  const prev = loadCatalog();
  log(args.silent, `[collector] 已有条目 ${prev.entries.length} 条`);

  const { records, sourceLabel } = await loadRawRecords(args);
  log(args.silent, `[collector] 来源=${sourceLabel}，抓到原始记录 ${records.length} 条`);

  // 一次性补录：CI 用 workflow_dispatch 的 rescue 输入传入仓库全名，逐条取详情后并入本轮。
  const rescueNames = (process.env.RESCUE_REPOS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (rescueNames.length > 0) {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
    const rescued = token ? await fetchReposByNames(rescueNames, token) : [];
    log(args.silent, `[collector] 补录 ${rescueNames.length} 个仓库，成功取回 ${rescued.length} 条`);
    records.push(...rescued);
  }

  const prevById = new Map(prev.entries.map((e) => [e.id, e]));
  const incoming = [];
  let rejected = 0;
  for (const raw of records) {
    const id = String(raw.id ?? raw.fullName ?? "");
    const entry = normalizeRecord(raw, now, prevById.get(id));
    if (!entry) { rejected++; continue; }
    incoming.push(entry);
  }
  if (rejected > 0) log(args.silent, `[collector] 规整后丢弃 ${rejected} 条（缺 id）`);

  const merged = mergeEntries(prev, incoming);
  const entries = merged.catalog.entries;

  // 生态归属实证：名字/简介里看不出 DSH 的条目逐条取证据，三层全空才剔除。
  // 放在版本号与下载量之前，避免给注定要删的条目白花几百次请求。
  const verdict = await resolveEvidence(entries);
  log(
    args.silent,
    `[collector] 生态判定：名称自带 ${verdict.result.named} 条 / 缓存命中 ${verdict.result.cached} 条 / 实测 ${verdict.result.probed} 条（保留 ${verdict.result.kept} 条，判无关 ${verdict.result.dropped} 条）`,
  );
  const dropIds = new Set(verdict.dropped.map((e) => e.id));
  const active = dropIds.size > 0 ? entries.filter((e) => !dropIds.has(e.id)) : entries;
  // 历史数据里可能残留「dsh skill add」——这条命令并不存在，一律清掉
  let bogus = 0;
  for (const e of active) {
    if (e.install.command && /^dsh\s+skill\s+add/i.test(e.install.command)) {
      e.install.command = null;
      bogus++;
    }
  }
  if (bogus > 0) log(args.silent, `[collector] 清除 ${bogus} 条不存在的 skill 安装命令`);
  if (dropIds.size > 0) {
    merged.catalog.entries = active;
    const droppedFile = writeDroppedList(verdict.dropped);
    log(args.silent, `[collector] 剔除 ${dropIds.size} 条非 DSH 条目，清单：${droppedFile}`);
  }

  // 安装命令补全：缺命令的条目再读一次 README，收上游写明的 dsh plugin add
  // 与自带安装器（npx/bunx/pnpm dlx）。必须在版本号/下载量之前跑 —— 包名可能被修正。
  const probe = await resolveInstallCommands(active, { now: now.getTime() });
  log(
    args.silent,
    `[collector] 安装命令补全：探测 ${probe.probed} 条 / 缓存命中 ${probe.cached} 条 / 补出 DSH 命令 ${probe.dsh} 条 / 上游安装器 ${probe.native} 条`,
  );

  // 版本号补齐必须发生在写产物之前 —— lite 切片要带 vr 字段。
  const versionHits = await resolveVersions(active);
  log(args.silent, `[collector] 版本号命中 ${versionHits} 条`);

  // 下载量同样要在写产物之前补全 —— lite 切片要带 dl 字段。
  const downloads = await resolveDownloads(active);
  log(
    args.silent,
    `[collector] npm 周下载量命中 ${downloads.hits} 条（缓存回填 ${downloads.cached} 个包 / 实际查询 ${downloads.queried} 个包）`,
  );

  // 清洗「借来的包名」：同一个包被多个仓库认领时，只给名字对得上的那条留版本/下载量
  const borrowed = clearBorrowedPackageInfo(active);
  if (borrowed > 0) log(args.silent, `[collector] 清除 ${borrowed} 条借用的版本号/下载量`);

  const saved = saveCatalog(merged.catalog);
  log(args.silent, `[collector] 合并完成：新增 ${merged.added} / 覆盖 ${merged.updated} / 合计 ${active.length} 条`);
  log(args.silent, `[collector] store 已写入 ${saved}`);

  const meta = buildMeta(active);
  log(args.silent, `[collector] 条目 ${meta.total} 条，类型分布 ${JSON.stringify(meta.types)}`);

  const { pages, lite } = writeLite(active);
  const shards = writeDetailShards(active);
  const index = writeIndexShards(active);
  const artifacts: ArtifactIndex = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: meta.generatedAt,
    shards,
    index,
    pages,
    intents: null,
  };
  const artifactFile = writeArtifactIndex(artifacts);
  const metaFile = writeMeta(meta);
  const categoryFile = writeCategories(entries);
  const idMapFile = writeIdMap(entries);
  log(args.silent, `[collector] 产物：lite=${lite.length} 条 / 分页 ${pages.count} 页 / 明细 ${shards.length} 片 / 索引 ${index.shards.length} 片`);
  log(args.silent, `[collector] 清单：${artifactFile}  元信息：${metaFile}`);
  log(args.silent, `[collector] 分类：${categoryFile}  反查表：${idMapFile}`);
  log(args.silent, `[collector] store 路径：${catalogPath()}`);

  if (args.sync) {
    syncToWebPublic();
    log(args.silent, `[collector] 已同步产物到 packages/web/public/data`);
  }
}

main().catch((err) => {
  console.error(`[collector] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
