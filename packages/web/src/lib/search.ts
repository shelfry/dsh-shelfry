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

export function createSearcher(lite: LiteEntry[]): Searcher {
  const fuse = new Fuse(lite, {
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

  return (query: string) => {
    const q = query.trim();
    if (!q) return [];
    return fuse.search(q).map((r) => ({
      index: r.refIndex,
      item: r.item,
      fuzzyScore: r.score ?? 1,
    }));
  };
}

/** 排序：已验证优先 → 综合分 → 模糊分。搜索命中时模糊分参与排序。 */
export function rankHits(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort((a, b) => {
    const va = a.item.v;
    const vb = b.item.v;
    // 只显示前两档的默认口径下，failed 排最后。
    if (va !== vb) return va === 2 ? 1 : vb === 2 ? -1 : va - vb;
    if (b.item.sc !== a.item.sc) return b.item.sc - a.item.sc;
    return a.fuzzyScore - b.fuzzyScore;
  });
}
