import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginEntry } from "@dsh-shelfry/schema";
import { pickCategories, type CatalogBootstrap } from "./bootstrap";
import { resolveEntryId } from "./idmap";

/**
 * 数据层：只读静态产物，无后端。
 *
 * 路径全部走 BASE_URL（base '/'）⇒ 换域名部署不需要改一行代码。
 * 元信息与分类清单一并在构建期内联进 JS（见 bootstrap.ts），首屏不再为它们发请求；
 * 第 0 页数据在首屏拉取；
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

/** 首页的两个浏览范围：DSH 插件 / 非 DSH 独立工具。 */
export type CatalogScope = "plugins" | "tools";

/**
 * 内联数据；数据文件缺失（未跑 collector）时为 null，退回运行时 fetch。
 */
const BOOTSTRAP: CatalogBootstrap | null = __CATALOG_BOOTSTRAP__;

/** 首帧可直接使用的总量信息；缺失时为 null。 */
export const bootstrapMeta = (): CatalogMeta | null => BOOTSTRAP?.meta ?? null;

/** 首帧可直接使用的分类清单；缺失时为 null。 */
export const bootstrapCategories = (scope: CatalogScope): Category[] | null => pickCategories(BOOTSTRAP, scope);

const artifactsCache = { v: null as ArtifactIndex | null };
export const loadArtifacts = async (): Promise<ArtifactIndex> => {
  if (!artifactsCache.v) artifactsCache.v = await getJson<ArtifactIndex>("artifacts.json");
  return artifactsCache.v;
};

const metaCache: { v: CatalogMeta | null } = { v: BOOTSTRAP?.meta ?? null };
export const loadMeta = async (): Promise<CatalogMeta> => {
  if (!metaCache.v) metaCache.v = await getJson<CatalogMeta>("meta.json");
  return metaCache.v;
};

const categoryCache = new Map<CatalogScope, Category[]>();
// 有内联数据时直接预置缓存：loadCategories 命中缓存，不再发请求
if (BOOTSTRAP) {
  categoryCache.set("plugins", BOOTSTRAP.categories);
  categoryCache.set("tools", BOOTSTRAP.categoriesTools);
}
/** 分类清单按范围分成两份：插件与工具的标签规模差太多，不能共用一张表。 */
export const loadCategories = (scope: CatalogScope = "plugins"): Promise<Category[]> => {
  const cached = categoryCache.get(scope);
  if (cached) return Promise.resolve(cached);
  const file = scope === "tools" ? "categories-tools.json" : "categories.json";
  return getJson<Category[]>(file).then((rows) => {
    categoryCache.set(scope, rows);
    return rows;
  });
};
export const loadPage = (page: number) => getJson<LiteEntry[]>(`pages/${String(page).padStart(4, "0")}.json`);

/** lite 切片里 external 用短键 ec 标记；缺失即 DSH 插件。 */
export const isExternal = (e: LiteEntry): boolean => e.ec === "external";
export const scopeCount = (meta: CatalogMeta | null, scope: CatalogScope): number => {
  if (!meta) return 0;
  return scope === "tools" ? meta.external ?? 0 : meta.total - (meta.external ?? 0);
};

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
const loadIdMap = async (): Promise<Record<string, number>> => {
  if (!idMapCache) idMapCache = await getJson<Record<string, number>>("idmap.json");
  return idMapCache;
};

/** 直达详情页时用：把 owner/repo 翻成全局序号（大小写不一致也能命中）。 */
export async function loadEntryById(artifacts: ArtifactIndex, id: string): Promise<PluginEntry | null> {
  const map = await loadIdMap();
  const key = resolveEntryId(map, id);
  if (!key) return null;
  const index = map[key];
  if (index === undefined) return null;
  return loadEntryAt(artifacts, index);
}

/**
 * 收录弹窗用：拿到全部已收录仓库，给队列条目标「已收录」/「待下次构建」。
 *
 * 键统一转小写：数据里的 id 是 GitHub 原始大小写（如 `Moessif/code-video-showcase`），
 * 而收录队列被提交时转成了小写；GitHub 仓库名本身不区分大小写，比较时必须忽略大小写，
 * 否则已上线的条目会被误判成「待收录」，「清理已收录」也筛不到它。
 */
export async function loadCollectedIds(): Promise<Set<string>> {
  return new Set(Object.keys(await loadIdMap()).map((id) => id.toLowerCase()));
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
