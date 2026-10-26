import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginEntry } from "@dsh-shelfry/schema";

import { classifyReadmeBody, isPresenceFresh, isPurgeCandidate, readmeStateFrom } from "./readme-gate.ts";

/** 只填判定用到的字段，其余留空：清退条件与简介、分数、标签都无关。 */
const entry = (patch: Record<string, unknown> = {}): PluginEntry =>
  ({
    id: "owner/repo",
    ecosystem: "dsh",
    stars: 0,
    curated: false,
    sources: ["mirror"],
    install: { command: null },
    ...patch,
  }) as unknown as PluginEntry;

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

test("classifyReadmeBody：成段正文判为 body", () => {
  assert.equal(classifyReadmeBody("A plugin that syncs your notes between devices."), "body");
  assert.equal(classifyReadmeBody("这是一个用于同步笔记的插件，支持增量更新与冲突合并。"), "body");
  assert.equal(classifyReadmeBody("> 引用一段说明文字，长度足够构成可读正文。"), "body");
});

test("classifyReadmeBody：标题、纯链接、徽章、代码块、空文件判为 blank", () => {
  assert.equal(classifyReadmeBody("# dsh-demo"), "blank");
  assert.equal(classifyReadmeBody("[![npm](https://img.example/b.svg)](https://npm.example/x)"), "blank");
  assert.equal(classifyReadmeBody("[点我查看](https://example.com)"), "blank");
  assert.equal(classifyReadmeBody("```\nnpm install\n```"), "blank");
  assert.equal(classifyReadmeBody(""), "blank");
  assert.equal(classifyReadmeBody("Short."), "blank");
});

test("readmeStateFrom：404 才算缺失，5xx 与 429 一律不可判定", () => {
  assert.equal(readmeStateFrom(404, null), "missing");
  assert.equal(readmeStateFrom(200, "A long enough description line for the plugin."), "body");
  assert.equal(readmeStateFrom(200, ""), "blank");
  assert.equal(readmeStateFrom(500, null), "unknown");
  assert.equal(readmeStateFrom(429, null), "unknown");
  assert.equal(readmeStateFrom(403, null), "unknown");
});

test("isPurgeCandidate：只有 0 星 DSH 插件且非人工收录才命中", () => {
  assert.equal(isPurgeCandidate(entry()), true);
  assert.equal(isPurgeCandidate(entry({ stars: 1 })), false);
  assert.equal(isPurgeCandidate(entry({ ecosystem: "external" })), false);
  assert.equal(isPurgeCandidate(entry({ curated: true })), false);
  assert.equal(isPurgeCandidate(entry({ sources: ["mirror", "issue-submission"] })), false);
  assert.equal(isPurgeCandidate(entry({ sources: ["curation"] })), false);
});

test("isPurgeCandidate：README 空优先，带安装命令也不豁免", () => {
  assert.equal(isPurgeCandidate(entry({ install: { command: "dsh plugin --profile web add x" } })), true);
});

test("isPresenceFresh：到期或仓库有新提交都要重探", () => {
  const row = { v: "missing" as const, t: daysAgo(0), p: "2026-01-01T00:00:00Z" };
  assert.equal(isPresenceFresh(row, "2026-01-01T00:00:00Z"), true);
  assert.equal(isPresenceFresh(row, "2026-02-01T00:00:00Z"), false);
  assert.equal(isPresenceFresh({ ...row, t: daysAgo(31) }, "2026-01-01T00:00:00Z"), false);
  assert.equal(isPresenceFresh({ ...row, t: daysAgo(29) }, "2026-01-01T00:00:00Z"), true);
});
