import type { LiteEntry } from "@dsh-shelfry/schema";
import Fuse from "fuse.js";

/**
 * 客户端检索：Fuse.js over 浏览切片。
 *
 * 实测依据（M0-spike3）：全量切片 brotli 仅 ~0.46MB（13k 条），
 * 客户端模糊检索完全扛得住，因此 MVP 直接用 Fuse，不引入查询时的索引分片往返。
 * 构建期已产出倒排索引分片（artifacts.index），留给后续「输入即出结果」的即时检索路径。
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
 * 实测 2 秒级；链接类输入改走直搜（见 isRepoQuery），关键词才交给 Fuse。
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

export function createSearcher(lite: LiteEntry[]): Searcher {
  // Fuse 索引在浏览器里要几百毫秒，只有关键词检索才用得到；
  // 链接直搜不该为它买单，所以第一次真正需要模糊检索时再建。
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
   * 直搜：把归一化后的每个词都要求出现在条目的仓库名/名称/标签/简介里。
   * 一次线性遍历，成本与词数无关（实测 6 词约 8ms），不需要预建索引占内存。
   */
  const directSearch = (raw: string): SearchHit[] => {
    const tokens = normalizeQuery(raw).split(" ").filter((tok) => tok.length >= 2);
    if (!tokens.length) return [];
    const hits: SearchHit[] = [];
    for (const [index, entry] of lite.entries()) {
      const hay = `${entry.i} ${entry.n ?? ""} ${(entry.tg ?? []).join(" ")} ${entry.d ?? ""}`.toLowerCase();
      if (tokens.every((tok) => hay.includes(tok))) hits.push({ index, item: entry, fuzzyScore: 0 });
    }
    return hits;
  };

  return (query: string) => {
    const q = normalizeQuery(query);
    if (!q) return [];
    // 链接/仓库全名走直搜，其余关键词仍用 Fuse 保留拼写容错
    if (isRepoQuery(query)) return directSearch(query);
    return getFuse().search(q).map((r) => ({
      index: r.refIndex,
      item: r.item,
      fuzzyScore: r.score ?? 1,
    }));
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
