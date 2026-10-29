import assert from "node:assert/strict";
import { test } from "node:test";

import { dataUrl } from "./data-url.ts";

test("dataUrl：没有版本时不带查询参数", () => {
  assert.equal(dataUrl("/", "pages/0000.json", ""), "/data/pages/0000.json");
});

test("dataUrl：带版本时版本串正确转义", () => {
  assert.equal(
    dataUrl("/", "idmap.json", "2026-10-29T14:00:22.355Z"),
    "/data/idmap.json?v=2026-10-29T14%3A00%3A22.355Z",
  );
});

test("dataUrl：非根 base 也能拼对路径", () => {
  assert.equal(dataUrl("/mirror/", "top.json", "v1"), "/mirror/data/top.json?v=v1");
});
