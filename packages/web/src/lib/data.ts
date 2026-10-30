import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginEntry } from "@dsh-shelfry/schema";
import { pickCategories, type CatalogBootstrap } from "./bootstrap";
import { resolveEntryId } from "./idmap";

/**
 * 数据层：只读静态产物，无后端。
 *
 * 路径全部走 BASE_URL（base '/'）⇒ 换域名部署不需要改一行代码。
 * 元信息与分类清单一并在构建期内联进 JS（见 bootstrap.ts），首屏不再为它们发请求；
 * 第 0 页数据在首屏拉取；
 * 全量切片只在搜索/筛选/推荐时才拉，明细分片只在打开详情页时才拉。
 */

const BASE = import.meta.env.BASE_URL;
const url = (p: string) => `${BASE}data/${p}`;

async function getJson<T>(path: string, cache: RequestCache = "default"): Promise<T> {
  const res = await fetch(url(path), { cache, headers: { accept: "application/json" } });
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

let artifactsPending: Promise<ArtifactIndex> | null = null;

/**
 * 拉产物清单。
 *
 * no-cache：清单决定本次会话所有分片的版本，缓存到旧清单会让新数据的序号
 * 落到分片之外，详情页就会误报「仓库已下架」。
 * 缓存的是 Promise 而不是结果：首页会并发调用，只留值的话每个调用都会发一次请求。
 */
export function loadArtifacts(): Promise<ArtifactIndex> {
  if (!artifactsPending) {
    const pending = getJson<ArtifactIndex>("artifacts.json", "no-cache");
    // 失败不要把 rejected promise 留在缓存里，否则后续调用永远失败
    pending.catch(() => {
      if (artifactsPending === pending) artifactsPending = null;
    });
    artifactsPending = pending;
  }
  return artifactsPending;
}

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
/** 全量浏览切片（搜索、筛选与详情页推荐时需要，首次使用时加载并缓存）。 */
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

let idMapPending: Promise<Record<string, number>> | null = null;

/** 整份反查表：详情页直达与收录弹窗都要用，同一会话只拉一次。 */
function loadIdMap(cache: RequestCache = "default"): Promise<Record<string, number>> {
  if (cache === "reload" || !idMapPending) {
    const pending = getJson<Record<string, number>>("idmap.json", cache);
    pending.catch(() => {
      if (idMapPending === pending) idMapPending = null;
    });
    idMapPending = pending;
  }
  return idMapPending;
}

/** 直达详情页时用：把 owner/repo 翻成全局序号（大小写不一致也能命中）。 */
export async function loadEntryById(artifacts: ArtifactIndex, id: string): Promise<PluginEntry | null> {
  const found = await lookupEntry(artifacts, id);
  if (found) return found;
  const map = await loadIdMap();
  // 反查表里也没有这个键：仓库确实没收录，不做回源重取
  if ((await lookupIndex(id)) === undefined) return null;
  // 有键但取不到明细：清单或反查表是旧版本，强制回源后再查一次
  shardCache.clear();
  artifactsPending = null;
  const [freshArtifacts, freshMap] = await Promise.all([loadArtifacts(), loadIdMap("reload")]);
  const key = resolveEntryId(freshMap, id);
  if (!key) return null;
  const index = freshMap[key];
  if (index === undefined) return null;
  return loadEntryAt(freshArtifacts, index);
}

/** 用当前反查表取明细；查不到返回 null。 */
async function lookupEntry(artifacts: ArtifactIndex, id: string): Promise<PluginEntry | null> {
  const index = await lookupIndex(id);
  if (index === undefined) return null;
  return loadEntryAt(artifacts, index);
}

/** 反查表里的大小写不敏感查找，返回全局序号。 */
async function lookupIndex(id: string): Promise<number | undefined> {
  const map = await loadIdMap();
  const key = resolveEntryId(map, id);
  return key ? map[key] : undefined;
}

let collectedIdsPending: Promise<Set<string>> | null = null;

/**
 * 收录弹窗用：拿到全部已收录仓库，给队列条目标「已收录」/「待下次构建」。
 *
 * 键统一转小写：数据里的 id 是 GitHub 原始大小写（如 `Moessif/code-video-showcase`），
 * 而收录队列被提交时转成了小写；GitHub 仓库名本身不区分大小写，比较时必须忽略大小写，
 * 否则已上线的条目会被误判成「待收录」，「清理已收录」也筛不到它。
 * 缓存 Promise：连点解锁时只发一次请求。
 */
export function loadCollectedIds(): Promise<Set<string>> {
  if (!collectedIdsPending) {
    const pending = loadIdMap().then((map) => new Set(Object.keys(map).map((id) => id.toLowerCase())));
    pending.catch(() => {
      if (collectedIdsPending === pending) collectedIdsPending = null;
    });
    collectedIdsPending = pending;
  }
  return collectedIdsPending;
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
