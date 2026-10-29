import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiteEntry } from "@dsh-shelfry/schema";
import { AUTHOR_TAKE, SIMILAR_TAKE, buildRelated } from "./related.ts";

/** 造一条最小切片：只填推荐算法用到的字段，其余必填项用断言补齐。 */
const makeEntry = (i: string, tg: string[], extra: Partial<LiteEntry> = {}): LiteEntry =>
  ({ i, n: i.split("/")[1]!, t: "cordis-plugin", s: 0, tg, ...extra }) as LiteEntry;

describe("buildRelated", () => {
  it("同作者推荐按星数降序，且 ai 与 a 一一对应", () => {
    const lite = [makeEntry("alice/main", ["a"], { s: 10 }), makeEntry("alice/low", ["a"], { s: 2 }), makeEntry("alice/high", ["a"], { s: 30 })];
    const out = buildRelated(lite).get("alice/main")!;
    assert.deepEqual(out.a, ["alice/high", "alice/low"]);
    assert.deepEqual(out.ai, [2, 1]);
    // 上限生效：只有 2 个同作者，也允许少于 AUTHOR_TAKE
    assert.ok(out.a.length <= AUTHOR_TAKE);
    for (let k = 0; k < out.a.length; k += 1) assert.equal(lite[out.ai[k]!]!.i, out.a[k]);
  });

  it("没有共享标签的候选不入选", () => {
    const lite = [makeEntry("x/one", ["solo"]), makeEntry("y/two", ["other"])];
    const out = buildRelated(lite).get("x/one")!;
    assert.deepEqual(out.s, []);
    assert.deepEqual(out.si, []);
  });

  it("相似推荐按权重降序，且 si 与 s 一一对应", () => {
    const lite = [
      makeEntry("a/target", ["t1", "t2"]),
      makeEntry("m/low", ["t1"]),
      makeEntry("m/high", ["t1", "t2"]),
    ];
    const out = buildRelated(lite).get("a/target")!;
    assert.deepEqual(out.s, ["m/high", "m/low"]);
    assert.deepEqual(out.si, [2, 1]);
    for (let k = 0; k < out.s.length; k += 1) assert.equal(lite[out.si[k]!]!.i, out.s[k]);
  });

  it("推荐条数不超过上限", () => {
    const lite = [makeEntry("a/target", ["t1"]), ...Array.from({ length: 10 }, (_, k) => makeEntry(`m/c${k}`, ["t1"]))];
    const out = buildRelated(lite).get("a/target")!;
    assert.equal(out.s.length, SIMILAR_TAKE);
    assert.equal(out.si.length, SIMILAR_TAKE);
  });
});
