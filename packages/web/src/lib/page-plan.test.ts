import assert from "node:assert/strict";
import { test } from "node:test";

import { pagePlan } from "./page-plan.ts";

/** 三页的分页表：索引 0/1 在第一页，60/119 在第二页，120 在第三页。 */
const idmap: Record<string, number> = {
  "a/one": 0,
  "a/two": 1,
  "b/mid": 60,
  "b/last": 119,
  "c/third": 120,
};

test("pagePlan：同页 id 聚在一个分片，跨页的分散到各自分片", () => {
  const plan = pagePlan(idmap, ["a/one", "b/mid", "a/two", "c/third"], 60);
  assert.deepEqual([...plan.pages.entries()], [
    [0, [0, 1]],
    [1, [60]],
    [2, [120]],
  ]);
  assert.deepEqual(plan.missing, []);
});

test("pagePlan：产物里查不到的 id 进 missing，保持传入顺序且不影响其它 id", () => {
  const plan = pagePlan(idmap, ["gone/x", "a/one", "gone/y"], 60);
  assert.deepEqual(plan.missing, ["gone/x", "gone/y"]);
  assert.deepEqual([...plan.pages.entries()], [[0, [0]]]);
});

test("pagePlan：重复 id 只取一次，避免同一分片内重复写入", () => {
  const plan = pagePlan(idmap, ["a/one", "a/one", "a/one"], 60);
  assert.deepEqual([...plan.pages.entries()], [[0, [0]]]);
  assert.deepEqual(plan.missing, []);
});

test("pagePlan：空收藏返回空计划", () => {
  const plan = pagePlan(idmap, [], 60);
  assert.equal(plan.pages.size, 0);
  assert.deepEqual(plan.missing, []);
});
