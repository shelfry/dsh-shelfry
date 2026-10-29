import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiteEntry } from "@dsh-shelfry/schema";

import { TOP_N, pickTop } from "./top.ts";

/** 构造最小浏览切片：用例只关心三个页签的排序与过滤，其余字段给默认值。 */
function row(id: string, stars: number, score: number, pushed: string | undefined, external = false): LiteEntry {
  return {
    i: id,
    n: id.split("/")[1],
    s: stars,
    sc: score,
    p: pushed,
    ...(external ? { ec: "external" as const } : {}),
  } as LiteEntry;
}

test("pickTop：星标页按星数降序，同星按综合分，且不超过 TOP_N", () => {
  const rows = [
    row("a/low", 10, 80, "2026-10-01"),
    row("a/high", 90, 50, "2026-10-01"),
    row("a/tie", 90, 70, "2026-10-01"),
  ];
  const top = pickTop(rows);
  assert.deepEqual(top.stars.map((v) => v.i), ["a/tie", "a/high", "a/low"]);
  assert.ok(top.stars.length <= TOP_N);
});

test("pickTop：最近页按推送时间降序，同时间按星数", () => {
  const rows = [
    row("a/old", 500, 10, "2026-01-01"),
    row("a/new", 10, 10, "2026-10-20"),
    row("a/newsame", 99, 10, "2026-10-20"),
  ];
  const top = pickTop(rows);
  assert.deepEqual(top.recent.map((v) => v.i), ["a/newsame", "a/new", "a/old"]);
});

test("pickTop：精选页只看综合分，独立工具不参与排名", () => {
  const rows = [
    row("a/tool", 999, 999, "2026-10-20", true),
    row("a/first", 1, 70, "2026-10-20"),
    row("a/second", 2, 60, "2026-10-20"),
  ];
  const top = pickTop(rows);
  assert.deepEqual(top.score.map((v) => v.i), ["a/first", "a/second"]);
  assert.ok(!top.stars.some((v) => v.i === "a/tool"));
  assert.ok(!top.recent.some((v) => v.i === "a/tool"));
});
