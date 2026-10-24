import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeGitHubRepo } from "@dsh-shelfry/schema";
import { REPO_ROOT } from "./config.ts";

/**
 * 站长维护的两份收录名单。
 *
 * 文件本身提交进 git（curation/queue.json、curation/blocklist.json）：
 * 站内弹框写入后触发一次部署，名单永久留存、可 diff 追溯，不依赖数据库。
 *
 * 优先级：队列 > 黑名单 —— 同一仓库同时出现在两处时按「要收录」处理，
 * 对应「之前剔除过、现在又想收录」的场景（站内恢复操作也会同时从黑名单移除）。
 */

const FILES = {
  queue: "curation/queue.json",
  blocklist: "curation/blocklist.json",
} as const;

export interface CurationLists {
  /** 待强制收录的仓库（owner/repo，按加入顺序） */
  queue: string[];
  /** 永久剔除的仓库 */
  blocklist: string[];
}

function readList(file: string): string[] {
  const path = resolve(REPO_ROOT, file);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const rows = Array.isArray(parsed) ? parsed : (parsed as { repos?: unknown }).repos;
    if (!Array.isArray(rows)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row !== "string") continue;
      const repo = normalizeGitHubRepo(row);
      if (!repo || seen.has(repo)) continue;
      seen.add(repo);
      out.push(repo);
    }
    return out;
  } catch {
    // 名单只是增强项：格式坏了不该让整轮收录失败
    return [];
  }
}

export function loadCuration(): CurationLists {
  return { queue: readList(FILES.queue), blocklist: readList(FILES.blocklist) };
}
