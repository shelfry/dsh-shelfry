import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogMeta } from "@dsh-shelfry/schema";

import { pickCategories, type CatalogBootstrap } from "./bootstrap.ts";

/** 只为类型完整性构造最小 meta，用例只关心分类清单的挑选逻辑。 */
const meta = { schemaVersion: 1, generatedAt: "2026-10-29T00:00:00Z", total: 26040, types: {}, sources: [] } as CatalogMeta;

/** 两个范围各给一份可区分的分类，用来验证不会串用。 */
const data: CatalogBootstrap = {
  meta,
  categories: [{ t: "效率提升", n: 5558 }],
  categoriesTools: [{ t: "命令行", n: 12 }],
};

test("pickCategories：没有内联数据时返回 null，让调用方退回运行时 fetch", () => {
  assert.equal(pickCategories(null, "plugins"), null);
  assert.equal(pickCategories(null, "tools"), null);
});

test("pickCategories：按范围取对应清单，插件与工具不能串用", () => {
  assert.equal(pickCategories(data, "plugins"), data.categories);
  assert.equal(pickCategories(data, "tools"), data.categoriesTools);
});

test("pickCategories：空清单原样返回，不能被当成缺失数据", () => {
  const empty: CatalogBootstrap = { meta, categories: [], categoriesTools: [] };
  assert.deepEqual(pickCategories(empty, "plugins"), []);
  assert.notEqual(pickCategories(empty, "plugins"), null);
  assert.notEqual(pickCategories(empty, "tools"), null);
});
