import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginEntry } from "@dsh-shelfry/schema";

import { DATA_DIR } from "./config.ts";
import { README_NAMES } from "./evidence.ts";
import { isManualPick } from "./manual-pick.ts";
import { stripMarkdown } from "./readme.ts";

/**
 * 空 README 门槛：把「README 空 + 0 星」的仓库清出插件列表。
 *
 * 早期检索规则偏宽，捞进来一批没有 README、也没有星标的仓库，它们不是可分发的插件，
 * 只是仓库名里恰好带 dsh。判定按权重分两级：
 *   1. README 空（文件缺失 / 只有标题 / 纯链接 / 徽章）→ 直接剔除，安装命令不作豁免；
 *   2. README 有正文 → 即使 0 星也保留，新插件天然 0 星，正文与安装命令才是可用信号。
 * 人工点名收录（curated / 站内队列 / Issue 提交）不参与清退。
 *
 * 探测结论按天缓存，仓库有新提交后旧结论作废；unknown（网络错、限流）不落缓存，
 * 下一轮重试 —— 单次网络失败不该导致误删。
 */

const CACHE_FILE = resolve(DATA_DIR, "readme-presence.json");
const TTL_DAYS = 30;
const CONCURRENCY = 12;
/** 单轮最多探测多少条；0 表示不限（一次性审计用），日常构建用 2000 兜住。 */
const DEFAULT_LIMIT = 2000;
/** 正文行至少多少字符才算有内容：标题、纯链接、徽章都够不到这个长度。 */
const MIN_BODY_CHARS = 20;
const TIMEOUT_MS = 10_000;
const RETRIES = 2;
const DAY = 86_400_000;

export type ReadmeState = "body" | "blank" | "missing" | "unknown";

interface CacheRow {
  /** 只存确定结论：unknown 不落缓存，下一轮重试 */
  v: "body" | "blank" | "missing";
  /** 探测日期 YYYY-MM-DD */
  t: string;
  /** 探测时仓库的 pushedAt，有新提交后旧结论作废 */
  p: string | null;
}

type Cache = Record<string, CacheRow>;

export interface EmptyReadmeResult {
  /** 本轮实际发出探测的条目数 */
  probed: number;
  /** 命中缓存的条目数 */
  cached: number;
  /** 无法判定、本轮保留的条目数 */
  unknown: number;
  /** README 文件缺失的条目数 */
  missing: number;
  /** README 存在但读不出正文的条目数 */
  blank: number;
  /** 确认 README 为空的条目（待删除） */
  empty: PluginEntry[];
  /** empty 中已经有安装命令的子集，供人工复核 */
  emptyWithCommand: PluginEntry[];
}

export interface EmptyReadmeOptions {
  /** 单轮探测上限；0 表示不限 */
  limit?: number;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 判定 README 正文是否「有内容」：至少一行像人写的文字，标题与链接都过不了这一关。 */
export function classifyReadmeBody(body: string): ReadmeState {
  const lines = stripMarkdown(body);
  const hasBody = lines.some(
    (line) => line.length >= MIN_BODY_CHARS && /[\p{L}\u4e00-\u9fff]/u.test(line),
  );
  return hasBody ? "body" : "blank";
}

/** 把 HTTP 结果映射成三态：404 才算缺失，其余异常一律 unknown（不可删除）。 */
export function readmeStateFrom(status: number, body: string | null): ReadmeState {
  if (status === 404) return "missing";
  if (status >= 200 && status < 300) return body ? classifyReadmeBody(body) : "blank";
  return "unknown";
}

/** 缓存是否还有效：超期或仓库有新提交都算过期。 */
export function isPresenceFresh(row: CacheRow, pushedAt: string | null): boolean {
  const at = Date.parse(`${row.t}T00:00:00Z`);
  if (!Number.isFinite(at) || Date.now() - at > TTL_DAYS * DAY) return false;
  return (row.p ?? null) === (pushedAt ?? null);
}

/** 0 星 + DSH 插件 + 非人工收录，才是清退候选。 */
export function isPurgeCandidate(e: PluginEntry): boolean {
  if (e.stars !== 0) return false;
  if (e.ecosystem !== "dsh") return false;
  // 站长点名收录的（队列 / 归档 / Issue）一律不清退，和生态判定用同一套判据
  if (isManualPick(e)) return false;
  return true;
}

/** 请求单个 README；404 直接返回，5xx/429/网络错按可重试处理，重试用尽返回 null。 */
async function requestReadme(url: string): Promise<{ status: number; body: string | null } | null> {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) return { status: 404, body: null };
      if (res.ok) return { status: res.status, body: await res.text() };
      if (res.status < 500 && res.status !== 429) return { status: res.status, body: null };
    } catch {
      // 网络错误与超时都按可重试处理
    }
    if (attempt < RETRIES) await sleep(400 * (attempt + 1));
  }
  return null;
}

/** 依次试 5 个 README 文件名；全部 404 才算缺失，读不到正文返回 blank。 */
async function readReadme(owner: string, repo: string): Promise<ReadmeState> {
  for (const name of README_NAMES) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${name}`;
    const res = await requestReadme(url);
    if (!res) return "unknown";
    const state = readmeStateFrom(res.status, res.body);
    if (state === "missing") continue;
    return state;
  }
  return "missing";
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

/** 固定并发的简易任务池：不用第三方库，和 readme.ts 里的实现保持一致。 */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

/**
 * 探测候选条目的 README 状态。
 *
 * @param entries 全量条目（内部自行筛出 0 星 DSH 插件）
 * @param options limit：单轮探测上限，0 表示不限
 * @returns 待清退条目与探测统计
 */
export async function resolveEmptyReadme(
  entries: PluginEntry[],
  options: EmptyReadmeOptions = {},
): Promise<EmptyReadmeResult> {
  const limit = options.limit ?? Number(process.env.README_GATE_LIMIT ?? DEFAULT_LIMIT);
  const cache = loadCache();
  const candidates = entries.filter(isPurgeCandidate);
  const result: EmptyReadmeResult = {
    probed: 0,
    cached: 0,
    unknown: 0,
    missing: 0,
    blank: 0,
    empty: [],
    emptyWithCommand: [],
  };
  let budget = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  let dirty = false;

  await eachLimit(candidates, CONCURRENCY, async (e) => {
    let state: ReadmeState;
    const row = cache[e.id];
    if (row && isPresenceFresh(row, e.pushedAt ?? null)) {
      state = row.v;
      result.cached++;
    } else {
      if (budget <= 0) return;
      budget--;
      result.probed++;
      const [owner, repo] = e.id.split("/", 2);
      if (!owner || !repo) {
        result.unknown++;
        return;
      }
      state = await readReadme(owner, repo);
      if (state === "unknown") {
        result.unknown++;
        return;
      }
      cache[e.id] = { v: state, t: today(), p: e.pushedAt ?? null };
      dirty = true;
    }

    if (state === "body") return;
    if (state === "missing") result.missing++;
    else result.blank++;
    result.empty.push(e);
    if (e.install.command) result.emptyWithCommand.push(e);
  });

  if (dirty) saveCache(cache);
  result.empty.sort((a, b) => a.stars - b.stars || a.id.localeCompare(b.id));
  result.emptyWithCommand.sort((a, b) => a.stars - b.stars || a.id.localeCompare(b.id));
  return result;
}
