import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginEntry } from "@dsh-shelfry/schema";
import { INDEX_SHARD_COUNT, SCHEMA_VERSION, idmapShardId, indexShardId, toLiteEntry } from "@dsh-shelfry/schema";
import { DATA_DIR, WEB_PUBLIC_DATA_DIR } from "./config.ts";
import { pickTop } from "./top.ts";
import { RELATED_SHARD_SIZE, buildRelated } from "./related.ts";

/**
 * 产物生成。目标：首屏只拉「一小片」，全站 13k 条也不拖垮低端机。
 *
 * 产物结构（全部落在 .data/，不进 git）：
 *   lite.json                     浏览切片（短键名，全量，按分数序）—— 搜索用
 *   pages/<NNNN>.json             分页浏览切片 —— 首屏只拉 0000
 *   top.json                      榜单三个页签各 50 条 —— 榜单页专用
 *   meta.json                     站点元信息 + 三档计数
 *   catalog/<NNN>.json            明细分片（详情页按需拉）
 *   idmap.json / idmap/<NN>.json  id → 序号反查表（整份兼容 / 64 分片）
 *   index/<NNN>.json              倒排索引分片（token 哈希落片，搜索时只载命中片）
 *   artifacts.json                产物清单（web 先读它，再按需拉具体片）
 */

const DETAIL_SHARD_SIZE = 100;
const PAGE_SIZE = 60;
/** id 反查表分片数：26k 条切成 64 片，单片约 14 KB raw，详情页只取命中片。 */
const IDMAP_SHARD_COUNT = 64;


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
  let external = 0;
  for (const e of entries) {
    types[e.type] = (types[e.type] ?? 0) + 1;
    if (e.ecosystem === "external") external++;
    for (const s of e.sources) sources.add(s);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    total: entries.length,
    external,
    types,
    sources: [...sources].sort(),
    ...(collectSource ? { collectSource } : {}),
  };
}

/** 榜单产物：写一个几十 KB 的 top.json，榜单页单独拉取。 */
export function writeTop(lite: LiteEntry[]): string {
  const file = resolve(DATA_DIR, "top.json");
  writeJson(file, pickTop(lite));
  return file;
}

/**
 * 推荐关系产物：每条目只存「同作者 4 个 id + 相似 4 个 id」。
 *
 * 分片按全局序号对齐（每片 RELATED_SHARD_SIZE 条），前端拿到序号后取对应片即可。
 * 这样详情页不再为了 8 条推荐去下载全量切片，它们改为按 id 去分页文件取卡片。
 */
export function writeRelated(lite: LiteEntry[]): { size: number; count: number; filePattern: string } {
  const related = buildRelated(lite);
  for (let start = 0; start < lite.length; start += RELATED_SHARD_SIZE) {
    const rows = lite
      .slice(start, start + RELATED_SHARD_SIZE)
      .map((v) => related.get(v.i) ?? { a: [], s: [] });
    writeJson(resolve(DATA_DIR, `related/${String(start / RELATED_SHARD_SIZE).padStart(4, "0")}.json`), rows);
  }
  return {
    size: RELATED_SHARD_SIZE,
    count: Math.max(1, Math.ceil(lite.length / RELATED_SHARD_SIZE)),
    filePattern: "related/{shard}.json",
  };
}

/** 浏览切片：全量（搜索用）+ 分页文件（首屏只拉第 0 页）。 */
export function writeLite(entries: PluginEntry[]): { file: string; lite: LiteEntry[]; pages: ArtifactIndex["pages"] } {
  // 镜像/克隆仓只认简介里的明确声明（mirror of / 镜像存档 / 上游删库 …）。
  // 不能用「同名仓库 ≥ N」这类启发式：dsh-memory、dsh-notify 这些通用名下面
  // 大多是各自独立的实现，按名字统计会把正常插件一起打成镜像。
  const mirrorClaim =
    /mirror(?:ed)?\s+(?:of|from)|standalone\s+mirror|镜像(?:存档|备份)|备份镜像|克隆自|上游(?:即将)?删库|原仓库已(?:于[^。；]{0,24})?(?:下架|删除|清空)|(?:全量|完整)镜像[^。；]{0,24}(?:分支|标签|提交|tag)/i;
  const lite = entries.map((e) => {
    const item = toLiteEntry(e);
    if (mirrorClaim.test(e.descriptionZh ?? e.description)) item.dp = 1;
    return item;
  });
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
/** 工具数量远小于插件，阈值不能照搬，否则工具页永远没有分类。 */
const TOOL_CATEGORY_MAX = 24;

function writeCategoryFile(entries: PluginEntry[], name: string, minCount: number, max: number): string {
  const tally = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.tags) {
      const key = t.trim();
      if (!key || CATEGORY_STOP.has(key.toLowerCase())) continue;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const list = [...tally.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t, n]) => ({ t, n }));

  const file = resolve(DATA_DIR, name);
  writeJson(file, list);
  return file;
}

/**
 * 分类清单按生态分成两份：插件页与工具页各自的标签规模完全不在一个量级，
 * 混在一张表里工具分类会被插件分类挤掉。
 */
export function writeCategories(entries: PluginEntry[]): string[] {
  return [
    writeCategoryFile(entries.filter((e) => e.ecosystem !== "external"), "categories.json", CATEGORY_MIN_COUNT, CATEGORY_MAX),
    // 工具页条目少，单个标签也算分类会铺满两行无意义的 chips，至少要有两条才成类
    writeCategoryFile(entries.filter((e) => e.ecosystem === "external"), "categories-tools.json", 2, TOOL_CATEGORY_MAX),
  ];
}

/**
 * id → 全局序号 的反查表。
 * 详情页是可分享的独立 URL（#/p/owner/repo），直接打开时手上只有 id；
 * 明细分片是按序号切的，所以需要这张表把 id 翻成序号。
 *
 * 现在同时输出：
 *   idmap.json          整份（约 900 KB raw），只留给旧版本 bundle 兼容
 *   idmap/<NN>.json     64 片（单片约 14 KB raw），新前端只拉命中片
 */
export function writeIdMap(entries: PluginEntry[]): { file: string; value: ArtifactIndex["idmap"] } {
  const map: Record<string, number> = {};
  entries.forEach((e, i) => { map[e.id] = i; });
  const file = resolve(DATA_DIR, "idmap.json");
  writeJson(file, map);

  const buckets: Array<Record<string, number>> = Array.from({ length: IDMAP_SHARD_COUNT }, () => ({}));
  entries.forEach((e, i) => {
    buckets[idmapShardId(e.id, IDMAP_SHARD_COUNT)]![e.id] = i;
  });
  buckets.forEach((bucket, shard) => {
    writeJson(resolve(DATA_DIR, `idmap/${String(shard).padStart(4, "0")}.json`), bucket);
  });

  return { file, value: { count: IDMAP_SHARD_COUNT, filePattern: "idmap/{shard}.json" } };
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
