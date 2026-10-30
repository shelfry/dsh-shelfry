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
/** 数据请求超时上限：与收录弹窗的写接口同量级，超过就报错而不是一直等 */
const FETCH_TIMEOUT_MS = 8000;

async function getJson<T>(path: string, cache: RequestCache = "default"): Promise<T> {
  try {
    const res = await fetch(url(path), {
      cache,
      headers: { accept: "application/json" },
      // 挂起的请求不能让它无限转圈：超时后转成可读错误，页面才有机会显示失败态。
      // 老浏览器没有 AbortSignal.timeout（Safari 15 及更早），退回无超时也要能正常请求
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
    });
    if (!res.ok) throw new Error(`拉取 ${path} 失败: HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError") throw new Error(`拉取 ${path} 超时，请检查网络后重试`);
    throw err;
  }
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
    // 每次会话唯一参数：清单必须是最新一代。固定 URL 会被边缘缓存住（最长数小时），
    // 旧清单的序号落到分片表之外，尾部条目详情页就会误报「已下架」。
    const pending = getJson<ArtifactIndex>(`artifacts.json?_=${Date.now()}`, "no-cache");
    // 失败不要把 rejected promise 留在缓存里，否则后续调用永远失败
    pending.catch(() => {
      if (artifactsPending === pending) artifactsPending = null;
    });
    artifactsPending = pending;
  }
  return artifactsPending;
}

let metaPending: Promise<CatalogMeta> | null = BOOTSTRAP?.meta ? Promise.resolve(BOOTSTRAP.meta) : null;
export function loadMeta(): Promise<CatalogMeta> {
  if (!metaPending) {
    const pending = getJson<CatalogMeta>("meta.json");
    // 失败不要把 rejected promise 留在缓存里，否则后续调用永远失败
    pending.catch(() => { if (metaPending === pending) metaPending = null; });
    metaPending = pending;
  }
  return metaPending;
}

const categoryCache = new Map<CatalogScope, Category[]>();
const categoryPending = new Map<CatalogScope, Promise<Category[]>>();
// 有内联数据时直接预置缓存：loadCategories 命中缓存，不再发请求
if (BOOTSTRAP) {
  categoryCache.set("plugins", BOOTSTRAP.categories);
  categoryCache.set("tools", BOOTSTRAP.categoriesTools);
}
/** 分类清单按范围分成两份：插件与工具的标签规模差太多，不能共用一张表。 */
export const loadCategories = (scope: CatalogScope = "plugins"): Promise<Category[]> => {
  const cached = categoryCache.get(scope);
  if (cached) return Promise.resolve(cached);
  const inflight = categoryPending.get(scope);
  if (inflight) return inflight;
  const file = scope === "tools" ? "categories-tools.json" : "categories.json";
  const pending = getJson<Category[]>(file).then((rows) => {
    categoryCache.set(scope, rows);
    categoryPending.delete(scope);
    return rows;
  });
  pending.catch(() => { if (categoryPending.get(scope) === pending) categoryPending.delete(scope); });
  categoryPending.set(scope, pending);
  return pending;
};

/** 分页切片按页码缓存 Promise：来回翻页不重复请求，并发调用也只发一次。 */
const pagePending = new Map<number, Promise<LiteEntry[]>>();
export const loadPage = (page: number): Promise<LiteEntry[]> => {
  const cached = pagePending.get(page);
  if (cached) return cached;
  const pending = getJson<LiteEntry[]>(`pages/${String(page).padStart(4, "0")}.json`);
  pending.catch(() => { if (pagePending.get(page) === pending) pagePending.delete(page); });
  pagePending.set(page, pending);
  return pending;
};

/** lite 切片里 external 用短键 ec 标记；缺失即 DSH 插件。 */
export const isExternal = (e: LiteEntry): boolean => e.ec === "external";
export const scopeCount = (meta: CatalogMeta | null, scope: CatalogScope): number => {
  if (!meta) return 0;
  return scope === "tools" ? meta.external ?? 0 : meta.total - (meta.external ?? 0);
};

let litePending: Promise<LiteEntry[]> | null = null;
/** 全量浏览切片（搜索、筛选与详情页推荐时需要，首次使用时加载并缓存）。
 *  缓存的是 Promise 而不是结果：首页的空闲预取、筛选、搜索框聚焦可能并发触发，
 *  只缓存结果的话，下载完成前的每个调用都会各发一次 10 MB 的请求。 */
export function loadLite(): Promise<LiteEntry[]> {
  if (!litePending) {
    const pending = getJson<LiteEntry[]>("lite.json");
    // 失败不要把 rejected promise 留在缓存里，否则后续调用永远失败
    pending.catch(() => {
      if (litePending === pending) litePending = null;
    });
    litePending = pending;
  }
  return litePending;
}

/**
 * 明细分片缓存：每片 500 条约 565 KB，全部留着会让长会话吃掉几十 MB。
 * 只保留最近用过的 8 片（约 4.5 MB），够覆盖同一次浏览里的来回切换。
 */
const SHARD_CACHE_LIMIT = 8;
const shardCache = new Map<number, PluginEntry[]>();

/** 写入并维护 LRU 顺序：命中过的分片移到队尾，超出上限的丢弃。 */
function rememberShard(from: number, chunk: PluginEntry[]): void {
  shardCache.delete(from);
  shardCache.set(from, chunk);
  while (shardCache.size > SHARD_CACHE_LIMIT) {
    const oldest = shardCache.keys().next().value;
    if (oldest === undefined) break;
    shardCache.delete(oldest);
  }
}

/** 按全局序号拉明细：明细分片按分数序切成 500 一片。 */
export async function loadEntryAt(artifacts: ArtifactIndex, globalIndex: number): Promise<PluginEntry | null> {
  const shard = artifacts.shards.find((s) => globalIndex >= s.from && globalIndex <= s.to);
  if (!shard) return null;
  let chunk = shardCache.get(shard.from);
  if (!chunk) {
    chunk = await getJson<PluginEntry[]>(shard.file);
    rememberShard(shard.from, chunk);
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
