import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginEntry } from "@dsh-shelfry/schema";
import { INDEX_SHARD_COUNT, SCHEMA_VERSION, indexShardId, toLiteEntry } from "@dsh-shelfry/schema";
import { DATA_DIR, WEB_PUBLIC_DATA_DIR } from "./config.ts";

/**
 * 产物生成。目标：首屏只拉「一小片」，全站 13k 条也不拖垮低端机。
 *
 * 产物结构（全部落在 .data/，不进 git）：
 *   lite.json                     浏览切片（短键名，全量，按分数序）—— 搜索用
 *   pages/<NNNN>.json             分页浏览切片 —— 首屏只拉 0000
 *   meta.json                     站点元信息 + 三档计数
 *   catalog/<NNN>.json            明细分片（详情页按需拉）
 *   index/<NNN>.json              倒排索引分片（token 哈希落片，搜索时只载命中片）
 *   artifacts.json                产物清单（web 先读它，再按需拉具体片）
 */

const DETAIL_SHARD_SIZE = 500;
const PAGE_SIZE = 60;


function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

export function buildMeta(
  entries: PluginEntry[],
  collectSource?: CatalogMeta["collectSource"],
): CatalogMeta {
  const types: Record<string, number> = {};
  const sources = new Set<string>();
  for (const e of entries) {
    types[e.type] = (types[e.type] ?? 0) + 1;
    for (const s of e.sources) sources.add(s);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    total: entries.length,
    types,
    sources: [...sources].sort(),
    ...(collectSource ? { collectSource } : {}),
  };
}

/** 浏览切片：全量（搜索用）+ 分页文件（首屏只拉第 0 页）。 */
export function writeLite(entries: PluginEntry[]): { file: string; lite: LiteEntry[]; pages: ArtifactIndex["pages"] } {
  const lite = entries.map(toLiteEntry);
  const file = resolve(DATA_DIR, "lite.json");
  writeJson(file, lite);

  for (let start = 0; start < lite.length; start += PAGE_SIZE) {
    const chunk = lite.slice(start, start + PAGE_SIZE);
    writeJson(resolve(DATA_DIR, `pages/${String(start / PAGE_SIZE).padStart(4, "0")}.json`), chunk);
  }

  return {
    file,
    lite,
    pages: {
      size: PAGE_SIZE,
      count: Math.max(1, Math.ceil(lite.length / PAGE_SIZE)),
      filePattern: "pages/{page}.json",
    },
  };
}

/** 明细分片：按分数序切片，详情页只拉对应片。 */
export function writeDetailShards(entries: PluginEntry[]): ArtifactIndex["shards"] {
  const shards: ArtifactIndex["shards"] = [];
  for (let start = 0; start < entries.length; start += DETAIL_SHARD_SIZE) {
    const chunk = entries.slice(start, start + DETAIL_SHARD_SIZE);
    const file = `catalog/${String(start / DETAIL_SHARD_SIZE).padStart(4, "0")}.json`;
    writeJson(resolve(DATA_DIR, file), chunk.map((e) => {
      const { score, ...rest } = e;
      return { ...rest, score };
    }));
    shards.push({ file, from: start, to: start + chunk.length - 1, count: chunk.length });
  }
  return shards;
}

/**
 * 倒排索引分片。
 * 分词：拉丁/数字词（小写，≥2 字符）+ 中文 bigram（单字串退化为单字）。
 * 分片 key = token 前 2 字符；查询时只载相关分片。
 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._-]+/g)) {
    if (m[0].length >= 2) tokens.add(m[0]);
  }
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) tokens.add(run);
    else for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens];
}

export function entryTokens(e: PluginEntry): string[] {
  return tokenize([e.name, e.fullName, e.description, e.descriptionZh ?? "", e.tags.join(" ")].join(" "));
}

export function writeIndexShards(entries: PluginEntry[]): ArtifactIndex["index"] {
  const idx = new Map<string, number[]>();
  entries.forEach((e, i) => {
    for (const tk of entryTokens(e)) {
      const arr = idx.get(tk);
      if (arr) arr.push(i);
      else idx.set(tk, [i]);
    }
  });

  const buckets = new Map<number, Record<string, number[]>>();
  for (const [tk, postings] of idx) {
    const id = indexShardId(tk);
    let bucket = buckets.get(id);
    if (!bucket) { bucket = {}; buckets.set(id, bucket); }
    bucket[tk] = postings;
  }

  const out: ArtifactIndex["index"] = { shardCount: INDEX_SHARD_COUNT, shards: [] };
  for (const [id, bucket] of buckets) {
    const file = `index/${String(id).padStart(3, "0")}.json`;
    writeJson(resolve(DATA_DIR, file), bucket);
    out.shards.push({ id, file, tokens: Object.keys(bucket).length });
  }
  out.shards.sort((a, b) => a.id - b.id);
  return out;
}

export function writeArtifactIndex(index: ArtifactIndex): string {
  const file = resolve(DATA_DIR, "artifacts.json");
  writeJson(file, index);
  return file;
}

export function writeMeta(meta: CatalogMeta): string {
  const file = resolve(DATA_DIR, "meta.json");
  writeJson(file, meta);
  return file;
}

/**
 * 分类清单：把上游 tags 聚合成「分类 chips」用的数据。
 *
 * 为什么要排除一批 tag：dsh / dsh-plugin / deepseek-harness / typescript 这类是
 * 「它是什么」，不是「它能干什么」。全部保留会让分类行挤满同义词，用户仍然无从选择。
 * 只留描述用途的中文/场景标签，并过滤长尾（出现次数太少的分类点进去只有几条）。
 */
const CATEGORY_STOP = new Set([
  "dsh", "dsh-plugin", "dsh-plugins", "dsh-plugin-market", "dsh-bundle",
  "deepseek", "deepseek-harness", "deepseek-harness-plugin", "deepseek-harness-plugins",
  "cordis", "cordis-plugin", "plugin", "plugins", "ai", "agent", "ai-agent", "ai-agents",
  "llm", "typescript", "javascript", "nodejs", "react", "openai", "api", "cli",
]);

const CATEGORY_MIN_COUNT = 20;
const CATEGORY_MAX = 48;

export function writeCategories(entries: PluginEntry[]): string {
  const tally = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.tags) {
      const key = t.trim();
      if (!key || CATEGORY_STOP.has(key.toLowerCase())) continue;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const list = [...tally.entries()]
    .filter(([, n]) => n >= CATEGORY_MIN_COUNT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, CATEGORY_MAX)
    .map(([t, n]) => ({ t, n }));

  const file = resolve(DATA_DIR, "categories.json");
  writeJson(file, list);
  return file;
}

/**
 * id → 全局序号 的反查表。
 * 详情页是可分享的独立 URL（#/p/owner/repo），直接打开时手上只有 id；
 * 明细分片是按序号切的，所以需要这张表把 id 翻成序号。仅在直达详情页时加载，约几十 KB。
 */
export function writeIdMap(entries: PluginEntry[]): string {
  const map: Record<string, number> = {};
  entries.forEach((e, i) => { map[e.id] = i; });
  const file = resolve(DATA_DIR, "idmap.json");
  writeJson(file, map);
  return file;
}

/** 把产物同步到 web 的 public/data（构建期用；运行时只读静态文件，无需后端）。
 *  catalog.json 是本地 store 的全量副本，明细分片已等价覆盖，不必发给前端。 */
export function syncToWebPublic(): void {
  rmSync(WEB_PUBLIC_DATA_DIR, { recursive: true, force: true });
  mkdirSync(resolve(WEB_PUBLIC_DATA_DIR, ".."), { recursive: true });
  cpSync(DATA_DIR, WEB_PUBLIC_DATA_DIR, {
    recursive: true,
    filter: (src) => !src.endsWith("/catalog.json") && !src.endsWith("\\catalog.json"),
  });
}
