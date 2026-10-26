import assert from "node:assert/strict";
import { test } from "node:test";

import type { RawRecord } from "../normalize.ts";
import { mergeCatalog, parseCatalogIndex, parseGithubRepo } from "./catalog.ts";

/** 目录原始 JSON 的最小形状：只填判定用到的字段。 */
const index = (plugins: unknown[], categories: unknown = { ui: { zh: "UI 增强", en: "UI" } }) => ({
  name: "awesome-dsh-plugin",
  count: plugins.length,
  categories,
  plugins,
});

const plugin = (patch: Record<string, unknown> = {}) => ({
  name: "demo",
  url: "https://github.com/acme/dsh-demo",
  category: "ui",
  description: { zh: "一个用于演示的插件，支持增量同步。", en: "demo" },
  install: "dsh plugin --profile web add @acme/dsh-demo",
  ...patch,
});

/** GitHub 详情的最小形状：目录合并只读 id / tags / sources / install。 */
const gh = (patch: Record<string, unknown> = {}): RawRecord =>
  ({ id: "acme/dsh-demo", tags: [], sources: ["github-search"], ...patch }) as RawRecord;

test("parseGithubRepo：兼容 https、ssh、.git 后缀与尾斜杠", () => {
  assert.equal(parseGithubRepo("https://github.com/acme/dsh-demo"), "acme/dsh-demo");
  assert.equal(parseGithubRepo("https://github.com/acme/dsh-demo.git"), "acme/dsh-demo");
  assert.equal(parseGithubRepo("https://github.com/acme/dsh-demo/"), "acme/dsh-demo");
  assert.equal(parseGithubRepo("git@github.com:acme/dsh-demo.git"), "acme/dsh-demo");
  assert.equal(parseGithubRepo("https://github.com/acme/dsh-demo/tree/main/docs"), "acme/dsh-demo");
});

test("parseGithubRepo：非 GitHub 与非法入参返回 null", () => {
  assert.equal(parseGithubRepo("https://gitlab.com/acme/dsh-demo"), null);
  assert.equal(parseGithubRepo("https://github.com/acme"), null);
  assert.equal(parseGithubRepo(""), null);
  assert.equal(parseGithubRepo(null), null);
  assert.equal(parseGithubRepo(123), null);
});

test("parseCatalogIndex：同仓库多 npm 包只留第一条，缺字段的跳过", () => {
  const parsed = parseCatalogIndex(
    index([
      plugin(),
      plugin({ install: "dsh plugin --profile web add @acme/dsh-demo-extra" }),
      plugin({ url: "https://example.com/acme/dsh-other" }),
      plugin({ install: null }),
    ]),
  );
  assert.equal(parsed.total, 4);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.skipped, 2);
  assert.equal(parsed.items[0]?.command, "dsh plugin --profile web add @acme/dsh-demo");
});

test("parseCatalogIndex：中文简介、分类名与 tarball 引号处理", () => {
  const parsed = parseCatalogIndex(
    index([
      plugin({ install: 'dsh plugin --profile web add "https://github.com/acme/dsh-demo/releases/download/v1/demo.tgz"' }),
      plugin({ url: "https://github.com/acme/dsh-unknown-category", category: "no-such-key" }),
    ]),
  );
  assert.equal(parsed.items[0]?.descriptionZh, "一个用于演示的插件，支持增量同步。");
  assert.equal(parsed.items[0]?.categoryTag, "UI 增强");
  assert.match(parsed.items[0]?.command ?? "", /add https:\/\/github\.com\/acme\/dsh-demo/);
  assert.equal(parsed.items[1]?.categoryTag, null);
});

test("parseCatalogIndex：结构异常时返回空索引，不抛错", () => {
  assert.equal(parseCatalogIndex(null).items.length, 0);
  assert.equal(parseCatalogIndex({ plugins: "bad" }).items.length, 0);
  assert.equal(parseCatalogIndex(index(["bad-row"])).items.length, 0);
});

test("mergeCatalog：topics 非空时保留 topics，不写分类名", () => {
  const items = parseCatalogIndex(index([plugin()])).items;
  const [record] = mergeCatalog([gh({ tags: ["dsh", "notes"] })], items);
  assert.deepEqual(record?.tags, ["dsh", "notes"]);
  assert.equal(record?.descriptionZh, "一个用于演示的插件，支持增量同步。");
  assert.ok(Array.isArray(record?.sources) && record.sources.includes("awesome-catalog"));
});

test("mergeCatalog：topics 为空时用分类中文名兜底，未知分类不加标签", () => {
  const items = parseCatalogIndex(index([plugin(), plugin({ url: "https://github.com/acme/dsh-x", category: "no-such-key" })])).items;
  const [a, b] = mergeCatalog([gh(), gh({ id: "acme/dsh-x" })], items);
  assert.deepEqual(a?.tags, ["UI 增强"]);
  assert.deepEqual(b?.tags, []);
});

test("mergeCatalog：GitHub 没取回的仓库（已删除）一律不进站", () => {
  const items = parseCatalogIndex(index([plugin()])).items;
  assert.equal(mergeCatalog([], items).length, 0);
  assert.equal(mergeCatalog([gh({ id: "other/repo" })], items).length, 0);
});
