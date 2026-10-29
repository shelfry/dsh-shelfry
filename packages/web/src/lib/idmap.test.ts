import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEntryId } from "./idmap.ts";

/** 数据里的键保留 GitHub 原始大小写，用真实形态做样本。 */
const map: Record<string, number> = {
  "MemTensor/MemOS": 3,
  "Aisland-SJL/dsh-worktable": 80,
  "mattpocock/skills": 12,
};

test("resolveEntryId：精确命中直接返回原键", () => {
  assert.equal(resolveEntryId(map, "MemTensor/MemOS"), "MemTensor/MemOS");
  assert.equal(resolveEntryId(map, "mattpocock/skills"), "mattpocock/skills");
});

test("resolveEntryId：大小写变体命中，并返回原始大小写（不做改写）", () => {
  assert.equal(resolveEntryId(map, "memtensor/memos"), "MemTensor/MemOS");
  // 只差首字母也要能命中
  assert.equal(resolveEntryId(map, "aisland-SJL/dsh-worktable"), "Aisland-SJL/dsh-worktable");
  assert.equal(resolveEntryId(map, "aisland-sjl/Dsh-Worktable"), "Aisland-SJL/dsh-worktable");
});

test("resolveEntryId：空串、未收录、同前缀不同仓库都不命中", () => {
  assert.equal(resolveEntryId(map, ""), null);
  assert.equal(resolveEntryId(map, "memtensor/memos2"), null);
  assert.equal(resolveEntryId(map, "someone/else"), null);
});
