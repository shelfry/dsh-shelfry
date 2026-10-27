import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginEntry } from "@dsh-shelfry/schema";
import { DATA_DIR } from "./config.ts";
import { scoreEntry } from "./score.ts";
import { findStandaloneCommand, type StandaloneHit } from "./standalone.ts";
import { isManualPick } from "./manual-pick.ts";

/**
 * 生态归属的实证判定。
 *
 * 名字/简介里有没有 dsh 不可靠：rea 是货真价实的 Skill，但它的 README 里一个
 * dsh 字样都没有，靠的是仓库里 `.agents/skills/` 目录；反过来 nocobase、1Panel
 * 打上 dsh-plugin 话题，README 和 package.json 里却查无此物。
 *
 * 所以判定分三层证据，从便宜到贵：
 *   1. README（多个语言版本）里的安装说明；
 *   2. package.json 的依赖/关键词；
 *   3. 仓库根目录结构（需要抓 tree 页面，最贵，只在 1、2 都没命中时才做）。
 * 三层全空才判无关。
 */

export type EvidenceKind = "skill" | "plugin";

/** 判定规则版本：规则改动后旧缓存一律重探，避免错误结论被缓存固化。 */
const RULE_VERSION = 4;

export interface Evidence {
  /** keep=生态内（含独立工具），drop=判定无关 */
  v: "keep" | "drop";
  kind: EvidenceKind | null;
  /** external=非 DSH 独立工具：README 写明了自带的安装命令 */
  eco?: "external";
  /** 独立工具的安装命令 */
  cmd?: string;
  /** 独立工具的 npm 包名（仅 npm 全局安装时有值） */
  pkg?: string | null;
  /** README 里现成的安装规格（如 @tt-a1i/archify-dsh@1.0.0），没有则为空 */
  spec?: string | null;
  /** 命中的证据短标记，用于抽查 */
  e: string[];
  /** 判定日期 YYYY-MM-DD */
  t: string;
  /** 规则版本；缺失视为旧规则结论 */
  r?: number;
}

type Cache = Record<string, Evidence>;

const CACHE_FILE = resolve(DATA_DIR, "evidence.json");
const TTL_DAYS = 30;

export const README_NAMES = [
  "README.md",
  "README.zh-CN.md",
  "README_zh.md",
  "readme.md",
  "README.markdown",
];

const RAW = "https://raw.githubusercontent.com";
const TIMEOUT_MS = 12000;
const HEADERS = {
  accept: "*/*",
  "user-agent": "dsh-shelfry-collector/1.0 (+https://shelfry.app)",
};

const SKILL_CMD = /dsh\s+skill\s+add/i;
const PLUGIN_CMD = /dsh\s+plugin\s+add/i;
// 单独的 dsh 词也算（dsh_workflow、dsh-client-ui-custom 这类名字），
// 少了这条会把自证生态的仓库当成模糊条目去探测，白白增加剔除误伤。
const LOOSE = /(^|[^a-z0-9])dsh([^a-z0-9]|$)|dsh[-_]plugin|dsh[-_]market|deepseek[-_ ]?harness|cordis/i;

/**
 * 从 README 里抓现成的安装规格。
 * 上游写法很杂：`dsh plugin add x`、`dsh plugin --profile web add @scope/x@1.0.0`，
 * 统一取 add 后面那个参数；不想让签名/说明里的反引号干扰，遇到空白或引号就截断。
 */
const SKILL_SPEC = /dsh\s+skill\s+add\s+([^\s`'"|]+)/i;
const PLUGIN_SPEC = /dsh\s+plugin\b[^\n`]*?\badd\s+([^\s`'"|]+)/i;

/** 从安装规格里剥掉版本，只留包名（`@a/b@1.2.3` → `@a/b`）。 */
export function packageNameOfSpec(spec: string): string {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

/** README 模板里的占位规格（github:owner/repo 之类），不是真实安装地址。 */
export const isPlaceholderSpec = (spec: string): boolean =>
  /^github:(owner|user|username|your[-_]?name|xxx)\//i.test(spec);

/** 名字或简介里已经带 dsh 生态字样的，无需实证。 */
export function nameSaysDsh(fullName: string, description: string | null): boolean {
  return LOOSE.test(`${fullName} ${description ?? ""}`);
}

function loadCache(): Cache {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Cache) : {};
  } catch {
    return {};
  }
}

function saveCache(cache: Cache): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
}

const isFresh = (ev: Evidence): boolean => {
  if (ev.r !== RULE_VERSION) return false;
  const at = Date.parse(`${ev.t}T00:00:00Z`);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < TTL_DAYS * 86_400_000;
};

export async function fetchGithubText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** 第 1 层：README 的安装说明。命中 dsh skill add / plugin add 时顺带取类型与规格。 */
async function probeReadme(
  owner: string,
  repo: string,
): Promise<{
  kind: EvidenceKind | null;
  hit: string | null;
  spec: string | null;
  standalone: StandaloneHit | null;
  loose: boolean;
}> {
  let standalone: StandaloneHit | null = null;
  let loose = false;
  for (const name of README_NAMES) {
    const body = await fetchGithubText(`${RAW}/${owner}/${repo}/HEAD/${name}`);
    if (!body) continue;
    const skill = body.match(SKILL_SPEC);
    if (skill?.[1]) return { kind: "skill", hit: `${name}:skill-add`, spec: skill[1], standalone: null, loose };
    if (SKILL_CMD.test(body)) return { kind: "skill", hit: `${name}:skill-add`, spec: null, standalone: null, loose };
    const plugin = body.match(PLUGIN_SPEC);
    if (plugin?.[1]) return { kind: "plugin", hit: `${name}:plugin-add`, spec: plugin[1], standalone: null, loose };
    if (PLUGIN_CMD.test(body)) return { kind: "plugin", hit: `${name}:plugin-add`, spec: null, standalone: null, loose };
    // 只提到 dsh 不算生态证据：很多独立 CLI 会把 DSH 当集成对象写一段。
    // 先记下来，等独立安装命令判断完再决定它是不是插件（rea / ruflo / phi 都是这种）。
    if (LOOSE.test(body)) loose = true;
    if (!standalone) standalone = findStandaloneCommand(body, `${owner}/${repo}`);
  }
  return { kind: null, hit: null, spec: null, standalone, loose };
}

/** 第 2 层：package.json 的依赖与关键词。 */
async function probePackageJson(owner: string, repo: string): Promise<{ kind: EvidenceKind | null; hit: string | null }> {
  const body = await fetchGithubText(`${RAW}/${owner}/${repo}/HEAD/package.json`);
  if (!body) return { kind: null, hit: null };
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { kind: null, hit: null };
  }
  const deps = {
    ...((pkg["dependencies"] as Record<string, unknown> | undefined) ?? {}),
    ...((pkg["devDependencies"] as Record<string, unknown> | undefined) ?? {}),
  };
  const depHit = Object.keys(deps).find((k) => /dsh|cordis/i.test(k));
  if (depHit) return { kind: "plugin", hit: `deps:${depHit}` };
  const keywords = Array.isArray(pkg["keywords"]) ? (pkg["keywords"] as unknown[]).map(String) : [];
  if (keywords.some((k) => LOOSE.test(k))) return { kind: null, hit: "keywords" };
  return { kind: null, hit: null };
}

/**
 * 第 3 层：仓库根目录结构。走 github.com 的 tree 页面而不是 API ——
 * API 匿名额度只有 60 次/小时，1065 个仓库根本跑不完；
 * HTML 页面没有这个限制，代价是每次约 400KB，所以只在前两层都落空时才用。
 *
 * 页面里嵌着根目录清单的 JSON（`"tree":{"items":[{"path":...}]}`），直接按**精确路径**判断：
 * 只看 `.agents` 会被坑 —— reactive-resume 的 `.agents/docs` 是给 AI 看的文档，不是技能；
 * rea 的 `.agents/skills` 才是。
 */
async function probeTree(owner: string, repo: string): Promise<{ kind: EvidenceKind | null; hit: string | null }> {
  const html = await fetchGithubText(`https://github.com/${owner}/${repo}/tree/HEAD`);
  if (!html) return { kind: null, hit: null };
  const block = html.match(/"tree":\{"items":\[(.*?)\]\}/s)?.[1] ?? "";
  const paths = [...block.matchAll(/"path":"([^"]+)"/g)].map((m) => m[1]!);
  if (paths.length === 0) return { kind: null, hit: null };

  // 编译型应用的仓库也常放 `.agents/skills`（例如自己的 release 流程），
  // 那是自用开发技能，不代表这个仓库本身是可分发的 skill。
  // phi 就是这样被误收成 skill 的：Go 应用 + `.agents/skills/release`。
  const appManifest = paths.some((p) =>
    p === "go.mod" || p === "Cargo.toml" || p === "src-tauri" ||
    p === "tauri.conf.json" || p === "electron-builder.json" ||
    p === "electron-builder.yml" || p === "electron-builder.yaml",
  );
  if (paths.some((p) => p === "SKILL.md")) {
    return { kind: "skill", hit: "tree:root-skill" };
  }
  if (!appManifest && paths.some((p) => p.startsWith(".agents/skills"))) {
    return { kind: "skill", hit: "tree:agents-skills" };
  }
  if (!appManifest && paths.some((p) => p === "skills" || p.startsWith("skills/"))) {
    return { kind: "skill", hit: "tree:skills" };
  }
  const manifest = paths.find((p) => p === "dsh-plugin.json" || p === "dsh.json" || p === "cordis.yml");
  if (manifest) return { kind: "plugin", hit: `tree:${manifest}` };
  return { kind: null, hit: null };
}

export interface ProbeOptions {
  /** 并发数：tree 页面体积大，收敛一些避免被 GitHub 判定为滥用 */
  concurrency?: number;
}

/** 对单个仓库取证据，结果写缓存。 */
export async function probeRepo(owner: string, repo: string): Promise<Evidence> {
  const found: string[] = [];
  let kind: EvidenceKind | null = null;
  let spec: string | null = null;

  const readme = await probeReadme(owner, repo);
  kind = readme.kind;
  spec = readme.spec;

  // 优先级：README 里写明 dsh plugin/skill 安装命令 > 独立安装命令 > 仅提及 dsh > 目录结构。
  //
  // 独立安装命令排在目录结构之前是有教训的：rea 与 ruflo 都是自带 CLI 的工具，
  // 只是在仓库里放了给 agent 用的 .agents/skills / SKILL.md，按目录判会被当成 skill
  // 塞进插件列表 —— 用户反馈「这个好像不是插件」正是这类。
  if (kind) {
    return {
      v: "keep", kind, spec, e: [readme.hit ?? "readme"], t: new Date().toISOString().slice(0, 10), r: RULE_VERSION,
    };
  }

  if (readme.standalone) {
    return {
      v: "keep",
      kind: null,
      eco: "external",
      cmd: readme.standalone.command,
      pkg: readme.standalone.pkg,
      spec: null,
      e: ["readme:standalone"],
      t: new Date().toISOString().slice(0, 10),
      r: RULE_VERSION,
    };
  }

  if (readme.loose) found.push("readme:mention");

  if (found.length === 0) {
    const pkg = await probePackageJson(owner, repo);
    if (pkg.hit) found.push(pkg.hit);
    kind = pkg.kind;
  }

  if (found.length === 0) {
    const tree = await probeTree(owner, repo);
    if (tree.hit) found.push(tree.hit);
    kind = tree.kind;
  }

  return {
    v: found.length > 0 ? "keep" : "drop",
    kind,
    spec,
    e: found,
    t: new Date().toISOString().slice(0, 10),
    r: RULE_VERSION,
  };
}

export interface EvidenceResult {
  /** 名字/简介自带 DSH 字样，直接保留 */
  named: number;
  /** 缓存命中，未发请求 */
  cached: number;
  /** 本轮实际探测 */
  probed: number;
  /** 实证保留 / 判无关 */
  kept: number;
  dropped: number;
  /** 其中判为独立工具的数量 */
  external: number;
}

/**
 * 把证据回写到条目：类型按 README 的安装方式纠正，缺安装规格的用 README 里的现成命令补上。
 * 只在证据明确时改 —— 名称含 dsh 但证据只有「提及」的条目，类型与规格都保持原样。
 */
function applyEvidence(e: PluginEntry, ev: Evidence): void {
  if (ev.v !== "keep") return;

  // 独立工具：有安装命令、但不经 DSH 加载。类型没有插件含义，统一按 unknown 处理，
  // 评分重算一次 —— 命令是判定后才补上的，不重算便捷度会虚低。
  if (ev.eco === "external" && ev.cmd) {
    e.ecosystem = "external";
    e.type = "unknown";
    e.install.method = "standalone";
    e.install.command = ev.cmd;
    e.install.packageName = ev.pkg ?? null;
    e.install.needsConfig = false;
    // 管道执行远端脚本属于较重安装，标出来让用户先看清楚
    e.install.risky = /\b(curl|wget|irm|iwr)\b/i.test(ev.cmd);
    // 非 npm 分发没有可靠的版本来源：上一轮按仓库名猜出来的版本/下载量要清掉，
    // 否则会出现「npm 包名：无」却挂着别人家版本号的自相矛盾。
    if (!ev.pkg) {
      e.version = null;
      e.downloads = null;
    }
    e.score = scoreEntry(e, Date.now());
    return;
  }

  // 走回 DSH 生态（曾被误判成工具的条目在这里纠正）：
  // 先把上一轮的独立工具命令清掉，避免 DSH 条目挂着一条与 profile 无关的命令。
  e.ecosystem = "dsh";
  if (e.install.method === "standalone") {
    e.install.method = "unknown";
    e.install.command = null;
    e.install.packageName = null;
    e.install.needsConfig = false;
    e.install.risky = false;
  }
  if (!ev.kind) return;
  e.type = ev.kind === "skill" ? "skill" : "cordis-plugin";
  if (ev.kind === "skill") {
    // 不存在 `dsh skill add`（dsh 会把 skill 当成 profile 名报错），
    // 所以 skill 只改类型与安装方式，命令一律留空，由 UI 说明。
    e.install.method = "skills-add";
    e.install.command = null;
    return;
  }
  const spec = ev.spec?.trim() ?? "";
  if (e.install.command || !spec || isPlaceholderSpec(spec)) return;
  // 规格形如 @scope/pkg@1.2.3：命令原样用，packageName 去掉版本段
  e.install.command = `dsh plugin --profile web add ${spec}`;
  e.install.packageName = spec;
  e.install.method = "pnpm-profile";
  e.install.needsConfig = false;
}

/**
 * 就地判定：nameSaysDsh 为真的条目原样保留；其余逐条取证据。
 * 判无关的条目由调用方决定是否从 catalog 移除。
 */
export async function resolveEvidence(
  entries: PluginEntry[],
  opts: ProbeOptions = {},
): Promise<{ result: EvidenceResult; dropped: PluginEntry[] }> {
  const cache = loadCache();
  const result: EvidenceResult = { named: 0, cached: 0, probed: 0, kept: 0, dropped: 0, external: 0 };
  const pending: PluginEntry[] = [];

  for (const e of entries) {
    // 站长点名收录的条目不做生态判定：手动加进来就是明确要的
    if (isManualPick(e)) {
      result.kept++;
      // 缓存里若有旧的「判无关」结论，一并作废，避免下次又把它判掉
      if (cache[e.fullName]?.v === "drop") delete cache[e.fullName];
      continue;
    }
    if (nameSaysDsh(e.fullName, e.description)) {
      result.named++;
      // 名称本身就自证生态：缓存里的旧「判无关」结论一律作废，否则补录回来的条目会被再次剔除
      if (cache[e.fullName]?.v === "drop") delete cache[e.fullName];
      continue;
    }
    const hit = cache[e.fullName];
    if (hit && isFresh(hit)) {
      result.cached++;
      if (hit.v === "drop") result.dropped++;
      else {
        result.kept++;
        if (hit.eco === "external") result.external++;
      }
      applyEvidence(e, hit);
      continue;
    }
    pending.push(e);
  }

  const queue = [...pending];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 8, queue.length) }, async () => {
    for (;;) {
      const e = queue.shift();
      if (!e) return;
      const slash = e.fullName.indexOf("/");
      const owner = e.fullName.slice(0, slash);
      const repo = e.fullName.slice(slash + 1);
      const evidence = await probeRepo(owner, repo);
      cache[e.fullName] = evidence;
      result.probed++;
      if (evidence.v === "drop") result.dropped++;
      else {
        result.kept++;
        if (evidence.eco === "external") result.external++;
        applyEvidence(e, evidence);
      }
    }
  });
  await Promise.all(workers);

  saveCache(cache);
  // 只有「名称不自证」且非点名收录的条目才可能被判无关；点名收录的即使缓存里残留 drop 也不算
  const dropped = entries.filter(
    (e) => !isManualPick(e) && !nameSaysDsh(e.fullName, e.description) && cache[e.fullName]?.v === "drop",
  );
  return { result, dropped };
}

export function readEvidenceCache(): Cache {
  return loadCache();
}

/** 剔除清单落盘：误删时可据此回溯，也方便人工抽查。 */
export function writeDroppedList(dropped: PluginEntry[]): string {
  const file = resolve(DATA_DIR, "dropped.json");
  mkdirSync(DATA_DIR, { recursive: true });
  const rows = dropped
    .map((e) => ({ id: e.fullName, stars: e.stars, tags: e.tags.slice(0, 6) }))
    .sort((a, b) => b.stars - a.stars);
  writeFileSync(file, JSON.stringify(rows, null, 0), "utf8");
  return file;
}

export function evidenceCachePath(): string {
  return CACHE_FILE;
}
