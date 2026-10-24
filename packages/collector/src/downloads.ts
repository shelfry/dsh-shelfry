import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginEntry } from "@dsh-shelfry/schema";
import { DATA_DIR } from "./config.ts";

/**
 * 补全 npm 近一周下载量。
 *
 * 用 npm 的多包端点（一次最多 128 个包名），比逐个查快两个数量级：
 *   https://api.npmjs.org/downloads/point/last-week/react,lodash
 * 命中不了（非 npm 包、私有包、镜像没同步）就保持 null，前端不显示。
 */

const BULK = "https://api.npmjs.org/downloads/point/last-week";
const BATCH = 100;
const TIMEOUT_MS = 15000;
/**
 * npm 的下载量端点不带 User-Agent 会直接 429（官方策略），
 * Node 的 fetch 默认又恰好不带 —— 不显式补上就整片整片地被限流。
 */
const HEADERS = {
  accept: "application/json",
  "user-agent": "dsh-shelfry-collector/1.0 (+https://shelfry.app)",
};
/** 只给星标靠前的条目补下载量：全量补要打上百次请求，必然被限流。 */
const TOP_N = 3000;
/** scoped 包只能逐个查，数量必须封顶，否则一次收录会多几百个请求。 */
const SCOPED_LIMIT = 400;

/**
 * 下载量缓存：`.data/downloads-cache.json`，形如 `{ "包名": { d: 1234, t: "2026-10-21" } }`。
 *
 * 缓存文件跟 catalog.json 一起放在 .data 里（CI 用 actions/cache 持久化），
 * 未过期的包直接回填、不再打 npm —— 否则每天都要重新买一遍 300+ 个 scoped 包的查单。
 * TTL 取 7 天：这个指标本身就是「近一周下载量」，再频繁刷新意义不大。
 */
const CACHE_FILE = resolve(DATA_DIR, "downloads-cache.json");
const TTL_DAYS = 7;

interface CacheRow {
  /** downloads */
  d: number;
  /** 采集日期 YYYY-MM-DD */
  t: string;
}

type Cache = Record<string, CacheRow>;

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

const isFresh = (day: string): boolean => {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < TTL_DAYS * 86_400_000;
};

/** 从安装规格里取出 npm 包名；非 npm 形态（github:/git+/本地路径）返回 null。 */
function npmNameOf(spec: string | null): string | null {
  if (!spec) return null;
  if (spec.startsWith("github:") || /^(git\+|https?:|link:|file:|\.|\/)/.test(spec)) return null;
  // scoped 包 @a/b 的前缀 @ 不是版本分隔符
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = at > 0 ? spec.slice(0, at) : spec;
  return name || null;
}

interface ChunkResult {
  found: Map<string, number>;
  /** true 表示整批被限流/网络失败，这批结果不可信，值得重试。 */
  blocked: boolean;
}

async function fetchChunk(pkgs: string[]): Promise<ChunkResult> {
  const out = new Map<string, number>();
  const path = pkgs.map(encodeURIComponent).join(",");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BULK}/${path}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // 429/403 是限流，等一下再试；其他非 200 直接放弃
      if (res.status === 429 || res.status === 403) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return { found: out, blocked: false };
      const body = (await res.json()) as unknown;
      // 单包时返回对象本身，多包时返回以包名为键的对象；两种形状都要吃得下。
      if (typeof body === "object" && body !== null) {
        const obj = body as Record<string, unknown>;
        if (pkgs.length === 1 && typeof obj["downloads"] === "number") {
          out.set(pkgs[0]!, obj["downloads"] as number);
          return { found: out, blocked: false };
        }
        for (const pkg of pkgs) {
          const v = obj[pkg];
          if (typeof v === "object" && v !== null) {
            const d = (v as Record<string, unknown>)["downloads"];
            if (typeof d === "number") out.set(pkg, d);
          }
        }
      }
      return { found: out, blocked: false };
    } catch {
      // 网络失败：可能只是这一批超时，标记 blocked 让外层再试一次
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return { found: out, blocked: true };
}

type OneResult = { kind: "ok"; downloads: number } | { kind: "notfound" } | { kind: "blocked" };

/** 单包查询：bulk 端点明确拒绝 scoped 包（400），只能逐个查。 */
async function fetchOne(pkg: string): Promise<OneResult> {
  const url = `${BULK}/${encodeURIComponent(pkg)}`;
  // npm 对单包端点有短时频率限制，429 等几秒再来；三次都不行就认了
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      // 包没发布/没数据是常态，不算被限流
      if (res.status === 404) return { kind: "notfound" };
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        return typeof body["downloads"] === "number"
          ? { kind: "ok", downloads: body["downloads"] as number }
          : { kind: "notfound" };
      }
      await new Promise((r) => setTimeout(r, 6000));
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { kind: "blocked" };
}

export interface DownloadsResult {
  /** 最终带上下载量的条目数（含命中缓存的）。 */
  hits: number;
  /** 其中直接回填缓存、没有发请求的包数。 */
  cached: number;
  /** 本轮实际发起查询的包数。 */
  queried: number;
}

/** 就地写入 entry.downloads。 */
export async function resolveDownloads(entries: PluginEntry[]): Promise<DownloadsResult> {
  // 先按 star 取前 TOP_N：榜单和首页首屏都在这个区间，长尾条目本来也无人关心下载量
  const scoped = [...entries].sort((a, b) => b.stars - a.stars).slice(0, TOP_N);
  const byPkg = new Map<string, PluginEntry[]>();
  for (const e of scoped) {
    const pkg = npmNameOf(e.install.packageName);
    if (!pkg) continue;
    const list = byPkg.get(pkg);
    if (list) list.push(e);
    else byPkg.set(pkg, [e]);
  }

  const apply = (pkg: string, downloads: number): number => {
    let n = 0;
    for (const e of byPkg.get(pkg) ?? []) { e.downloads = downloads; n++; }
    return n;
  };

  let hits = 0;
  const all = [...byPkg.keys()];
  const cache = loadCache();
  // 缓存未过期的包直接回填，一次网络请求都不发 —— 这是 CI 时长的主要抓手
  const stale: string[] = [];
  let cached = 0;
  for (const pkg of all) {
    const row = cache[pkg];
    if (row && isFresh(row.t)) {
      hits += apply(pkg, row.d);
      cached++;
    } else {
      stale.push(pkg);
    }
  }

  const remember = (pkg: string, downloads: number): void => {
    hits += apply(pkg, downloads);
    cache[pkg] = { d: downloads, t: new Date().toISOString().slice(0, 10) };
  };

  // scoped 包走单查，其余走批量：单查放后面且限流，避免拖慢整体收录
  const plain = stale.filter((p) => !p.startsWith("@"));
  const scopedPkgs = stale.filter((p) => p.startsWith("@")).slice(0, SCOPED_LIMIT);

  const chunks: string[][] = [];
  for (let i = 0; i < plain.length; i += BATCH) chunks.push(plain.slice(i, i + BATCH));

  // 两轮：第一轮全量，第二轮只补被判为「被限流/超时」的批次
  let pending = chunks;
  for (let wave = 0; wave < 2 && pending.length > 0; wave++) {
    if (wave > 0) await new Promise((r) => setTimeout(r, 5000));
    const retry: string[][] = [];
    for (const chunk of pending) {
      const { found, blocked } = await fetchChunk(chunk);
      for (const [pkg, downloads] of found) remember(pkg, downloads);
      if (blocked) retry.push(chunk);
    }
    pending = retry;
  }

  // scoped 包逐个查；连续 8 个失败说明彻底被限流，止损退出
  let blocked = 0;
  for (const pkg of scopedPkgs) {
    if (blocked >= 8) break;
    const r = await fetchOne(pkg);
    if (r.kind === "ok") {
      blocked = 0;
      remember(pkg, r.downloads);
    } else if (r.kind === "blocked") {
      blocked++;
    }
    // 350ms 的间隔实测能把 429 压到偶发，再快就会整片被拒
    await new Promise((res) => setTimeout(res, 350));
  }

  saveCache(cache);
  return { hits, cached, queried: plain.length + scopedPkgs.length };
}
