import type { LiteEntry } from "@dsh-shelfry/schema";
import Fuse from "fuse.js";

/**
 * 客户端检索：一次线性扫描 + 字段权重打分，Fuse 只做零命中兜底。
 *
 * 实测依据：14.6k 条下 4-key Fuse 单次检索 98–306ms，逐条子串扫描仅 8–14ms；
 * 因此常规关键词、链接、仓库全名都走扫描，只有「一个都没命中」时才构建 Fuse
 * 处理拼写错误。构建期倒排索引分片（artifacts.index）召回更窄（整词建索引、
 * 连字符仓库名算一个词），暂不接入。
 */

export interface SearchHit {
  /** 该条目在全量切片中的全局序号（同时也是明细分片定位依据）。 */
  index: number;
  item: LiteEntry;
  fuzzyScore: number;
}

export type Searcher = (query: string) => SearchHit[];

/**
 * 归一化检索词：把粘贴进来的链接、仓库全名压成若干短词。
 *
 * 入参 raw：输入框原文，可以是完整 URL、owner/repo、中文关键词。
 * 返回值：可直接交给 Fuse 的检索串；归一化后不足 2 字符时返回空串。
 *
 * 必须做这一步的原因：Fuse 的 bitap 耗时随词数叠加，直接拿 40 字符的链接检索
 * 实测 2 秒级；归一化成短词后既能走逐条扫描，也能在兜底时喂给 Fuse。
 */
export function normalizeQuery(raw: string): string {
  // 用户输入属于系统边界，非法入参直接返回空串，不让异常透传
  if (typeof raw !== "string") return "";

  let q = raw.trim().toLowerCase();
  if (!q) return "";

  // 只保留链接里的路径部分：https://www.github.com/owner/repo → owner/repo
  // 域名不限于 github，gitee.com、gitlab.com 这类粘贴同样按路径匹配
  q = q
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^[^/\s]+\.[a-z]{2,}\//, "");
  // 去掉 ?tab=readme、#readme 这类尾巴
  q = q.replace(/[?#].*$/, "");
  // 末尾斜杠要先去掉，否则 repo.git/ 会漏掉 .git 后缀
  q = q.replace(/\/+$/, "").replace(/\.git$/, "");
  // 分隔符统一成空格，连续空白折叠成一个
  q = q.replace(/[/_.\-]+/g, " ").replace(/\s+/g, " ").trim();

  // 极端长串会拖慢检索，超出部分直接截断
  if (q.length > 120) q = q.slice(0, 120).trim();
  return q.length >= 2 ? q : "";
}

/**
 * 判断输入是不是「链接 / owner/repo」形态。
 *
 * 这类输入是精确标识而不是关键词，交给 Fuse 会按词数线性叠加开销
 * （实测 6 个词 2.1 秒），必须走子串直搜。
 */
export function isRepoQuery(raw: string): boolean {
  // 用户输入属于系统边界，非法入参直接判否，不让异常透传
  if (typeof raw !== "string") return false;
  const q = raw.trim();
  if (!q) return false;
  return (
    /^[a-z]+:\/\//i.test(q) || // 带协议头的链接
    /^[^\s/]+\.[a-z]{2,}\//i.test(q) || // 省略协议的域名链接 github.com/owner/repo
    /^[^\s/]+\/[^\s/]+\/?$/.test(q) // 仓库全名 owner/repo（允许末尾多一个斜杠）
  );
}

/** 字段权重：仓库全名命中比简介里蹭到一词更该排前面。 */
const FIELD_WEIGHT = { id: 4, name: 3, tags: 2, desc: 1 } as const;

/** 单个词能拿到的最高权重（四个字段全中，再加整词命中的 1 分）。 */
const TOKEN_MAX_WEIGHT = FIELD_WEIGHT.id + FIELD_WEIGHT.name + FIELD_WEIGHT.tags + FIELD_WEIGHT.desc + 1;

/** 严格命中少于这个数时，用「只命中部分词」的条目补齐，避免窄查询只剩一两条。 */
const MIN_STRICT_HITS = 60;

/**
 * 相关度分层：层级数字直接作为分数，越小越靠前。
 *
 * 必须分层的原因：`dsh-market` 会被拆成 `dsh` + `market` 两个词，
 * 标签里恰好写了这两个词的 `dsh-plugin-market` 靠权重就能反超，
 * 把名称就叫 `dsh-market` 的条目挤到十几名之外。
 * 分层后同名条目整组置顶，组内由综合分决定先后。
 */
const TIER_ID_EXACT = -1;
/** 名称同名：条目名就叫查询词。 */
const TIER_NAME_EXACT = 0;
/** 仓库同名：id 与查询全等，或仓库尾段就是查询词。 */
const TIER_REPO_EXACT = 1;
/** 作者同名：owner 段就是查询词，搜作者 ID 时该作者的仓库优先露出。 */
const TIER_OWNER_EXACT = 2;
/** 名称含短语：只蹭到名字里的片段，排在作者同名之后。 */
const TIER_NAME_PHRASE = 3;
/** id 含短语：作者与仓库名都不完全相等。 */
const TIER_ID_PHRASE = 4;
/** 标签含短语：最容易蹭到，层级最低。 */
const TIER_TAG_PHRASE = 5;
const TIER_NONE = 99;
/** 没有短语级命中时退回字段权重打分，分数带排在所有分层之后。 */
const TIER_WEIGHT_BASE = 6;
/** 部分命中（补齐用）的分数带，永远排在严格命中之后。 */
const TIER_LOOSE_BASE = 8;

interface QueryContext {
  /** 去重后的查询词，避免 owner/repo 的斜杠把同一个词重复计权。 */
  tokens: string[];
  /** 查询词的紧凑形态（去掉分隔符），用于短语级比较。 */
  compact: string;
  /** 仓库全名查询的靶子 id；关键词查询为 null。 */
  repoId: string | null;
}

interface EntryScore {
  /** 命中的查询词数：等于词数即为严格命中。 */
  matched: number;
  /** 四字段权重累计，用于把结果压成 0–1 的分数。 */
  weight: number;
  /** 整词命中的词数（名称全等 / 仓库名尾段 / 标签全等）。 */
  exact: number;
}

/**
 * 紧凑形态：小写后去掉 `- _ . 空格 /` 等全部分隔符。
 *
 * 斜杠必须一起去掉：查询串归一化后已不含 `/`，若 id 这里保留斜杠，
 * `mattpocock/skills` 这类「owner 与 repo 连写即同名」的条目永远匹配不上，
 * 会被挤到字段权重分带里排在几十条克隆仓之后。
 */
function compactForm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}

/**
 * 取「仓库全名」查询的目标标识：链接剥掉协议、域名、查询串与 .git 后缀后的路径。
 *
 * 入参 raw：输入框原文。
 * 返回值：形如 owner/repo 的路径；不是两段式仓库标识时返回 null。
 */
function repoPathOf(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const path = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^[^/\s]+\.[a-z]{2,}\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return /^[^\s/]+\/[^\s/]+$/.test(path) ? path : null;
}

/** 判断空格分隔的串里是否存在整词，避免为每条目的标签额外建数组。 */
function hasWholeWord(joined: string, word: string): boolean {
  return (
    joined === word ||
    joined.startsWith(`${word} `) ||
    joined.endsWith(` ${word}`) ||
    joined.includes(` ${word} `)
  );
}

/**
 * 给单个条目打分：逐词检查仓库名、名称、标签、简介。
 *
 * 入参 entry 为一条浏览切片，tokens 为已归一化并过滤掉单字符的查询词。
 * 返回值只描述「命中几个词、权重多少」，换算成分数由调用方决定。
 */
function scoreEntry(entry: LiteEntry, tokens: string[]): EntryScore {
  // 每个条目只小写化一次，不能在每个词上重复拼接整串
  const id = entry.i.toLowerCase();
  const name = (entry.n ?? "").toLowerCase();
  const tags = (entry.tg ?? []).join(" ").toLowerCase();
  const desc = (entry.d ?? "").toLowerCase();

  let matched = 0;
  let weight = 0;
  let exact = 0;
  for (const token of tokens) {
    let hit = false;
    if (id.includes(token)) { weight += FIELD_WEIGHT.id; hit = true; }
    if (name.includes(token)) { weight += FIELD_WEIGHT.name; hit = true; }
    if (tags.includes(token)) { weight += FIELD_WEIGHT.tags; hit = true; }
    if (desc.includes(token)) { weight += FIELD_WEIGHT.desc; hit = true; }
    if (!hit) continue;
    matched += 1;
    // 整词可信度高于子串：名称就是这个词、仓库名尾段、标签项完全相等
    if (name === token || id.endsWith(`/${token}`) || hasWholeWord(tags, token)) exact += 1;
  }
  return { matched, weight, exact };
}

/**
 * 判断条目命中的相关度层级。
 *
 * 入参 entry 为一条浏览切片，ctx 已含去重查询词与紧凑形态。
 * 返回值：-1 仓库 id 完全相符、0 名称同名、1 仓库同名、2 作者同名、
 * 3–5 短语级命中、TIER_NONE 表示只能靠字段权重排序。
 */
function tierOf(entry: LiteEntry, ctx: QueryContext): number {
  const id = entry.i.toLowerCase();
  // 输入就是 owner/repo 时，id 完全相符的那条必须最先被看到
  if (ctx.repoId !== null && id === ctx.repoId) return TIER_ID_EXACT;

  const nameCompact = compactForm(entry.n ?? "");
  // 同名条目的不同写法（dsh-market / dsh_market / dshmarket）视为同一个名字
  if (nameCompact === ctx.compact) return TIER_NAME_EXACT;

  // 尾段与作者段必须从原始 id 切分：compactForm 会把斜杠一起去掉，
  // 直接在压缩串上找 "/" 得到的尾段会退化成整个 id
  const idCompact = compactForm(id);
  const slashAt = id.indexOf("/");
  const tail = slashAt === -1 ? idCompact : compactForm(id.slice(slashAt + 1));
  if (idCompact === ctx.compact || tail === ctx.compact) return TIER_REPO_EXACT;

  // 搜作者 ID 时该作者名下的仓库优先露出，不能输给名字里蹭到同一片段的克隆仓
  if (slashAt > 0 && compactForm(id.slice(0, slashAt)) === ctx.compact) return TIER_OWNER_EXACT;

  if (nameCompact.includes(ctx.compact)) return TIER_NAME_PHRASE;
  if (idCompact.includes(ctx.compact)) return TIER_ID_PHRASE;
  // 标签逐个比较，避免「dsh」「market」两个独立标签被拼成短语
  if ((entry.tg ?? []).some((tag) => compactForm(tag).includes(ctx.compact))) return TIER_TAG_PHRASE;
  return TIER_NONE;
}

export function createSearcher(lite: LiteEntry[]): Searcher {
  // Fuse 索引在建索引时最贵（实测 14.6k 条约 850ms），
  // 只有在「逐条扫描一个都没命中」时才需要它，所以继续懒构建。
  let fuse: Fuse<LiteEntry> | null = null;
  const getFuse = (): Fuse<LiteEntry> => {
    if (!fuse) {
      fuse = new Fuse(lite, {
        includeScore: true,
        ignoreLocation: true,
        minMatchCharLength: 2,
        threshold: 0.34,
        keys: [
          { name: "i", weight: 2.5 },
          { name: "n", weight: 2 },
          { name: "tg", weight: 1.2 },
          { name: "d", weight: 1 },
        ],
      });
    }
    return fuse;
  };

  /**
   * 一次遍历同时收集严格命中与部分命中。
   *
   * 分数区间约定（rankHits 只比大小，从小到大）：
   * - 短语级命中直接用层级当分数（-1 最优，0–5 依次靠后），层内按综合分排；
   * - 只有字段权重命中的严格命中落在 [6, 7)；
   * - 补齐用的部分命中落在 [8, 9)，永远排在严格命中之后。
   */
  const scan = (ctx: QueryContext): { strict: SearchHit[]; loose: SearchHit[] } => {
    const { tokens } = ctx;
    const strict: SearchHit[] = [];
    const loose: SearchHit[] = [];
    const maxWeight = tokens.length * TOKEN_MAX_WEIGHT;
    const partialMax = tokens.length * (TOKEN_MAX_WEIGHT - 1);
    for (const [index, entry] of lite.entries()) {
      const { matched, weight, exact } = scoreEntry(entry, tokens);
      if (!matched) continue;
      if (matched === tokens.length) {
        const tier = tierOf(entry, ctx);
        const fuzzyScore =
          tier === TIER_NONE ? TIER_WEIGHT_BASE + (1 - (weight + exact) / maxWeight) : tier;
        strict.push({ index, item: entry, fuzzyScore });
      } else {
        loose.push({ index, item: entry, fuzzyScore: TIER_LOOSE_BASE + (1 - weight / partialMax) });
      }
    }
    return { strict, loose };
  };

  return (query: string) => {
    const q = normalizeQuery(query);
    if (!q) return [];
    // owner/repo 被斜杠切成重复词，先去重再计权，避免同一个词被算两遍
    const tokens = [...new Set(q.split(" ").filter((tok) => tok.length >= 2))];
    if (!tokens.length) return [];
    const repoQuery = isRepoQuery(query);
    const ctx: QueryContext = {
      tokens,
      compact: tokens.join(""),
      repoId: repoQuery ? repoPathOf(query) : null,
    };
    const { strict, loose } = scan(ctx);

    // 链接/仓库全名是精确标识：只认严格命中，不补齐、不猜拼写错的仓库名
    if (repoQuery) return strict;
    // 一个都没命中时才动用 Fuse，保住拼错仍有结果的兜底能力
    if (!strict.length && !loose.length) {
      return getFuse().search(q).map((r) => ({ index: r.refIndex, item: r.item, fuzzyScore: r.score ?? 1 }));
    }
    if (strict.length >= MIN_STRICT_HITS) return strict;
    // 窄查询补齐：部分命中按权重取前几条，接在严格命中之后
    loose.sort((a, b) => a.fuzzyScore - b.fuzzyScore);
    return strict.concat(loose.slice(0, MIN_STRICT_HITS - strict.length));
  };
}

/** 排序：模糊分优先，其次综合分。 */
export function rankHits(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort((a, b) => a.fuzzyScore - b.fuzzyScore || b.item.sc - a.item.sc);
}

/** 列表排序口径（全部基于用户可见信息，不再有安装验证这类隐藏维度）。 */
export type SortKey = "score" | "stars" | "recent";

export function sortItems(items: SearchHit[], key: SortKey): SearchHit[] {
  if (key === "score") return [...items].sort((a, b) => b.item.sc - a.item.sc || b.item.s - a.item.s);
  if (key === "stars") return [...items].sort((a, b) => b.item.s - a.item.s || b.item.sc - a.item.sc);
  return [...items].sort((a, b) => (b.item.p ?? "").localeCompare(a.item.p ?? "") || b.item.sc - a.item.sc);
}
