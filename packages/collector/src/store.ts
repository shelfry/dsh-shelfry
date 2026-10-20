import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginEntry } from "@dsh-shelfry/schema";
import { DATA_DIR } from "./config.ts";

/**
 * 文件型 store：`.data/catalog.json` 存全量条目。
 *
 * 选文件而非数据库的理由：产物本来就要以静态 JSON 分发（Pages artifact / Release），
 * 再引一个 DB 只是多一层同步成本。merge 语义按 id 覆盖，保留 firstSeenAt 与验证结论。
 */

const CATALOG_FILE = resolve(DATA_DIR, "catalog.json");

export interface Catalog {
  generatedAt: string;
  entries: PluginEntry[];
}

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

export function loadCatalog(): Catalog {
  if (!existsSync(CATALOG_FILE)) return { generatedAt: new Date(0).toISOString(), entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as Catalog;
    if (!Array.isArray(parsed.entries)) return { generatedAt: new Date(0).toISOString(), entries: [] };
    return parsed;
  } catch {
    return { generatedAt: new Date(0).toISOString(), entries: [] };
  }
}

export function saveCatalog(catalog: Catalog): string {
  ensureDataDir();
  writeFileSync(CATALOG_FILE, JSON.stringify(catalog), "utf8");
  return CATALOG_FILE;
}

export interface MergeResult {
  catalog: Catalog;
  added: number;
  updated: number;
  unchanged: number;
}

/** 按 id 合并：新增 / 覆盖 / 沿用旧验证结论。 */
export function mergeEntries(prev: Catalog, incoming: PluginEntry[]): MergeResult {
  const byId = new Map(prev.entries.map((e) => [e.id, e]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const next of incoming) {
    const old = byId.get(next.id);
    if (!old) {
      byId.set(next.id, next);
      added++;
      continue;
    }
    // 沿用旧的验证结论与首次收录时间（验证要花 180s，不能因为一次抓取就丢）。
    // 例外：安装规格变了（包名被修正/上游改了安装方式）⇒ 旧结论对新规格无效，必须作废重验，
    // 否则会把「按错误包名失败」的结论永久钉在条目上。
    const staleEvidence = old.install.packageName !== next.install.packageName;
    const merged: PluginEntry = {
      ...next,
      firstSeenAt: old.firstSeenAt,
      verification: staleEvidence
        ? { status: "pending", checkedAt: null, dshVersion: null, profile: null }
        : old.verification,
    };
    merged.score = next.score;
    byId.set(next.id, merged);
    updated++;
    if (JSON.stringify(old) === JSON.stringify(merged)) unchanged++;
  }
  const entries = [...byId.values()].sort((a, b) => b.score.total - a.score.total || a.id.localeCompare(b.id));
  return { catalog: { generatedAt: new Date().toISOString(), entries }, added, updated, unchanged };
}

export function catalogPath(): string {
  return CATALOG_FILE;
}
