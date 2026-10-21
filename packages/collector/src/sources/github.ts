import type { RawRecord } from "../normalize.ts";

/**
 * 自建管道主源：GitHub 仓库检索。
 *
 * 为什么必须鉴权：Search API 未鉴权仅 10 次/分，鉴权 30 次/分；滚动全量抓取没有 token 跑不完。
 * 因此 GITHUB_TOKEN 是硬必需（本地跑可临时 export，CI 里用 secrets）。
 *
 * 当前阶段只做「发现 + 客观字段」；engines.dsh、dsh 清单字段等需要读仓库内 package.json，
 * 属于后续的清单补全阶段，不在本文件职责内。
 */

const SEARCH_ENDPOINT = "https://api.github.com/search/repositories";

/**
 * Search API 每次查询最多只能翻到前 1000 条（10 页 × 100 条），
 * 第 11 页起直接返回 422「Only the first 1000 search results are available」。
 * 之前按 COLLECT_LIMIT=20000 算页数，第一次跑就撞 422 整源降级，必须在这里钳死。
 */
const MAX_PAGES = 10;

/**
 * 检索词：每个词最多只能拿到 1000 条（Search API 上限），所以靠「多词覆盖」扩总量。
 * 实测命中数（2026-10）：topic:dsh-plugin 21345 / topic:deepseek-harness 17001 /
 * dsh in:name 48277 —— 话题词精准但天花板低，名字词杂但能捞到大片长尾，
 * 因此两类都保留，杂质由 isDshRelated 过滤。
 */
export const DEFAULT_QUERIES = [
  // 话题词：上游自己打标签的，准确度最高
  "topic:dsh-plugin",
  "topic:dsh-plugins",
  "topic:dsh",
  "topic:deepseek-harness",
  "topic:cordis-plugin",
  "topic:dsh-skill",
  "topic:deepseek-plugin",
  // 名字词：捞话题没打全的插件
  "dsh-plugin in:name",
  "dsh-plugins in:name",
  "dsh-skill in:name",
  "cordis-plugin in:name",
  "dsh in:name",
  "deepseek-harness in:name",
  "dsh-theme in:name",
];

/** Search API 鉴权后是 30 次/分，实测超过就 403；留一点余量做匀速。 */
const MIN_INTERVAL_MS = 2100;
let lastRequestAt = 0;

/**
 * GitHub 的话题检索很脏：`topic:dsh-plugin` 首页就混着 35 万星的二进制分析工具、
 * nocobase、Wegent 这类拿话题刷曝光的大项目（实测 100 条里 13 条与 DSH 无关）。
 * 只靠话题判断会被它们带进来，所以只看仓库名与描述 —— 话题是刷出来的，名字和
 * 简介不容易撒谎。代价是漏掉少数「名字不带 dsh、简介也没提」的真插件，
 * 这类可以靠站内提交入口补录，比把 nocobase 当插件展示可接受得多。
 */
const RELEVANT = /(^|[^a-z0-9])dsh([^a-z0-9]|$)|dsh[-_]?market|cordis|deepseek[-_ ]?harness/i;

export function isDshRelated(repo: GhRepo): boolean {
  return RELEVANT.test(`${repo.full_name} ${repo.description ?? ""}`);
}

export interface GithubSearchOptions {
  token: string;
  queries?: string[];
  /** 每个检索词最多取多少条（每页 100）。 */
  perQueryLimit?: number;
}

interface GhRepo {
  id: number;
  full_name: string;
  name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  pushed_at: string | null;
  homepage: string | null;
  topics?: string[];
  topic?: string;
}

function toRaw(repo: GhRepo): RawRecord {
  const topics = [...(repo.topics ?? []), ...(repo.topic ? [repo.topic] : [])];
  return {
    id: repo.full_name,
    // 不写 type：检索结果没有类型信息，写死 cordis-plugin 会把上一轮已知的 skill
    // 在 merge 时覆盖掉（实测 skill 从 240 掉到 170）。
    name: repo.name,
    fullName: repo.full_name,
    stars: repo.stargazers_count,
    description: repo.description ?? "",
    descriptionZh: null,
    tags: topics,
    curated: false,
    homepage: repo.homepage ?? repo.html_url,
    pushedAt: repo.pushed_at,
    install: {
      method: "pnpm-profile",
      needsConfig: false,
      risky: false,
      // 检索阶段没读 README，不知道上游真正的安装规格；拿仓库名拼命令必然装不上，
      // 所以这里只留空，等原文安装说明的补全阶段再填。
      commands: [],
    },
    sources: ["github-search"],
  };
}

/**
 * 拉一页搜索结果。返回 null 表示这个检索词已经翻到底（422：超出 1000 条上限）。
 * 顺带把 total_count 带出来，用真实总量决定要翻几页 —— 否则 14 个词全按 10 页跑
 * 就是 140 次请求，既慢又容易触发 403。
 */
async function searchPage(
  query: string,
  page: number,
  token: string,
): Promise<{ items: GhRepo[]; total: number } | null> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100&page=${page}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "dsh-shelfry-collector",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    throw new Error(`GitHub 限流（${res.status}），reset=${reset ?? "unknown"}`);
  }
  // 首页就 422 说明是请求被拒（token/参数问题），不能当成「没有结果」吞掉；
  // 只有翻页到第 2 页及以后撞 422，才当作超出 1000 条上限、这个词到底了。
  if (res.status === 422 && page > 1) return null;
  if (!res.ok) {
    // 把响应体带出来：422/401 的真实原因只有 GitHub 自己的 message 说得清
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* 读不到就只报状态码 */ }
    throw new Error(`GitHub 检索失败: HTTP ${res.status} ${detail}`);
  }
  const body = (await res.json()) as { items?: GhRepo[]; total_count?: number };
  return { items: body.items ?? [], total: body.total_count ?? 0 };
}

/**
 * 按仓库全名精确补录（一次性修复用）。
 *
 * 检索有 1000 条硬上限，历史条目一旦被误剔，很难靠检索自然回流。
 * CI 里通过 `workflow_dispatch` 的 rescue 输入把名单传进来，逐个取仓库详情后
 * 交给同一条处理链路，跑完即恢复，不需要把数据写进仓库。
 */
export async function fetchReposByNames(names: string[], token: string): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, names.length) }, async () => {
    while (cursor < names.length) {
      const fullName = names[cursor++]!;
      try {
        const res = await fetch(`https://api.github.com/repos/${fullName}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "dsh-shelfry-collector",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) continue;
        out.push(toRaw((await res.json()) as GhRepo));
      } catch {
        // 单个仓库失败不影响整体补录
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** 按多个检索词抓取，按 fullName 去重，并过滤掉话题检索混进来的无关仓库。 */
export async function fetchGithubRecords(opts: GithubSearchOptions): Promise<RawRecord[]> {
  const queries = opts.queries ?? DEFAULT_QUERIES;
  const perQueryLimit = opts.perQueryLimit ?? 100;
  const seen = new Map<string, RawRecord>();
  const hardCap = Math.min(MAX_PAGES, Math.max(1, Math.ceil(perQueryLimit / 100)));

  for (const q of queries) {
    let found = 0;
    let kept = 0;
    let pages = hardCap;
    for (let page = 1; page <= pages; page++) {
      const res = await searchPage(q, page, opts.token);
      if (res === null) break;
      if (page === 1) {
        // Search API 最多只给前 1000 条，别为拿不到的结果白跑请求
        pages = Math.min(hardCap, Math.max(1, Math.ceil(Math.min(res.total, 1000) / 100)));
      }
      for (const repo of res.items) {
        found++;
        if (!isDshRelated(repo) || seen.has(repo.full_name)) continue;
        seen.set(repo.full_name, toRaw(repo));
        kept++;
      }
      if (res.items.length < 100) break;
    }
    console.log(`[collector] 检索词「${q}」命中 ${found} 条，相关 ${kept} 条`);
  }
  // 一条都没抓到说明检索整体没生效：宁可抛错让 auto 源降级，也不要返回空集把数据悄悄停更
  if (seen.size === 0) throw new Error("GitHub 检索结果为 0 条");
  return [...seen.values()];
}
