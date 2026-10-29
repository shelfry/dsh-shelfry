import type { CatalogMeta } from "@dsh-shelfry/schema";
import type { CatalogScope, Category } from "./data";

/**
 * 首屏筛选数据的内联结构。
 *
 * data.ts 依赖 Vite 的 import.meta.env 与构建期常量，无法在 Node 单测里直接加载，
 * 所以把纯逻辑单独放在这里：既便于测试，也避免测试环境引入浏览器依赖。
 */
export interface CatalogBootstrap {
  meta: CatalogMeta;
  categories: Category[];
  categoriesTools: Category[];
}

/**
 * 从内联数据里挑出当前范围的分类清单。
 *
 * 入参 data：内联数据，可能为 null；scope：浏览范围。
 * 返回：对应范围的分类数组；没有内联数据时返回 null（调用方退回运行时 fetch）。
 */
export function pickCategories(data: CatalogBootstrap | null, scope: CatalogScope): Category[] | null {
  if (!data) return null;
  return scope === "tools" ? data.categoriesTools : data.categories;
}
