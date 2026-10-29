import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiteEntry } from "@dsh-shelfry/schema";

import { AUTHOR_TAKE, SIMILAR_TAKE, buildRelated } from "./related.ts";

/** 构造最小浏览切片：用例只关心 id / 标签 / 星数 / 类型 / 范围。 */
function row(id: string, tags: string[], opts: { stars?: number; type?: string; external?: boolean } = {}): LiteEntry {
  return {
    i: id,
    n: id.split("/")[1],
    t: opts.type ?? "plugin",
    s: opts.stars ?? 0,
    tg: tags,
    ...(opts.external ? { ec: "external" as const } : {}),
  } as LiteEntry;
}

test("buildRelated：候选标签重复出现时按次数重复计分（与旧前端 filter 口径一致）", () => {
  const lite = [
    row("me/owner", ["a", "b"]),
    // 重复标签：shared 实际计数 3 → 9 分
    row("x/dup", ["a", "a", "b"], { stars: 0 }),
    // 去重后的计数 2 → 6 分，星数更高也不能反超
    row("y/unique", ["a", "b"], { stars: 999 }),
  ];
  const out = buildRelated(lite).get("me/owner")!;
  assert.deepEqual(out.s, ["x/dup", "y/unique"]);
});

test("buildRelated：同权重按星数降序，权重与星数都相同按切片原序", () => {
  const lite = [
    row("me/owner", ["a"]),
    row("x/low", ["a", "b"], { stars: 1 }),
    row("y/high", ["a", "b"], { stars: 9 }),
    row("z/tie1", ["a", "b"], { stars: 5 }),
    row("w/tie2", ["a", "b"], { stars: 5 }),
  ];
  const out = buildRelated(lite).get("me/owner")!;
  assert.deepEqual(out.s, ["y/high", "z/tie1", "w/tie2", "x/low"]);
});

test("buildRelated：类型相同只加 1 分，仅类型相同（权重 1）不入选", () => {
  const lite = [
    row("me/owner", ["a"]),
    row("x/same", ["a"], { type: "plugin" }),
    row("y/other", ["a"], { type: "skill" }),
    row("z/typeonly", ["b"], { type: "plugin" }),
  ];
  const out = buildRelated(lite).get("me/owner")!;
  assert.deepEqual(out.s, ["x/same", "y/other"]);
});

test("buildRelated：通用标签不计入相似度", () => {
  const lite = [
    row("me/owner", ["dsh-plugin", "plugins"]),
    row("x/noise", ["dsh-plugin", "dsh"]),
  ];
  const out = buildRelated(lite).get("me/owner")!;
  assert.deepEqual(out.s, []);
});

test("buildRelated：同作者排除自己、owner 大小写归一、按星数取前 AUTHOR_TAKE", () => {
  const lite = [
    row("Me/self", [], { stars: 100 }),
    row("me/a", [], { stars: 1 }),
    row("me/b", [], { stars: 5 }),
    row("me/c", [], { stars: 3 }),
    row("me/d", [], { stars: 4 }),
    row("me/e", [], { stars: 2 }),
    row("other/f", [], { stars: 99 }),
  ];
  const out = buildRelated(lite).get("Me/self")!;
  assert.equal(out.a.length, AUTHOR_TAKE);
  assert.deepEqual(out.a, ["me/b", "me/d", "me/c", "me/e"]);
});

test("buildRelated：推荐不跨范围，且相似最多 SIMILAR_TAKE 条", () => {
  const lite = [
    row("me/owner", ["a"]),
    row("ext/tool", ["a"], { external: true }),
    ...["p1", "p2", "p3", "p4", "p5"].map((name) => row(`x/${name}`, ["a"])),
  ];
  const out = buildRelated(lite).get("me/owner")!;
  assert.equal(out.s.length, SIMILAR_TAKE);
  assert.ok(!out.s.includes("ext/tool"));
});
