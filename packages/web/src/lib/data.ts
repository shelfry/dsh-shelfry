import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginEntry } from "@dsh-shelfry/schema";

/**
 * 数据层：只读静态产物，无后端。
 *
 * 路径全部走 BASE_URL（base './'）⇒ 换域名 / 换子路径部署都不需要改一行代码。
 * 首屏只拉「清单 + 元信息 + 分类 + 第 0 页」四个小文件；
 * 全量切片只在搜索/筛选时才拉，明细分片只在打开详情页时才拉。
 */

const BASE = import.meta.env.BASE_URL;
const url = (p: string) => `${BASE}data/${p}`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(url(path), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`拉取 ${path} 失败: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface SiteConfig {
  siteName: string;
  siteNameZh: string;
  tagline: string;
  taglineZh: string;
  domain: string;
  basePath: string;
  repoUrl: string;
  dataBaseUrl: string;
  license: string;
}

export const siteConfig: SiteConfig = __SITE__;

/** 分类 chip 的数据形状（构建期由 upstream tags 聚合而成）。 */
export interface Category {
  /** 标签原文 */ t: string;
  /** 条目数 */ n: number;
}

const artifactsCache = { v: null as ArtifactIndex | null };
export const loadArtifacts = async (): Promise<ArtifactIndex> => {
  if (!artifactsCache.v) artifactsCache.v = await getJson<ArtifactIndex>("artifacts.json");
  return artifactsCache.v;
};

const metaCache = { v: null as CatalogMeta | null };
export const loadMeta = async (): Promise<CatalogMeta> => {
  if (!metaCache.v) metaCache.v = await getJson<CatalogMeta>("meta.json");
  return metaCache.v;
};

export const loadCategories = () => getJson<Category[]>("categories.json");
export const loadPage = (page: number) => getJson<LiteEntry[]>(`pages/${String(page).padStart(4, "0")}.json`);

let liteCache: LiteEntry[] | null = null;
/** 全量浏览切片（搜索与筛选时需要，首次使用时加载并缓存）。 */
export async function loadLite(): Promise<LiteEntry[]> {
  if (!liteCache) liteCache = await getJson<LiteEntry[]>("lite.json");
  return liteCache;
}

const shardCache = new Map<number, PluginEntry[]>();
/** 按全局序号拉明细：明细分片按分数序切成 500 一片。 */
export async function loadEntryAt(artifacts: ArtifactIndex, globalIndex: number): Promise<PluginEntry | null> {
  const shard = artifacts.shards.find((s) => globalIndex >= s.from && globalIndex <= s.to);
  if (!shard) return null;
  let chunk = shardCache.get(shard.from);
  if (!chunk) {
    chunk = await getJson<PluginEntry[]>(shard.file);
    shardCache.set(shard.from, chunk);
  }
  return chunk[globalIndex - shard.from] ?? null;
}

let idMapCache: Record<string, number> | null = null;
/** 直达详情页时用：把 owner/repo 翻成全局序号。 */
export async function loadEntryById(artifacts: ArtifactIndex, id: string): Promise<PluginEntry | null> {
  if (!idMapCache) idMapCache = await getJson<Record<string, number>>("idmap.json");
  const index = idMapCache[id];
  if (index === undefined) return null;
  return loadEntryAt(artifacts, index);
}

/**
 * 详情页路径。
 *
 * 只返回路径不给 hash 前缀：HashRouter 的 <Link to> 需要纯路径（它自己管 #），
 * 传 "#/p/xxx" 会被当成普通路径再拼一次，得到 #/#/p/xxx 而匹配不到路由。
 * id 里的斜杠原样保留，路由端用 /p/* 通配段接住。
 */
export function detailPath(id: string): string {
  return `/p/${id}`;
}
