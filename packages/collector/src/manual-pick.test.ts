import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginEntry } from "@dsh-shelfry/schema";

import { isManualPick } from "./manual-pick.ts";

/** 只填判定用到的字段，其余留空。 */
const entry = (patch: Partial<PluginEntry> = {}): Pick<PluginEntry, "curated" | "sources"> => ({
  curated: false,
  sources: ["mirror"],
  ...patch,
});

test("isManualPick：站内收录队列算点名收录", () => {
  assert.equal(isManualPick(entry({ sources: ["curation"] })), true);
});

test("isManualPick：清理归档（curated）算点名收录", () => {
  assert.equal(isManualPick(entry({ curated: true, sources: ["mirror"] })), true);
});

test("isManualPick：Issue 主动提交算点名收录", () => {
  assert.equal(isManualPick(entry({ sources: ["mirror", "issue-submission"] })), true);
});

test("isManualPick：普通检索到的条目不算点名收录", () => {
  assert.equal(isManualPick(entry({ sources: ["mirror", "catalog"] })), false);
  // sources 缺失也不能误判
  assert.equal(isManualPick({ curated: false } as Pick<PluginEntry, "curated" | "sources">), false);
});
