import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginEntry } from "@dsh-shelfry/schema";

import { REPO_ROOT } from "./config.ts";
import { isPurgeCandidate, resolveEmptyReadme } from "./readme-gate.ts";
import { loadCatalog } from "./store.ts";

/**
 * 空 README 一次性审计：把「0 星 + README 空」的仓库清出来，写进 curation/purge.json。
 *
 *   npm run audit:empty-readme -- --from-site            # 读线上产物，只打印结果
 *   npm run audit:empty-readme -- --from-site --apply    # 复核无误后写入清退名单
 *
 * 本地 .data/catalog.json 可能是几天前的旧快照，条目数与线上不一致；
 * 要清退当前站点上的条目，必须加 --from-site 读同一份明细分片。
 */

const SITE_BASE = "https://shelfry.app/data";
const PURGE_FILE = resolve(REPO_ROOT, "curation/purge.json");
const FETCH_RETRIES = 3;

interface Args {
  fromSite: boolean;
  base: string;
  apply: boolean;
  /** 探测上限；0 表示不限 */
  limit: number;
  /** 打印多少条样例 */
  sample: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { fromSite: false, base: SITE_BASE, apply: false, limit: 0, sample: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--from-site": args.fromSite = true; break;
      case "--base": args.base = next() ?? args.base; break;
      case "--apply": args.apply = true; break;
      case "--limit": args.limit = Number(next()) || 0; break;
      case "--sample": args.sample = Number(next()) || 20; break;
      default: break;
    }
  }
  return args;
}

/** 拉 JSON：失败重试 3 次后抛错 —— 审计不能静默少读几片。 */
async function fetchJson(url: string): Promise<unknown> {
  let last = "";
  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < FETCH_RETRIES - 1) await new Promise((done) => setTimeout(done, 800 * (attempt + 1)));
  }
  throw new Error(`${url} 拉取失败：${last}`);
}

/** 读取线上站点的全部明细分片。 */
async function fetchSiteEntries(base: string): Promise<PluginEntry[]> {
  const index = (await fetchJson(`${base}/artifacts.json`)) as { shards?: { file?: unknown }[] };
  const files = (index.shards ?? [])
    .map((row) => row.file)
    .filter((file): file is string => typeof file === "string");
  const out: PluginEntry[] = [];
  for (let i = 0; i < files.length; i++) {
    const rows = await fetchJson(`${base}/${files[i]}`);
    if (!Array.isArray(rows)) throw new Error(`分片结构不是数组：${files[i]}`);
    out.push(...(rows as PluginEntry[]));
    if ((i + 1) % 10 === 0) console.log(`[审计] 已读取 ${i + 1}/${files.length} 片，累计 ${out.length} 条`);
  }
  return out;
}

function readPurge(): string[] {
  if (!existsSync(PURGE_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(PURGE_FILE, "utf8")) as unknown;
    const rows = Array.isArray(parsed) ? parsed : (parsed as { repos?: unknown } | null)?.repos;
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is string => typeof row === "string");
  } catch {
    return [];
  }
}

function writePurge(ids: string[]): void {
  writeFileSync(PURGE_FILE, JSON.stringify({ repos: ids }, null, 2) + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entries = args.fromSite ? await fetchSiteEntries(args.base) : loadCatalog().entries;
  const source = args.fromSite ? args.base : ".data/catalog.json";
  console.log(`[审计] 数据源：${source}，共 ${entries.length} 条`);

  const zeroDsh = entries.filter((e) => e.stars === 0 && e.ecosystem === "dsh").length;
  const candidates = entries.filter(isPurgeCandidate);
  console.log(`[审计] 0 星 DSH 条目 ${zeroDsh} 条，人工豁免（curated / 队列 / Issue）${zeroDsh - candidates.length} 条，待探测 ${candidates.length} 条`);

  const gate = await resolveEmptyReadme(entries, { limit: args.limit });
  console.log(
    `[审计] 探测：实际探测 ${gate.probed} 条 / 缓存命中 ${gate.cached} 条 / 无法判定（保留）${gate.unknown} 条`,
  );
  console.log(
    `[审计] README 缺失 ${gate.missing} 条 / README 无正文 ${gate.blank} 条 → 待清退 ${gate.empty.length} 条`,
  );
  console.log(`[审计] 其中已有安装命令 ${gate.emptyWithCommand.length} 条（复核重点：可能是真插件）`);

  console.log(`[审计] 待清退样例（前 ${args.sample} 条）：`);
  for (const e of gate.empty.slice(0, args.sample)) console.log(`  - ${e.id}`);
  if (gate.emptyWithCommand.length > 0) {
    console.log(`[审计] 空 README 但已有安装命令（前 ${args.sample} 条）：`);
    for (const e of gate.emptyWithCommand.slice(0, args.sample)) {
      console.log(`  - ${e.id} | ${e.install.command ?? ""}`);
    }
  }

  if (!args.apply) {
    console.log("[审计] dry-run：未写入 curation/purge.json；复核无误后加 --apply 执行");
    return;
  }
  const before = readPurge();
  const merged = [...new Set([...before, ...gate.empty.map((e) => e.id)])].sort();
  writePurge(merged);
  console.log(
    `[审计] 已写入 ${PURGE_FILE}：原有 ${before.length} 条 / 新增 ${merged.length - before.length} 条 / 合计 ${merged.length} 条`,
  );
  if (gate.unknown > 0) {
    console.log(`[审计] 注意：还有 ${gate.unknown} 条无法判定，本轮保留，下次构建会重试`);
  }
}

main().catch((err) => {
  console.error(`[审计] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
