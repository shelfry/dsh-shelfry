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
    // 沿用首次收录时间（重算分数不影响它），其余字段一律取最新抓取结果。
    const merged: PluginEntry = {
      ...next,
      firstSeenAt: old.firstSeenAt,
      // 来源是溯源信息，只增不减：手动补录（Issue 提交）的标记不能被后续检索结果冲掉
      sources: [...new Set([...old.sources, ...next.sources])],
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
