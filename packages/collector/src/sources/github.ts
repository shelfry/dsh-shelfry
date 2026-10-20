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

/** 检索词：话题标签为主，配合仓库名匹配，先去重再交下游。 */
export const DEFAULT_QUERIES = [
  "topic:dsh-plugin",
  "topic:deepseek-harness",
  "topic:dsh-plugins",
  "dsh-plugin in:name",
];

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
    type: "cordis-plugin",
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
      commands: [`dsh plugin add ${repo.name}`],
    },
    sources: ["github-search"],
  };
}

async function searchPage(query: string, page: number, token: string): Promise<GhRepo[]> {
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
  if (!res.ok) throw new Error(`GitHub 检索失败: HTTP ${res.status}`);
  const body = (await res.json()) as { items?: GhRepo[] };
  return body.items ?? [];
}

/** 按多个检索词抓取，按 fullName 去重。 */
export async function fetchGithubRecords(opts: GithubSearchOptions): Promise<RawRecord[]> {
  const queries = opts.queries ?? DEFAULT_QUERIES;
  const perQueryLimit = opts.perQueryLimit ?? 100;
  const seen = new Map<string, RawRecord>();
  const pages = Math.max(1, Math.ceil(perQueryLimit / 100));

  for (const q of queries) {
    for (let page = 1; page <= pages; page++) {
      const items = await searchPage(q, page, opts.token);
      for (const repo of items) {
        if (!seen.has(repo.full_name)) seen.set(repo.full_name, toRaw(repo));
      }
      if (items.length < 100) break;
    }
  }
  return [...seen.values()];
}
