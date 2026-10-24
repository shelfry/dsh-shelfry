import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginEntry } from "@dsh-shelfry/schema";
import { DATA_DIR } from "./config.ts";
import { fetchGithubText, README_NAMES } from "./evidence.ts";

/**
 * README 摘要补全。
 *
 * 有一批条目上游没写简介、也没打标签，卡片右下角就只能空着。这里给它们读一次
 * README，取首段有效文字存成短摘要，前端分类规则在「仓库名 + 简介」都判不出来时
 * 再用它兜底。只处理「无简介」的条目，避免为已有简介的条目白花请求。
 *
 * 结论按天缓存，仓库有新提交才重读；缓存文件跟其它采集缓存一起放在 .data/，
 * CI 通过 actions/cache 复用，日常构建基本不再打 GitHub。
 */

const CACHE_FILE = resolve(DATA_DIR, "readme-summary.json");
const TTL_DAYS = 30;
const CONCURRENCY = 16;
const MAX_CHARS = 160;
/** 单轮最多读多少条：首次跑覆盖全部无简介条目，之后每天只处理新增的。 */
const DEFAULT_LIMIT = 2000;
const DAY = 86_400_000;

interface CacheRow {
  /** summary：没读出可用文字时省略，避免重复探测 */
  s?: string;
  /** 探测日期 YYYY-MM-DD */
  t: string;
  /** 探测时仓库的 pushedAt，有新提交后旧结论作废 */
  p: string | null;
}

type Cache = Record<string, CacheRow>;

export interface ReadmeSummaryResult {
  /** 本轮实际读 README 的条目数 */
  probed: number;
  /** 命中缓存的条目数 */
  cached: number;
  /** 真正补出摘要的条目数 */
  filled: number;
}

const today = (): string => new Date().toISOString().slice(0, 10);

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

const isFresh = (row: CacheRow, entry: PluginEntry): boolean => {
  const at = Date.parse(`${row.t}T00:00:00Z`);
  if (!Number.isFinite(at) || Date.now() - at > TTL_DAYS * DAY) return false;
  return (row.p ?? null) === (entry.pushedAt ?? null);
};

/** 去掉徽章、图片、HTML、代码块与表格，只留人读的正文。 */
function stripMarkdown(body: string): string[] {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("|") && !/^(-{3,}|={3,})$/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, "")
        .replace(/^>\s*/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]/g, "")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * 取首段有效文字：至少要像一句话，跳过标题式短句、许可证声明、纯链接。
 * README 开头常是仓库名做成的大标题，它不含任何分类信息，先剔掉。
 */
export function summarizeReadme(body: string, repoName: string): string | null {
  const lines = stripMarkdown(body);
  const noise =
    /^(license|mit|apache|badge|contributing|changelog|table of contents|目录|许可证|版本|当前|最新|release|version)/i;
  const pointer = /见\s*(README|英文|中文)|see\s+readme|英文版见/i;
  const versionOnly = /^v?\d+(\.\d+)+/i;
  const skeleton = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  const repoKey = skeleton(repoName);
  for (const line of lines) {
    if (line.length < 20 || !/[\p{L}\u4e00-\u9fff]/u.test(line)) continue;
    if (noise.test(line) || pointer.test(line) || versionOnly.test(line)) continue;
    const key = skeleton(line);
    if (key === repoKey || key.startsWith(repoKey)) continue;
    // 短标题（3 个词以内且汉字很少）通常是项目名，不是介绍
    const cjk = (line.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const words = (line.match(/[a-z0-9]+/gi) ?? []).length;
    if (cjk < 6 && words < 4) continue;
    const cut = line.slice(0, MAX_CHARS);
    const end = Math.max(...["。", "！", "？", ". ", "; ", "；", "，", "、"].map((p) => cut.lastIndexOf(p)));
    const summary = (end >= 40 ? cut.slice(0, end + 1) : cut).replace(/[，、；：,;:\s]+$/, "").trim();
    return summary || null;
  }
  return null;
}

/** 读 README 首段；主 README 读不出有效文字时再看中文变体，最多 3 个文件。 */
async function fetchSummary(owner: string, repo: string): Promise<string | null> {
  for (const name of README_NAMES.slice(0, 3)) {
    const body = await fetchGithubText(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${name}`);
    if (!body) continue;
    const summary = summarizeReadme(body, repo);
    if (summary) return summary;
  }
  return null;
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

/** 给无简介条目补 README 摘要（写回 entry.readmeSummary）。 */
export async function resolveReadmeSummaries(
  entries: PluginEntry[],
  options: { limit?: number } = {},
): Promise<ReadmeSummaryResult> {
  const limit = options.limit ?? Number(process.env.README_SUMMARY_LIMIT ?? DEFAULT_LIMIT);
  const cache = loadCache();
  const candidates = entries.filter((e) => !e.description).sort((a, b) => b.stars - a.stars);
  const result: ReadmeSummaryResult = { probed: 0, cached: 0, filled: 0 };
  let budget = limit;
  let dirty = false;

  await mapLimit(candidates, CONCURRENCY, async (e) => {
    const cachedRow = cache[e.id];
    let row: CacheRow | null = null;

    if (cachedRow && isFresh(cachedRow, e)) {
      row = cachedRow;
      result.cached++;
    } else {
      if (budget <= 0) return;
      budget--;
      result.probed++;
      const [owner, repo] = e.id.split("/", 2);
      if (!owner || !repo) return;
      try {
        const summary = await fetchSummary(owner, repo);
        row = summary ? { s: summary, t: today(), p: e.pushedAt ?? null } : { t: today(), p: e.pushedAt ?? null };
        cache[e.id] = row;
        dirty = true;
      } catch {
        return;
      }
    }

    if (!row?.s) return;
    e.readmeSummary = row.s;
    result.filled++;
  });

  if (dirty) saveCache(cache);
  return result;
}
