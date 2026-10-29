import type { LiteEntry } from "@dsh-shelfry/schema";

/**
 * 榜单切片：把「排序 + 取前 N」这段纯逻辑单独放，方便单测。
 *
 * 榜单页原先在前端拿全量切片自己排；现在改为构建期排好写成 top.json，
 * 页面只需拉几十 KB。排序规则必须与旧实现逐字一致，否则榜单顺序会变。
 */

/** 榜单每个页签取前多少条，与榜单页展示的 TOP_N 保持一致。 */
export const TOP_N = 50;

/** 榜单三个页签的完整切片，字段与 LiteEntry 一致，前端可直接渲染卡片。 */
export interface TopLists {
  stars: LiteEntry[];
  recent: LiteEntry[];
  score: LiteEntry[];
}

/**
 * 生成榜单三个页签。
 *
 * 入参 lite：全量浏览切片（已按综合分排序）。
 * 出参：星标（星数降序、同星按综合分）、最近（推送时间降序、同时间按星数）、
 *       精选（综合分降序、同分按星数），各取前 TOP_N 条。
 * 只取 DSH 插件：独立工具混进「插件榜」会让榜单语义变味。
 */
export function pickTop(lite: LiteEntry[]): TopLists {
  const plugins = lite.filter((v) => v.ec !== "external");
  const stars = [...plugins].sort((a, b) => b.s - a.s || b.sc - a.sc).slice(0, TOP_N);
  const recent = [...plugins]
    .sort((a, b) => (b.p ?? "").localeCompare(a.p ?? "") || b.s - a.s)
    .slice(0, TOP_N);
  const score = [...plugins].sort((a, b) => b.sc - a.sc || b.s - a.s).slice(0, TOP_N);
  return { stars, recent, score };
}
