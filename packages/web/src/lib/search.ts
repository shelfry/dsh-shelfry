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

interface EntryScore {
  /** 命中的查询词数：等于词数即为严格命中。 */
  matched: number;
  /** 四字段权重累计，用于把结果压成 0–1 的分数。 */
  weight: number;
  /** 整词命中的词数（名称全等 / 仓库名尾段 / 标签全等）。 */
  exact: number;
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
   * 一次遍历同时收集严格命中与部分命中，用字段权重代替模糊编辑距离。
   *
   * 分数区间约定（rankHits 只比大小）：
   * - 严格命中落在 [0, 1]，权重越高越接近 0；
   * - 补齐用的部分命中落在 (1, 2]，永远排在严格命中之后。
   */
  const scan = (tokens: string[]): { strict: SearchHit[]; loose: SearchHit[] } => {
    const strict: SearchHit[] = [];
    const loose: SearchHit[] = [];
    const maxWeight = tokens.length * TOKEN_MAX_WEIGHT;
    for (const [index, entry] of lite.entries()) {
      const { matched, weight, exact } = scoreEntry(entry, tokens);
      if (!matched) continue;
      if (matched === tokens.length) {
        strict.push({ index, item: entry, fuzzyScore: 1 - (weight + exact) / maxWeight });
      } else {
        const partialMax = tokens.length * (TOKEN_MAX_WEIGHT - 1);
        loose.push({ index, item: entry, fuzzyScore: 1 + (1 - weight / partialMax) });
      }
    }
    return { strict, loose };
  };

  return (query: string) => {
    const q = normalizeQuery(query);
    if (!q) return [];
    const tokens = q.split(" ").filter((tok) => tok.length >= 2);
    if (!tokens.length) return [];
    const { strict, loose } = scan(tokens);

    // 链接/仓库全名是精确标识：只认严格命中，不补齐、不猜拼写错的仓库名
    if (isRepoQuery(query)) return strict;
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
