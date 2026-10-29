/**
 * 收藏页取数计划：把收藏 id 映射到分页文件。
 *
 * 单独成文件是为了能被 Node 单测直接加载 —— data.ts 依赖 import.meta.env，
 * 在 node --test 里跑不起来。这里只放纯逻辑，不碰网络与浏览器 API。
 */

/** 分页取数计划：哪些 id 落在第几页、哪些 id 已不在产物里。 */
export interface PagePlan {
  /** 分页序号 → 该页命中的全局序号 */
  pages: Map<number, number[]>;
  /** 产物里查不到的 id（已下架或被移除），保持传入顺序 */
  missing: string[];
}

/**
 * 把收藏 id 按分页分组，保证同一个分片只请求一次。
 *
 * 入参 idmap：id → 全局序号；ids：收藏 id 列表（可能重复）；pageSize：每页条数。
 * 出参 pages 按分页号聚合全局序号，missing 记录查不到的 id；重复 id 只算一次。
 */
export function pagePlan(idmap: Record<string, number>, ids: string[], pageSize: number): PagePlan {
  const pages = new Map<number, number[]>();
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const index = idmap[id];
    if (index === undefined) {
      missing.push(id);
      continue;
    }
    const page = Math.floor(index / pageSize);
    const bucket = pages.get(page);
    if (bucket) bucket.push(index);
    else pages.set(page, [index]);
  }
  return { pages, missing };
}

/**
 * 已知全局序号时按分页分组，保证同一个分片只请求一次。
 *
 * 与 pagePlan 的区别：这里省掉 idmap 反查（序号已随推荐产物一起下发）。
 * 非法序号（负数、非整数、重复）直接忽略，避免构造出越界分片请求。
 */
export function indexPagePlan(indexes: number[], pageSize: number): Map<number, number[]> {
  const pages = new Map<number, number[]>();
  const seen = new Set<number>();
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || seen.has(index)) continue;
    seen.add(index);
    const page = Math.floor(index / pageSize);
    const bucket = pages.get(page);
    if (bucket) bucket.push(index);
    else pages.set(page, [index]);
  }
  return pages;
}
