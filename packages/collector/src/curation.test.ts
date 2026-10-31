import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRepoList } from "./curation.ts";

test("parseRepoList：纯数组写法，规范化并去重", () => {
  assert.deepEqual(parseRepoList(["Owner/Repo", "owner/repo", "c/d"]), ["owner/repo", "c/d"]);
});

test("parseRepoList：兼容 { repos: [...] } 写法", () => {
  assert.deepEqual(parseRepoList({ repos: ["a/b"] }), ["a/b"]);
});

test("parseRepoList：过滤非字符串与非法仓库名", () => {
  assert.deepEqual(parseRepoList(["a/b", 42, null, undefined, { x: 1 }, "", "no-slash", "a/b.git"]), ["a/b"]);
});

test("parseRepoList：结构不合法时返回空数组，不抛错", () => {
  for (const bad of [null, undefined, "a/b", 42, true, {}, { repos: "a/b" }, { repos: [1, 2] }]) {
    assert.deepEqual(parseRepoList(bad), []);
  }
});

test("parseRepoList：空名单返回空数组", () => {
  assert.deepEqual(parseRepoList([]), []);
  assert.deepEqual(parseRepoList({ repos: [] }), []);
});
