import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginEntry } from "@dsh-shelfry/schema";
import { idmapShardId } from "@dsh-shelfry/schema";
import { pagePlan, indexPagePlan } from "./page-plan";
import { dataUrl } from "./data-url";
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

/** 本次会话的数据版本（artifacts.generatedAt）：拼到所有数据请求上，避免新旧产物混用。 */
let dataVersion = "";

/**
 * 拉取 data 下的 JSON。
 *
 * 序号类产物（idmap / 各分片）必须来自同一版本，所以统一带 ?v=<版本>；
 * 版本取自本次会话最先拿到的 artifacts.json。传 cache 可覆盖浏览器缓存策略，
 * 兜底重查时用 "reload" 彻底绕过缓存。
 */
async function getJson<T>(path: string, cache?: RequestCache): Promise<T> {
  if (!dataVersion) await loadArtifacts();
  const res = await fetch(dataUrl(BASE, path, dataVersion), { cache, headers: { accept: "application/json" } });
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

/**
 * 产物清单缓存。
 *
 * 存 Promise 而不是结果：首页会并发发起 loadArtifacts / loadMeta / loadPage，
 * 若只缓存结果，几个调用点同时看到缓存为空，就会在同一瞬间各发一次
 * artifacts.json（实测每次首屏稳定 2 条重复请求）。
 */
let artifactsPending: Promise<ArtifactIndex> | null = null;

/**
 * 拉产物清单。默认 no-cache（每次回源校验），兜底重查传 reload 彻底绕过缓存。
 *
 * 清单决定本次会话所有分片的版本号：缓存到旧清单会让新数据的序号落到
 * 分片之外，详情页就会误报「仓库已下架」。
 */
function loadArtifactsWith(cache: RequestCache): Promise<ArtifactIndex> {
  if (!artifactsPending) {
    const pending = (async () => {
      const res = await fetch(dataUrl(BASE, "artifacts.json", ""), { cache, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`拉取 artifacts.json 失败: HTTP ${res.status}`);
      const value = (await res.json()) as ArtifactIndex;
      dataVersion = value.generatedAt;
      return value;
    })();
    // 失败不要把 rejected promise 留在缓存里，否则后续调用永远失败
    pending.catch(() => {
      if (artifactsPending === pending) artifactsPending = null;
    });
    artifactsPending = pending;
  }
  return artifactsPending;
}

export const loadArtifacts = (): Promise<ArtifactIndex> => loadArtifactsWith("no-cache");

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

/** 榜单三个页签的切片（构建期已排好序，每个页签 50 条）。 */
export interface TopLists {
  stars: LiteEntry[];
  recent: LiteEntry[];
  score: LiteEntry[];
}

const topCache = { v: null as TopLists | null };
/**
 * 榜单页专用：只用约 150 条，没必要为它拉全量 lite.json（约 1 MB br）。
 * 排序在构建期完成，前端拿到的顺序即最终顺序。
 */
export const loadTop = async (): Promise<TopLists> => {
  if (!topCache.v) topCache.v = await getJson<TopLists>("top.json");
  return topCache.v;
};

/** 单条目的推荐 id 列表：a = 同作者，s = 相似。 */
interface RelatedLists {
  a: string[];
  s: string[];
  /** 与 a 对应的全局序号（新产物才有，老产物缺失时回退 id 反查） */
  ai?: number[];
  /** 与 s 对应的全局序号 */
  si?: number[];
}

/**
 * 已知全局序号时直接取卡片：跳过 idmap 反查，只拉命中的分页文件。
 *
 * 出参 index → 卡片，越界序号或空位直接跳过（不阻塞整批）。
 */
async function loadEntriesAt(pages: ArtifactIndex["pages"], indexes: number[]): Promise<Map<number, LiteEntry>> {
  const out = new Map<number, LiteEntry>();
  const plan = indexPagePlan(indexes, pages.size);
  const jobs = [...plan.entries()];
  for (let i = 0; i < jobs.length; i += FAVORITES_CONCURRENCY) {
    const batch = jobs.slice(i, i + FAVORITES_CONCURRENCY);
    await Promise.all(
      batch.map(async ([page, list]) => {
        if (page >= pages.count) return;
        const rows = await loadPage(page);
        for (const gi of list) {
          const row = rows[gi - page * pages.size];
          if (row) out.set(gi, row);
        }
      }),
    );
  }
  return out;
}

/**
 * 详情页推荐：走「推荐分片拿 id/序号 → 分页文件拿卡片」两步，不再拉全量切片。
 *
 * 入参 id：条目 id；出参同作者与相似的卡片，顺序按构建期算好的权重。
 * 产物缺推荐分片（老版本构建）或条目不在 idmap 里时返回空，页面留空即可。
 */
export async function loadRelated(id: string): Promise<{ byAuthor: LiteEntry[]; similar: LiteEntry[] }> {
  const empty = { byAuthor: [] as LiteEntry[], similar: [] as LiteEntry[] };
  const artifacts = await loadArtifacts();
  const index = await lookupIndex(artifacts, id);
  if (index === undefined || !artifacts.related) return empty;
  const { size } = artifacts.related;
  const shard = Math.floor(index / size);
  const rows = await getJson<RelatedLists[]>(`related/${String(shard).padStart(4, "0")}.json`);
  const row = rows[index - shard * size];
  if (!row) return empty;

  // 新产物随推荐一起下发了全局序号：直接算分页、取卡片，每张卡省一次 idmap 反查
  const ai = row.ai ?? [];
  const si = row.si ?? [];
  if (ai.length === row.a.length && si.length === row.s.length) {
    const cards = await loadEntriesAt(artifacts.pages, [...ai, ...si]);
    // 序号与产物错位（旧 bundle 配新数据）时 id 对不上，改用 id 反查兜底
    const matches = (ids: string[], at: number[]) => ids.every((x, k) => cards.get(at[k] as number)?.i === x);
    if (matches(row.a, ai) && matches(row.s, si)) {
      const pick = (ids: string[], at: number[]) =>
        ids.map((x, k) => cards.get(at[k] as number)).filter((v): v is LiteEntry => !!v);
      return { byAuthor: pick(row.a, ai), similar: pick(row.s, si) };
    }
  }

  const cards = await loadEntriesByIds([...row.a, ...row.s]);
  const pick = (ids: string[]) => ids.map((x) => cards.get(x)).filter((v): v is LiteEntry => !!v);
  return { byAuthor: pick(row.a), similar: pick(row.s) };
}

/** 同一时刻最多并发几个分片请求，避免收藏很多时一次打满连接池。 */
const FAVORITES_CONCURRENCY = 6;

/**
 * 收藏页取数：按 id 只拉命中的分页文件，不再拉全量切片。
 *
 * 入参 ids：收藏 id 列表；出参 id → 完整卡片数据，查不到的 id 不出现在结果里。
 * 与详情页共用 idmap 和 pages 产物，两者都不需要额外维护。
 */
export async function loadEntriesByIds(ids: string[]): Promise<Map<string, LiteEntry>> {
  const out = new Map<string, LiteEntry>();
  if (!ids.length) return out;
  const artifacts = await loadArtifacts();
  const map = await lookupIndexes(artifacts, ids);
  const { pages } = pagePlan(map, ids, artifacts.pages.size);
  // 同一序号可能被大小写不同的 id 指到，回填时把请求用的 id 也登记上
  const idByIndex = new Map<number, string>();
  for (const [id, index] of Object.entries(map)) idByIndex.set(index, id);
  const jobs = [...pages.entries()];
  for (let i = 0; i < jobs.length; i += FAVORITES_CONCURRENCY) {
    const batch = jobs.slice(i, i + FAVORITES_CONCURRENCY);
    await Promise.all(
      batch.map(async ([page, indexes]) => {
        const rows = await loadPage(page);
        for (const gi of indexes) {
          const row = rows[gi - page * artifacts.pages.size];
          if (!row) continue;
          out.set(row.i, row);
          const requested = idByIndex.get(gi);
          if (requested) out.set(requested, row);
        }
      }),
    );
  }
  return out;
}

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

/** 单个 idmap 分片的并发去重缓存：同一片被多处同时请求时只发一次。 */
const idShardCache = new Map<number, Promise<Record<string, number>>>();
/**
 * 整份反查表（只给两条路径用：老产物回退、收录弹窗要全量键集合）。
 *
 * 缓存 Promise 而不是结果：并发调用共用同一个请求，否则详情页的几个调用点
 * 会同时各发一次（实测同时出现 4 条 idmap.json 请求）。
 */
let legacyIdMapPending: Promise<Record<string, number>> | null = null;

function loadLegacyIdMap(reload = false): Promise<Record<string, number>> {
  if (reload || !legacyIdMapPending) {
    const pending = getJson<Record<string, number>>("idmap.json", reload ? "reload" : undefined);
    // 失败不要把 rejected promise 留在缓存里，否则后续调用永远失败
    pending.catch(() => {
      if (legacyIdMapPending === pending) legacyIdMapPending = null;
    });
    legacyIdMapPending = pending;
  }
  return legacyIdMapPending;
}

/**
 * id → 全局序号。
 *
 * 新产物把反查表切成 64 片，只拉命中片（约 14 KB raw / 6 KB br）；
 * 老产物没有 artifacts.idmap，回退整份 idmap.json（约 900 KB raw）。
 * 大小写不一致时由 resolveEntryId 在同一片内兜底匹配。
 */
async function lookupIndex(artifacts: ArtifactIndex, id: string, reload = false): Promise<number | undefined> {
  if (!artifacts.idmap) {
    const map = await loadLegacyIdMap(reload);
    const key = resolveEntryId(map, id);
    return key ? map[key] : undefined;
  }
  const shard = idmapShardId(id, artifacts.idmap.count);
  if (reload) idShardCache.delete(shard);
  let pending = idShardCache.get(shard);
  if (!pending) {
    pending = getJson<Record<string, number>>(`idmap/${String(shard).padStart(4, "0")}.json`, reload ? "reload" : undefined);
    idShardCache.set(shard, pending);
  }
  const map = await pending;
  const key = resolveEntryId(map, id);
  return key ? map[key] : undefined;
}

/** 批量反查：不同 id 可能落在同一片，靠 idShardCache 合并成一次请求。 */
async function lookupIndexes(artifacts: ArtifactIndex, ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all([...new Set(ids)].map(async (id) => {
    const index = await lookupIndex(artifacts, id);
    if (index !== undefined) out[id] = index;
  }));
  return out;
}

/** 单纯按 id 查明细：不处理版本错配。 */
async function lookupEntry(artifacts: ArtifactIndex, id: string): Promise<PluginEntry | null> {
  const index = await lookupIndex(artifacts, id);
  if (index === undefined) return null;
  return loadEntryAt(artifacts, index);
}

/**
 * 版本错配兜底：清空全部数据缓存，强制回源重取清单与反查表分片。
 *
 * 只在「反查表能查到序号、清单里却没有对应分片」时调用 —— 部署瞬间的旧缓存
 * 会造成这种组合；正常的无效链接不该触发，否则每访问一个 404 都要重拉数据。
 */
async function refreshDataCaches(): Promise<void> {
  artifactsPending = null;
  idShardCache.clear();
  legacyIdMapPending = null;
  collectedIdsPending = null;
  shardCache.clear();
  liteCache = null;
  topCache.v = null;
  await loadArtifactsWith("reload");
}

/**
 * 直达详情页时用：把 owner/repo 翻成全局序号（大小写不一致也能命中）。
 *
 * 首查落空时判断是「真的没有」还是「清单与反查表版本不一致」：后者强制回源后再查一次。
 */
export async function loadEntryById(artifacts: ArtifactIndex, id: string): Promise<PluginEntry | null> {
  const found = await lookupEntry(artifacts, id);
  if (found) return found;
  // 反查表也查不到，说明这个仓库确实没收录：不触发回源重取
  if ((await lookupIndex(artifacts, id)) === undefined) return null;
  await refreshDataCaches();
  return lookupEntry(await loadArtifacts(), id);
}

let collectedIdsPending: Promise<Set<string>> | null = null;

/**
 * 收录弹窗用：拿到全部已收录仓库，给队列条目标「已收录」/「待下次构建」。
 *
 * 键统一转小写：数据里的 id 是 GitHub 原始大小写（如 `Moessif/code-video-showcase`），
 * 而收录队列被提交时转成了小写；GitHub 仓库名本身不区分大小写，比较时必须忽略大小写，
 * 否则已上线的条目会被误判成「待收录」，「清理已收录」也筛不到它。
 */
export async function loadCollectedIds(): Promise<Set<string>> {
  // 这里需要全量键集合，分片反而要拉满 64 片，直接用整份反查表；
  // 与老产物回退共用同一个请求，避免同一次解锁重复拉
  if (!collectedIdsPending) {
    const pending = loadLegacyIdMap().then((map) => new Set(Object.keys(map).map((id) => id.toLowerCase())));
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
