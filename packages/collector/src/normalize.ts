import type {
  InstallMethod,
  InstallSpec,
  PluginEntry,
  PluginType,
} from "@dsh-shelfry/schema";
import { defaultInstallCommand } from "@dsh-shelfry/schema";
import { scoreEntry } from "./score.ts";

/** 上游 lite 记录的松散形状（我们只读取需要的字段，不做强校验）。 */
export interface RawRecord {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  fullName?: unknown;
  stars?: unknown;
  description?: unknown;
  descriptionZh?: unknown;
  tags?: unknown;
  curated?: unknown;
  homepage?: unknown;
  pushedAt?: unknown;
  install?: unknown;
  sources?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bool = (v: unknown): boolean => v === true;
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];

function toType(v: unknown): PluginType {
  const s = str(v);
  if (s === "cordis-plugin" || s === "skill") return s;
  return "unknown";
}

/**
 * 从上游安装命令里抽取规范化依赖规格。
 *
 * 不用「最后一个 token + 猜」：上游 `name` 是仓库名，不等于 npm 包名，拿仓库名当
 * 包名会造出一条根本装不上的命令。只认上游明确写出的安装动作：`add`/`install` 之后
 * 的那个非 flag 参数。支持形态：
 *   dsh-context / @scope/pkg / dshmarket     → 直接就是 npm 包名
 *   dsh-context@1.2.3                        → 带版本，保留版本
 *   npm:dsh-context                          → 取冒号后的包名
 *   github:owner/repo / git+https://…        → pnpm 原生支持，原样透传
 * 本地路径（link:/file:/./…）需要先 clone，一条命令装不上，返回 null。
 */
export function extractInstallSpec(commands: string[]): string | null {
  for (const cmd of commands) {
    const tokens = cmd.trim().split(/\s+/);
    // 全局安装的是 CLI 工具，不是 profile 插件；拿它当插件装必然失败，不能算作安装规格。
    if (/\s(-g|--global)(\s|$)/.test(` ${cmd} `)) continue;
    const at = Math.max(tokens.lastIndexOf("add"), tokens.lastIndexOf("install"));
    if (at < 0) continue;
    // 跳过 add 与规格之间的 flag（如 `add -w pkg@1.0.0` 的 -w、`install --save-dev pkg`）：
    // 不跳过就会把 `-w` 当成包名而整条丢弃。
    let j = at + 1;
    while (tokens[j]?.startsWith("-")) j++;
    // 规格后面的 `@版本` 可能被 shell 拆成第二个 token（`pkg @1.0.0`），补回来。
    let spec = tokens[j];
    if (!spec) continue;
    const nextTok = tokens[j + 1];
    if (nextTok?.startsWith("@") && !spec.includes("@")) spec = `${spec}${nextTok}`;
    const normalized = normalizeSpec(spec);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeSpec(spec: string): string | null {
  if (!spec) return null;
  // 本地路径 / 工作区引用：无法用一条安装命令验证。
  if (/^(link:|file:|workspace:|portal:|\.{1,2}\/|\/)/.test(spec)) return null;
  if (spec.startsWith("npm:")) return spec.slice(4) || null;
  // 远程规格：pnpm 原生支持，原样透传。
  if (/^(github:|git\+|git:|https?:|ssh:)/.test(spec)) return spec;
  // 普通 npm 包名（可带 scope），可带 @版本 / @标签。
  if (/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9][a-z0-9._-]*)?$/i.test(spec)) return spec;
  return null;
}

function toMethod(v: unknown): InstallMethod {
  const s = str(v);
  if (s === "pnpm-profile" || s === "skills-add" || s === "manual") return s;
  return "unknown";
}

function buildInstall(raw: Record<string, unknown>): InstallSpec {
  const method = toMethod(raw.method);
  const commands = strArr(raw.commands);
  // 只认上游明确写出的安装动作，绝不用仓库名倒推 npm 包名（会造出假失败）。
  const packageName = extractInstallSpec(commands);
  const remote = !!packageName && /^(github:|git\+|git:|https?:|ssh:)/.test(packageName);
  return {
    method,
    command: defaultInstallCommand(method, packageName),
    packageName,
    enginesDsh: str(raw.dshEngines),
    needsConfig: bool(raw.needsConfig) || bool(raw.usageNeedsConfig),
    // 远程规格要拉整个仓库，比装 npm 包重；上游自己标的 risky 也尊重。
    risky: bool(raw.risky) || remote,
  };
}

/**
 * 把一条上游记录规整成我们的 PluginEntry。
 * `prev` 为该条目的上一版（若存在）：首次收录时间沿用。
 */
export function normalizeRecord(raw: RawRecord, now: Date, prev?: PluginEntry): PluginEntry | null {
  const id = str(raw.id) ?? str(raw.fullName);
  const fullName = str(raw.fullName) ?? id;
  if (!id || !fullName) return null;

  const name = str(raw.name) ?? fullName.split("/").pop() ?? id;
  const installRaw = (typeof raw.install === "object" && raw.install !== null ? raw.install : {}) as Record<string, unknown>;
  const sources = strArr(raw.sources);
  const iso = now.toISOString();

  // 检索源给不出安装规格与类型：这两种字段缺失时沿用上一轮结论，
  // 否则一次 GitHub 检索就会把镜像源已经解析好的安装命令和 skill 类型冲掉。
  const freshInstall = buildInstall(installRaw);
  const install = freshInstall.command ? freshInstall : (prev?.install ?? freshInstall);
  // 类型同上。skill 的判据：上游显式标注、skills-add 安装方式、或话题里带 skill
  // —— 上一轮被检索源覆盖成 cordis-plugin 的条目靠最后这条能自愈。
  const tags = strArr(raw.tags);
  const looksSkill =
    install.method === "skills-add" ||
    prev?.install.method === "skills-add" ||
    tags.some((t) => /skill/i.test(t));
  const type: PluginType = str(raw.type)
    ? toType(raw.type)
    : looksSkill
      ? "skill"
      : (prev?.type ?? "cordis-plugin");

  const entry: PluginEntry = {
    id,
    name,
    fullName,
    type,
    stars: num(raw.stars),
    description: str(raw.description) ?? "",
    descriptionZh: str(raw.descriptionZh),
    tags,
    curated: bool(raw.curated),
    homepage: str(raw.homepage),
    pushedAt: str(raw.pushedAt),
    // 版本号由 versions.ts 事后从 npm registry 补全，镜像与检索结果里都没有。
    version: prev?.version ?? null,
    // 下载量同样事后补全；复用上一轮结论，避免每次全量重查。
    downloads: prev?.downloads ?? null,
    install,
    score: {
      maintenance: 0, utility: 0, popularity: 0, convenience: 0, total: 0,
    },
    sources: sources.length ? sources : ["mirror"],
    firstSeenAt: prev?.firstSeenAt ?? iso,
    updatedAt: iso,
  };

  entry.score = scoreEntry(entry, now.getTime());
  return entry;
}
