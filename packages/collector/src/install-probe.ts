import type { PluginEntry } from "@dsh-shelfry/schema";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./config.ts";
import { fetchGithubText, packageNameOfSpec } from "./evidence.ts";
import { packageBelongsTo } from "./identity.ts";
import { extractInstallSpec } from "./normalize.ts";
import { scoreEntry } from "./score.ts";

/**
 * 安装命令补全。
 *
 * 证据判定阶段只负责「是不是 DSH 生态」，不会读安装说明；很多插件因此落在
 * `command = null`，卡片上只能显示「上游没写安装命令」。这里对缺命令的条目
 * 再读一次 README，按可靠度补两类命令：
 *
 *   1. 上游写明的 DSH 安装：`dsh plugin --profile x add <spec>`
 *   2. 上游自带的安装器：`npx|bunx|pnpm dlx <pkg>[@ver] setup|install|init|add`
 *
 * 只认 README 里写出来的命令，绝不由仓库名倒推包名。探测结论按天缓存，
 * 仓库有新提交时自动重探，避免「今天没有、明天补了文档却永远不更新」。
 */

const CACHE_FILE = resolve(DATA_DIR, "install-probe.json");
const TTL_DAYS = 30;
const CONCURRENCY = 10;
const RAW = "https://raw.githubusercontent.com";

type ProbeKind = "dsh" | "native";

interface ProbeRow {
  v: "found" | "none";
  kind?: ProbeKind;
  /** dsh: 安装规格；native: 完整命令 */
  value?: string;
  /** native 的 npm 包名（去掉版本） */
  pkg?: string;
  /** 探测日期（YYYY-MM-DD），用于 TTL */
  t: string;
  /** 探测时仓库的 pushedAt，仓库有新提交后旧结论作废 */
  p?: string | null;
}

type Cache = Record<string, ProbeRow>;

export interface ProbeHit {
  kind: ProbeKind;
  value: string;
  pkg: string | null;
}

export interface InstallProbeResult {
  /** 本轮实际读 README 的条目数 */
  probed: number;
  /** 直接复用缓存结论的条目数 */
  cached: number;
  /** 补出 DSH 命令的条目数 */
  dsh: number;
  /** 补出上游安装器的条目数 */
  native: number;
}

const DAY = 86_400_000;
const today = (): string => new Date().toISOString().slice(0, 10);

/** 安装规格是不是 npm 包名（github:/git+/https/本地路径都不算）。 */
const isNpmSpec = (spec: string): boolean => !/^(github:|git\+|https?:|link:|file:|\.|\/)/.test(spec);

const GITHUB_SPEC = /^github:([^/]+)\/([^/\s#]+)/i;

/**
 * 命中命令是否真属于这个仓库。
 *
 * 清单仓库（awesome-*）和教程仓库的 README 会写别人的安装命令，照抄就会张冠李戴。
 * npm 包按「scope=作者 或 包名与仓库名互相包含」认定；`github:owner/repo`
 * 直接比对 owner/repo，最可靠。
 */
function hitBelongsTo(kind: ProbeKind, value: string, pkg: string | null, fullName: string): boolean {
  if (kind === "native") return !!pkg && packageBelongsTo(pkg, fullName);
  const gh = GITHUB_SPEC.exec(value);
  if (gh) return `${gh[1]}/${gh[2]}`.toLowerCase() === fullName.toLowerCase();
  if (!isNpmSpec(value)) return false;
  return packageBelongsTo(value, fullName);
}

const isFresh = (row: ProbeRow, entry: PluginEntry): boolean => {
  const at = Date.parse(`${row.t}T00:00:00Z`);
  if (!Number.isFinite(at) || Date.now() - at > TTL_DAYS * DAY) return false;
  // 仓库有新提交 => README 可能补了安装说明，重新看一眼
  return (row.p ?? null) === (entry.pushedAt ?? null);
};

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

/** README 里的 DSH 安装规格：支持 add 前后带 flag，只取真正的包名。 */
function findDshSpec(body: string): string | null {
  const lines = body.replace(/[`"'“”]/g, " ").match(/dsh\s+plugin\b[^\n]*/gi) ?? [];
  for (const raw of lines) {
    // 去掉行尾标点，避免把 `dsh plugin add foo.` 里的句号带进包名
    const line = raw.replace(/[.,;:!?)\]]+$/g, "");
    const spec = extractInstallSpec([line]);
    if (spec) return spec;
  }
  return null;
}

/**
 * 上游自带安装器。
 *
 * 只收安装类子命令 —— `npx pkg analyze-file` 是使用说明，不是安装方式。
 * 排除 `npx skills add`（skills.sh 的托管安装，不属于上游自带安装器口径）。
 */
const NATIVE =
  /\b(npx|bunx|pnpm\s+dlx)\s+((?:-y|--yes)\s+)?((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@([\w.-]+))?\s+(setup|install|init|add)\b/gi;

const SUB_RANK: Record<string, number> = { setup: 4, init: 3, install: 2, add: 1 };

function findNative(body: string): ProbeHit | null {
  const found: Array<{ hit: ProbeHit; rank: number; at: number }> = [];
  for (const m of body.matchAll(NATIVE)) {
    const channel = m[1]!.replace(/\s+/g, " ");
    const flag = m[2] ? m[2].trim() : "";
    const pkg = m[3]!;
    const ver = m[4] ? `@${m[4]}` : "";
    const sub = m[5]!.toLowerCase();
    if (pkg.toLowerCase() === "skills" && sub === "add") continue;
    const command = `${channel} ${flag ? `${flag} ` : ""}${pkg}${ver} ${sub}`.replace(/\s+/g, " ").trim();
    // 有版本号（尤其 @latest）更接近上游当前的推荐写法，优先展示
    const rank = SUB_RANK[sub]! * 10 + (ver ? 5 : 0) + (ver === "@latest" ? 1 : 0);
    found.push({ hit: { kind: "native", value: command, pkg }, rank, at: m.index ?? 0 });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.rank - a.rank || a.at - b.at);
  return found[0]!.hit;
}

/** 读 README 找安装方式；主 README 没有就再看中文变体，最多 3 个文件。 */
export async function probeInstall(owner: string, repo: string): Promise<ProbeHit | null> {
  const names = ["README.md", "README.zh-CN.md", "README_zh.md"];
  for (const name of names) {
    const body = await fetchGithubText(`${RAW}/${owner}/${repo}/HEAD/${name}`);
    if (!body) continue;
    const dsh = findDshSpec(body);
    if (dsh) return { kind: "dsh", value: dsh, pkg: packageNameOfSpec(dsh) };
    const native = findNative(body);
    if (native) return native;
  }
  return null;
}

/** 把命中的安装方式写回条目；包名变了就作废旧的版本号/下载量，让下游重查。 */
export function applyProbeHit(e: PluginEntry, hit: ProbeHit, now: number): void {
  const oldPkg = e.install.packageName;
  if (hit.kind === "dsh") {
    e.install.method = "pnpm-profile";
    e.install.command = `dsh plugin --profile <profile> add ${hit.value}`;
    e.install.packageName = hit.value;
    e.install.needsConfig = false;
  } else {
    e.install.method = "native";
    e.install.command = hit.value;
    e.install.packageName = hit.pkg;
    // 安装器会写配置/建目录，按「需要配置」计分，避免便捷度虚高
    e.install.needsConfig = true;
  }
  if (oldPkg !== e.install.packageName) {
    e.version = null;
    e.downloads = null;
  }
  e.score = scoreEntry(e, now);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 对缺安装命令的条目做补全。限量按 star 从高到低探，保证首页与常见插件先补齐；
 * 其余条目会在后续每日构建里逐步补上（缓存保证不重复请求）。
 */
export async function resolveInstallCommands(
  entries: PluginEntry[],
  options: { limit?: number; now?: number } = {},
): Promise<InstallProbeResult> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? Number(process.env.INSTALL_PROBE_LIMIT ?? 800);
  const cache = loadCache();
  const candidates = entries
    .filter((e) => !e.install.command)
    .sort((a, b) => b.stars - a.stars);

  const result: InstallProbeResult = { probed: 0, cached: 0, dsh: 0, native: 0 };
  let budget = limit;
  let dirty = false;

  await mapLimit(candidates, CONCURRENCY, async (e) => {
    const id = e.id;
    const cachedRow = cache[id];
    let row: ProbeRow | null = null;

    if (cachedRow && isFresh(cachedRow, e)) {
      row = cachedRow;
      result.cached++;
    } else {
      if (budget <= 0) return;
      budget--;
      result.probed++;
      const [owner, repo] = id.split("/", 2);
      if (!owner || !repo) return;
      try {
        const hit = await probeInstall(owner, repo);
        row = hit
          ? { v: "found", kind: hit.kind, value: hit.value, ...(hit.pkg ? { pkg: hit.pkg } : {}), t: today(), p: e.pushedAt }
          : { v: "none", t: today(), p: e.pushedAt };
        cache[id] = row;
        dirty = true;
      } catch {
        return;
      }
    }

    if (!row || row.v !== "found" || !row.kind || !row.value) return;
    // 探测期间条目可能已被别的规则补上命令，别覆盖更可靠的结论
    if (e.install.command) return;
    // 清单仓库/教程仓库的 README 常写别人的安装命令：包名与仓库对不上就不采
    if (!hitBelongsTo(row.kind, row.value, row.pkg ?? null, e.fullName)) return;
    applyProbeHit(e, { kind: row.kind, value: row.value, pkg: row.pkg ?? null }, now);
    if (row.kind === "dsh") result.dsh++;
    else result.native++;
  });

  if (dirty) saveCache(cache);
  return result;
}
