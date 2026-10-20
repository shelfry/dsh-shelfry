import type { PluginEntry } from "@dsh-shelfry/schema";

/**
 * 补全插件自身版本号（不是 dsh 兼容范围）。
 *
 * 三条来源，按可靠度排序：
 *   1. 安装规格里钉死的版本（`add foo@0.5.6`）—— 装上去就是这个版本，直接用；
 *   2. npm registry 的 latest（`add foo` / `add foo@latest`）；
 *   3. 没有 npm 规格的（`github:owner/repo` 或上游压根没写安装命令）读仓库根 package.json。
 *
 * 取不到就保持 null，前端不显示版本，绝不用兼容范围冒充版本号。
 */

const REGISTRY = "https://registry.npmjs.org";
const RAW = "https://raw.githubusercontent.com";
const CONCURRENCY = 48;
const TIMEOUT_MS = 8000;

type Spec =
  | { kind: "exact"; version: string }
  | { kind: "npm"; pkg: string }
  | { kind: "github"; owner: string; repo: string }
  | null;

const EXACT = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;

function parseSpec(spec: string | null): Spec {
  if (!spec) return null;

  const gh = spec.match(/^github:([^/#]+)\/([^/#]+)/);
  if (gh) return { kind: "github", owner: gh[1]!, repo: gh[2]!.replace(/\.git$/, "") };

  // git+/https/本地路径之类没有可查的发布版本
  if (/^(git\+|https?:|link:|file:|\.|\/)/.test(spec)) return null;

  // scoped 包 @a/b 的第一个 @ 是前缀，版本分隔符只可能在 index>0 的位置
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : "";
  if (!name) return null;

  if (EXACT.test(range)) return { kind: "exact", version: range.replace(/^v/, "") };
  return { kind: "npm", pkg: name };
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const latestVersion = async (pkg: string): Promise<string | null> => {
  const body = await fetchJson(`${REGISTRY}/${pkg.replace("/", "%2F")}/latest`);
  const v = body?.["version"];
  return typeof v === "string" ? v : null;
};

const repoVersion = async (owner: string, repo: string): Promise<string | null> => {
  const body = await fetchJson(`${RAW}/${owner}/${repo}/HEAD/package.json`);
  const v = body?.["version"];
  if (typeof v !== "string") return null;
  // monorepo 根 package.json 常写成 0.0.0 占位，这种不算版本
  return /^0\.0\.0?$/.test(v) ? null : v;
};

/** 就地写入 entry.version。返回命中条数。 */
export async function resolveVersions(entries: PluginEntry[]): Promise<number> {
  const pending: PluginEntry[] = [];
  let hits = 0;

  for (const e of entries) {
    if (e.version) { hits++; continue; }
    const spec = parseSpec(e.install.packageName);
    if (spec?.kind === "exact") { e.version = spec.version; hits++; continue; }
    pending.push(e);
  }

  // 同一个源只查一次：npm 包名 / 仓库名 / 兜底用的仓库名，查完回填。
  const targetOf = (e: PluginEntry): { key: string; spec: NonNullable<Spec> } => {
    const spec = parseSpec(e.install.packageName);
    if (spec && spec.kind !== "exact") {
      const key = spec.kind === "npm" ? `npm:${spec.pkg}` : `gh:${spec.owner}/${spec.repo}`;
      return { key, spec };
    }
    // 没写 npm 规格：退回仓库本身
    const slash = e.fullName.indexOf("/");
    return {
      key: `gh:${e.fullName}`,
      spec: { kind: "github", owner: e.fullName.slice(0, slash), repo: e.fullName.slice(slash + 1) },
    };
  };

  const groups = new Map<string, { spec: NonNullable<Spec>; entries: PluginEntry[] }>();
  for (const e of pending) {
    const { key, spec } = targetOf(e);
    const g = groups.get(key);
    if (g) g.entries.push(e);
    else groups.set(key, { spec, entries: [e] });
  }

  const keys = [...groups.keys()];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, keys.length) }, async () => {
    while (cursor < keys.length) {
      const group = groups.get(keys[cursor++]!)!;
      const spec = group.spec;
      let version: string | null = null;
      if (spec.kind === "npm") version = await latestVersion(spec.pkg);
      else if (spec.kind === "github") version = await repoVersion(spec.owner, spec.repo);
      if (!version) continue;
      for (const e of group.entries) { e.version = version; hits++; }
    }
  });
  await Promise.all(workers);

  return hits;
}
