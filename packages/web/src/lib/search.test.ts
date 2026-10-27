import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiteEntry } from "@dsh-shelfry/schema";

import { createSearcher, isRepoQuery, normalizeQuery, rankHits } from "./search.ts";

/** 统一断言入口：便于在失败信息里直接看到原始输入。 */
const expectQuery = (raw: string, want: string) => {
  assert.equal(normalizeQuery(raw), want);
};

/** 构造直搜用例的最小条目，只填影响检索的字段。 */
const entry = (id: string, name: string, tags: string[], desc = ""): LiteEntry => ({
  i: id,
  n: name,
  t: "cordis-plugin",
  s: 10,
  c: 0,
  p: "2026-01-01T00:00:00Z",
  sc: 50,
  g: null,
  vr: null,
  dl: null,
  tg: tags,
  d: desc,
});

test("normalizeQuery：完整 GitHub 链接只保留 owner/repo 路径", () => {
  expectQuery(
    "https://github.com/Arrosam/dsh-better-workspace-file-manager",
    "arrosam dsh better workspace file manager",
  );
  // scheme、www、.git 后缀、末尾斜杠要一起被剥掉
  expectQuery("https://www.github.com/owner/repo.git/", "owner repo");
  // 链接尾巴上的 ?tab=readme#readme 不能进检索词
  expectQuery("github.com/owner/repo?tab=readme#readme", "owner repo");
  // 不带协议头的仓库全名同样按分隔符拆词
  expectQuery("owner/repo", "owner repo");
});

test("normalizeQuery：中文与大小写", () => {
  expectQuery("工作区", "工作区");
  expectQuery("DSH", "dsh");
  expectQuery("dsh__better//workspace", "dsh better workspace");
});

test("normalizeQuery：边界输入", () => {
  expectQuery("", "");
  expectQuery("   ", "");
  // 少于 2 个字符按空查询处理，避免进入全量列表的中间态
  expectQuery("d", "");
  expectQuery("ab", "ab");
  expectQuery("https://", "");
  expectQuery("#readme", "");
  expectQuery("  plugin  ", "plugin");
});

test("normalizeQuery：超长输入截断到 120 字符", () => {
  const raw = "a".repeat(127);
  assert.equal(normalizeQuery(raw).length, 120);
});

test("normalizeQuery：非法入参返回空串，不抛异常", () => {
  assert.equal(normalizeQuery(undefined as unknown as string), "");
  assert.equal(normalizeQuery(null as unknown as string), "");
});

test("normalizeQuery：重复归一化结果不变", () => {
  const once = normalizeQuery("https://github.com/owner/repo.git");
  assert.equal(normalizeQuery(once), once);
});

test("normalizeQuery：非 GitHub 域名同样按路径取词", () => {
  expectQuery("https://gitee.com/owner/repo", "owner repo");
});

test("isRepoQuery：链接与仓库全名走直搜", () => {
  assert.equal(isRepoQuery("https://github.com/owner/repo"), true);
  assert.equal(isRepoQuery("github.com/owner/repo"), true);
  assert.equal(isRepoQuery("owner/repo"), true);
  assert.equal(isRepoQuery("  owner/repo.git/  "), true);
  // 带空格的普通关键词不能被误判成仓库形态
  assert.equal(isRepoQuery("workspace file manager"), false);
  assert.equal(isRepoQuery("工作区"), false);
  assert.equal(isRepoQuery(""), false);
  // 非法入参按否处理，不抛异常
  assert.equal(isRepoQuery(undefined as unknown as string), false);
});

test("createSearcher：粘贴链接按子串直搜，命中仓库全名", () => {
  const lite = [
    entry("Arrosam/dsh-better-workspace-file-manager", "dsh-better-workspace-file-manager", ["workspace"]),
    entry("someone/other-plugin", "other-plugin", ["plugin"], "文件管理"),
    entry("someone/dsh-workspace-groups", "dsh-workspace-groups", ["workspace"]),
  ];
  const search = createSearcher(lite);

  const byUrl = search("https://github.com/Arrosam/dsh-better-workspace-file-manager");
  assert.equal(byUrl.length, 1);
  assert.equal(byUrl[0]?.item.i, "Arrosam/dsh-better-workspace-file-manager");

  // owner/repo 全名同样只要那一条
  const byId = search("Arrosam/dsh-better-workspace-file-manager");
  assert.equal(byId.length, 1);
  assert.equal(byId[0]?.item.i, "Arrosam/dsh-better-workspace-file-manager");
});

test("createSearcher：直搜拼错不猜，返回空而不是退化成模糊匹配", () => {
  const lite = [entry("owner/dsh-workspace-groups", "dsh-workspace-groups", ["workspace"])];
  const search = createSearcher(lite);
  assert.deepEqual(search("https://github.com/owner/dsh-workspace-gropus"), []);
});

test("createSearcher：普通关键词仍走模糊检索", () => {
  const lite = [
    entry("a/dsh-workspace-groups", "dsh-workspace-groups", ["workspace"]),
    entry("b/other-plugin", "other-plugin", ["plugin"]),
  ];
  const search = createSearcher(lite);
  // 故意少一个字母，验证模糊容错没有被直搜路径影响
  const hits = search("worksapce");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.item.i, "a/dsh-workspace-groups");
});

test("createSearcher：名称整词命中排在仅简介命中之前", () => {
  const lite = [
    entry("x/alpha", "alpha", []),
    entry("y/beta", "beta", [], "alpha 工具"),
  ];
  const hits = rankHits(createSearcher(lite)("alpha"));
  assert.equal(hits.length, 2);
  // 名称全等拿到的字段权重更高，必须先出
  assert.equal(hits[0]?.item.i, "x/alpha");
});

test("createSearcher：多词查询的严格命中排在第一", () => {
  const lite = [
    entry("a/dsh-workspace", "dsh-workspace", []),
    entry("b/dsh-memory", "dsh-memory", []),
  ];
  const hits = rankHits(createSearcher(lite)("dsh workspace"));
  assert.equal(hits[0]?.item.i, "a/dsh-workspace");
  // 只命中 dsh 的条目按部分命中补齐，排在严格命中之后
  assert.equal(hits[1]?.item.i, "b/dsh-memory");
});

test("createSearcher：严格命中不足 60 条时补足候选，补齐项分数更大", () => {
  const lite = [
    entry("a/one-two", "one-two", []),
    entry("b/one", "one", []),
  ];
  const hits = rankHits(createSearcher(lite)("one two"));
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.item.i, "a/one-two");
  assert.ok((hits[0]?.fuzzyScore ?? 0) < (hits[1]?.fuzzyScore ?? 0));
});

test("createSearcher：严格命中足够多时不再混入部分命中", () => {
  const lite = [
    ...Array.from({ length: 60 }, (_, i) => entry(`o${i}/dsh-tool`, "dsh-tool", [])),
    entry("z/single", "single", [], "dsh"),
  ];
  const hits = rankHits(createSearcher(lite)("dsh tool"));
  assert.equal(hits.length, 60);
  assert.ok(hits.every((h) => h.item.i !== "z/single"));
});

test("createSearcher：中文只认完整词，含部分字不算命中", () => {
  const lite = [
    entry("a/workarea", "workspace", ["工作区"]),
    entry("b/partial", "partial", [], "工作流"),
  ];
  const hits = createSearcher(lite)("工作区");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.item.i, "a/workarea");
});

test("createSearcher：大小写不敏感", () => {
  const lite = [entry("A/DSH-Workspace", "DSH-Workspace", ["Workspace"])];
  assert.equal(createSearcher(lite)("dsh WORKSPACE").length, 1);
});

test("createSearcher：空查询与清洗后无效的查询返回空数组", () => {
  const search = createSearcher([entry("a/plugin", "plugin", [])]);
  assert.deepEqual(search(""), []);
  assert.deepEqual(search("  "), []);
  assert.deepEqual(search("https://"), []);
});

test("createSearcher：名称相同的条目整组排最前，组内按综合分排", () => {
  const lite = [
    { ...entry("a/dsh-market", "dsh-market", ["dsh", "market"]), sc: 10 },
    { ...entry("b/dsh-market", "dsh-market", ["dsh", "market"]), sc: 90 },
    // 标签里恰好同时写了 dsh 与 market 的相似名，只能排在同名组之后
    { ...entry("c/dsh-plugin-market", "dsh-plugin-market", ["dsh", "market"]), sc: 99 },
  ];
  const hits = rankHits(createSearcher(lite)("dsh-market"));
  assert.deepEqual(hits.map((h) => h.item.i), ["b/dsh-market", "a/dsh-market", "c/dsh-plugin-market"]);
});

test("createSearcher：连字符、下划线、无分隔符视为同名", () => {
  const lite = [
    { ...entry("x/dsh_market", "dsh_market", []), sc: 20 },
    { ...entry("y/dshmarket", "dshmarket", []), sc: 30 },
    { ...entry("z/dsh-market-plus", "dsh-market-plus", []), sc: 99 },
  ];
  const hits = rankHits(createSearcher(lite)("dsh-market"));
  assert.deepEqual(hits.map((h) => h.item.i), ["y/dshmarket", "x/dsh_market", "z/dsh-market-plus"]);
});

test("createSearcher：owner/repo 输入时 id 完全相符的条目锁第一位", () => {
  const lite = [
    { ...entry("dsh-market/dsh-market", "dsh-market", []), sc: 5 },
    { ...entry("2BingLing/dsh-market", "dsh-market", []), sc: 95 },
    { ...entry("c/dsh-plugin-market", "dsh-plugin-market", ["dsh", "market"]), sc: 99 },
  ];
  const hits = rankHits(createSearcher(lite)("dsh-market/dsh-market"));
  assert.deepEqual(
    hits.map((h) => h.item.i),
    ["dsh-market/dsh-market", "2BingLing/dsh-market", "c/dsh-plugin-market"],
  );
});

test("createSearcher：名称含完整短语排在仅字段命中之前", () => {
  const lite = [
    { ...entry("a/plain", "plain", [], "关于 dsh market 的说明"), sc: 99 },
    { ...entry("b/safer-dsh-market", "safer-dsh-market", []), sc: 1 },
  ];
  const hits = rankHits(createSearcher(lite)("dsh-market"));
  assert.deepEqual(hits.map((h) => h.item.i), ["b/safer-dsh-market", "a/plain"]);
});

test("createSearcher：owner/repo 被切成重复词时先去重，不改变同名组次序", () => {
  const lite = [
    { ...entry("dsh-market/dsh-market", "dsh-market", []), sc: 5 },
    { ...entry("2BingLing/dsh-market", "dsh-market", []), sc: 95 },
  ];
  const byKeyword = rankHits(createSearcher(lite)("dsh-market")).map((h) => h.item.i);
  // 去重后两次查询除「id 精确项」外顺序一致，说明重复词没有把权重翻倍
  assert.deepEqual(byKeyword, ["2BingLing/dsh-market", "dsh-market/dsh-market"]);
  const byRepo = rankHits(createSearcher(lite)("dsh-market/dsh-market")).map((h) => h.item.i);
  assert.deepEqual(byRepo, ["dsh-market/dsh-market", "2BingLing/dsh-market"]);
});

