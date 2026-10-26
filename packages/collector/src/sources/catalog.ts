import { CATALOG_URL } from "../config.ts";
import type { RawRecord } from "../normalize.ts";

/**
 * 第三方目录源（awesome-dsh-plugin）。
 *
 * 目录每天在 npm 上发版，`plugins.json` 是全量（约 6,896 条），`index.json` 只是
 * 已发布 npm 包的子集，不能当主源。这里只把它当「发现源」：哪些仓库值得看一眼，
 * 是否入库、星标、标签、质量门槛仍由我们自己的规则决定。
 *
 * 目录是社区提交的，存在仓库已删除的情况，因此必须用 GitHub API 取详情：
 * 取不到的（404、改名失败、网络错）本轮直接跳过，不进站，下轮再试。
 */

export interface CatalogItem {
  /** 原始大小写 owner/repo，用于调 GitHub API */
  id: string;
  /** 小写，用于去重与已收录比对 */
  key: string;
  /** 目录给的标准安装命令，已去掉包裹规格的引号 */
  command: string;
  /** 目录的中文简介 */
  descriptionZh: string | null;
  /** 分类中文名，仅在 GitHub topics 为空时作兜底标签 */
  categoryTag: string | null;
}

export interface CatalogIndex {
  /** 目录声明的原始条数 */
  total: number;
  items: CatalogItem[];
  /** 同一仓库多个 npm 包被折叠的条数 */
  duplicates: number;
  /** 缺仓库地址或安装命令被跳过的条数 */
  skipped: number;
}

const REPO_URL = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i;

/** 从仓库地址里取 owner/repo：兼容 https、ssh、.git 后缀与尾斜杠。 */
export function parseGithubRepo(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = REPO_URL.exec(url.trim());
  if (!m) return null;
  const owner = m[1] ?? "";
  const repo = (m[2] ?? "").replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/** 去掉规格外层的引号：目录里 release tarball 的规格写作 "https://...tgz"。 */
const unquote = (command: string): string => command.replace(/"([^"]+)"/g, "$1");

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 顶层 categories 字典 → 分类中文名，目录以后加分类不用改代码。 */
function parseCategories(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const label = typeof value === "object" && value !== null ? str((value as Record<string, unknown>).zh) : null;
    if (label) out.set(key, label);
  }
  return out;
}

/** 解析 plugins.json：按小写仓库名去重，缺地址或安装命令的直接跳过。 */
export function parseCatalogIndex(raw: unknown): CatalogIndex {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const plugins = Array.isArray(body.plugins) ? body.plugins : [];
  const labels = parseCategories(body.categories);
  const seen = new Set<string>();
  const items: CatalogItem[] = [];
  let duplicates = 0;
  let skipped = 0;

  for (const row of plugins) {
    const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    const id = parseGithubRepo(r.url);
    const command = str(r.install);
    if (!id || !command) {
      skipped++;
      continue;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const desc = typeof r.description === "object" && r.description !== null
      ? (r.description as Record<string, unknown>)
      : {};
    const category = str(r.category);
    items.push({
      id,
      key,
      command: unquote(command),
      descriptionZh: str(desc.zh),
      categoryTag: category ? labels.get(category) ?? null : null,
    });
  }

  return { total: plugins.length, items, duplicates, skipped };
}

/** 拉目录索引：失败只告警返回 null，绝不阻断整次构建。 */
export async function fetchCatalogIndex(): Promise<CatalogIndex | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(CATALOG_URL, {
        headers: { "user-agent": "dsh-shelfry-collector" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseCatalogIndex(await res.json());
    } catch (err) {
      if (attempt === 2) {
        console.warn(`[collector] 目录源拉取失败（${err instanceof Error ? err.message : String(err)}），本轮跳过`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return null;
}

/**
 * 把目录字段并进 GitHub 详情：中文简介、安装命令、标签兜底。
 * 只保留 GitHub 成功取回的仓库 —— 已删除的仓库不会被带进站点。
 */
export function mergeCatalog(ghRecords: RawRecord[], items: CatalogItem[]): RawRecord[] {
  const byKey = new Map(items.map((it) => [it.key, it]));
  const out: RawRecord[] = [];
  for (const gh of ghRecords) {
    const item = byKey.get(String(gh.id ?? gh.fullName ?? "").toLowerCase());
    if (!item) continue;
    const prevSources = Array.isArray(gh.sources) ? gh.sources.map(String) : [];
    const topics = Array.isArray(gh.tags) ? gh.tags.map(String).filter(Boolean) : [];
    const tags = topics.length > 0 ? topics : item.categoryTag ? [item.categoryTag] : [];
    out.push({
      ...gh,
      descriptionZh: item.descriptionZh ?? gh.descriptionZh ?? null,
      tags,
      install: { method: "pnpm-profile", commands: [item.command] },
      sources: [...new Set([...prevSources, "awesome-catalog"])],
    });
  }
  return out;
}
