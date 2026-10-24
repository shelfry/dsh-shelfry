import { normalizeGitHubRepo } from "../../packages/schema/src/index.ts";

/**
 * 收录名单读写接口（Cloudflare Pages Function，路由 /api/curation）。
 *
 * 名单存在 Cloudflare KV 里，站内弹框写入不需要任何 GitHub 令牌：
 * CI 每次构建前把 KV 里的名单同步回 curation/queue.json、curation/blocklist.json
 * 并提交进 git，所以「永久文档」仍然是仓库里的那两个文件，KV 只是写入缓冲。
 *
 * 鉴权：密码明文不入库，环境变量里只放 PBKDF2-SHA256 哈希，
 * 请求到达时用 WebCrypto 重算并做等长比较。
 *
 * 环境变量 / 绑定：
 *   CURATION       KV namespace，键 queue / blocklist
 *   CURATION_PASS  pbkdf2$<iterations>$<saltHex>$<hashHex>
 */

interface Env {
  CURATION?: KVNamespaceLike;
  CURATION_PASS?: string;
}

/** 只声明用到的两个方法，避免为 Functions 引入整套 workers-types 与 DOM 类型打架。 */
interface KVNamespaceLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface Ctx {
  request: Request;
  env: Env;
}

type Action = "auth" | "queue" | "block" | "unqueue" | "submit" | "approve" | "dismiss" | "prune";

/** 访客在提交页发来的待确认申请；只有输密码后才返回给前端。 */
interface PendingItem {
  repo: string;
  install?: string;
  category?: string;
  summary?: string;
  at: string;
}

const QUEUE_KEY = "queue";
const BLOCK_KEY = "blocklist";
const PENDING_KEY = "pending";
/** 已收录归档：从队列清理出来的仓库挪到这里，仍然会被强制收录，避免掉出站点 */
const CURATED_KEY = "curated";
/** 同一 IP 每小时最多提交几次，挡住最简单的刷列表 */
const SUBMIT_LIMIT = 10;
const SUBMIT_TTL = 3600;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iterationsRaw, saltHex, hashHex] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterationsRaw || !saltHex || !hashHex) return false;
  const iterations = Number(iterationsRaw);
  // Workers 的 WebCrypto 把 PBKDF2 迭代上限定在 10 万，超过直接抛错；
  // 低于 5 万则迭代强度不足，视为配置被改坏
  if (!Number.isInteger(iterations) || iterations < 50_000 || iterations > 100_000) return false;
  const salt = hexToBytes(saltHex);
  if (!salt) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  const hex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(hex, hashHex.toLowerCase());
}

/** 读一份名单；KV 里没写过时返回空数组（首次部署由 CI 用仓库文件初始化）。 */
async function readList(kv: KVNamespaceLike, key: string): Promise<string[]> {
  const rows = await kv.get(key, "json");
  const list = Array.isArray(rows) ? rows : (rows as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const row of list) {
    if (typeof row !== "string") continue;
    const repo = normalizeGitHubRepo(row);
    if (repo && !out.includes(repo)) out.push(repo);
  }
  return out;
}

const writeList = (kv: KVNamespaceLike, key: string, repos: string[]): Promise<void> =>
  kv.put(key, JSON.stringify({ repos }));

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** 读待确认列表；仓库地址统一规整，坏数据直接丢掉。 */
async function readPending(kv: KVNamespaceLike): Promise<PendingItem[]> {
  const rows = await kv.get(PENDING_KEY, "json");
  const list = Array.isArray(rows) ? rows : (rows as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return [];
  const out: PendingItem[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const item = (row ?? {}) as Partial<PendingItem>;
    const repo = typeof item.repo === "string" ? normalizeGitHubRepo(item.repo) : null;
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    const entry: PendingItem = { repo, at: typeof item.at === "string" ? item.at : "" };
    if (typeof item.install === "string" && item.install) entry.install = item.install;
    if (typeof item.category === "string" && item.category) entry.category = item.category;
    if (typeof item.summary === "string" && item.summary) entry.summary = item.summary;
    out.push(entry);
  }
  return out;
}

const writePending = (kv: KVNamespaceLike, items: PendingItem[]): Promise<void> =>
  kv.put(PENDING_KEY, JSON.stringify({ items }));

const samePending = (a: PendingItem[], b: PendingItem[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 简单的按 IP 限流：KV 里存一小时内的提交次数，过期自动清掉。 */
async function overRateLimit(kv: KVNamespaceLike, request: Request): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `rate:${ip}`;
  const current = await kv.get(key, "json");
  const count = typeof current === "number" ? current : 0;
  if (count >= SUBMIT_LIMIT) return true;
  await kv.put(key, String(count + 1), { expirationTtl: SUBMIT_TTL });
  return false;
}

export async function onRequestGet({ env }: Ctx): Promise<Response> {
  if (!env.CURATION) return json({ error: "config", message: "服务端未绑定 CURATION KV" }, 500);
  try {
    const [queue, blocklist, curated] = await Promise.all([
      readList(env.CURATION, QUEUE_KEY),
      readList(env.CURATION, BLOCK_KEY),
      readList(env.CURATION, CURATED_KEY),
    ]);
    return json({ queue, blocklist, curated });
  } catch (err) {
    return json({ error: "storage", message: errorText(err) }, 502);
  }
}

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  if (!env.CURATION) return json({ error: "config", message: "服务端未绑定 CURATION KV" }, 500);

  let body: {
    action?: unknown;
    repo?: unknown;
    repos?: unknown;
    password?: unknown;
    install?: unknown;
    category?: unknown;
    summary?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad-request", message: "请求体不是 JSON" }, 400);
  }

  const action = body.action;
  if (
    action !== "auth" &&
    action !== "queue" &&
    action !== "block" &&
    action !== "unqueue" &&
    action !== "submit" &&
    action !== "approve" &&
    action !== "dismiss" &&
    action !== "prune"
  ) {
    return json({ error: "bad-request", message: "未知操作" }, 400);
  }
  // auth 只校验密码，不需要仓库；其余操作必须有合法仓库（密码校验后统一判）
  const repo = typeof body.repo === "string" ? normalizeGitHubRepo(body.repo) : null;

  // 访客提交：不需要密码，只进待确认列表；重复提交视为更新，不重复占位
  if (action === "submit") {
    if (!repo) return json({ error: "bad-repo", message: "仓库地址格式不对" }, 400);
    try {
      if (await overRateLimit(env.CURATION, request)) {
        return json({ error: "rate-limit", message: "提交太频繁，请稍后再试" }, 429);
      }
      const [queue, blocklist, pending] = await Promise.all([
        readList(env.CURATION, QUEUE_KEY),
        readList(env.CURATION, BLOCK_KEY),
        readPending(env.CURATION),
      ]);
      if (blocklist.includes(repo)) {
        return json({ ok: false, error: "blocked", message: "该仓库已被站长剔除，暂不接受提交" }, 403);
      }
      if (queue.includes(repo)) {
        return json({ ok: true, status: "queued", message: "该仓库已在收录队列" });
      }
      const item: PendingItem = {
        repo,
        install: clean(body.install, 200),
        category: clean(body.category, 80),
        summary: clean(body.summary, 200),
        at: new Date().toISOString(),
      };
      if (!item.install) delete item.install;
      if (!item.category) delete item.category;
      if (!item.summary) delete item.summary;
      // 新提交排在最前，同时去掉重复项
      const nextPending = [item, ...pending.filter((row) => row.repo !== repo)];
      await writePending(env.CURATION, nextPending);
      return json({ ok: true, status: "pending", message: "已提交，等待站长确认收录" });
    } catch (err) {
      return json({ error: "storage", message: errorText(err) }, 502);
    }
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!env.CURATION_PASS) return json({ error: "config", message: "服务端未配置 CURATION_PASS" }, 500);
  if (!password) return json({ error: "unauthorized", message: "缺少管理密码" }, 401);
  let ok = false;
  try {
    ok = await verifyPassword(password, env.CURATION_PASS);
  } catch {
    return json({ error: "crypto", message: "密码校验不可用，请检查 CURATION_PASS 配置" }, 500);
  }
  if (!ok) {
    return json({ error: "unauthorized", message: "密码不对" }, 401);
  }

  try {
    const [queue, blocklist, pending, curated] = await Promise.all([
      readList(env.CURATION, QUEUE_KEY),
      readList(env.CURATION, BLOCK_KEY),
      readPending(env.CURATION),
      readList(env.CURATION, CURATED_KEY),
    ]);
    // 闸门：密码对了就把当前名单一起返回，省掉一次 GET
    if (action === "auth") return json({ ok: true, queue, blocklist, pending });

    // 批量清理已收录的队列条目：挪进 curated 归档，仍然强制收录，不会掉出站点
    if (action === "prune") {
      const targets = new Set<string>();
      for (const row of Array.isArray(body.repos) ? body.repos : []) {
        const id = typeof row === "string" ? normalizeGitHubRepo(row) : null;
        if (id) targets.add(id);
      }
      if (targets.size === 0) return json({ error: "bad-request", message: "没有需要清理的仓库" }, 400);
      const nextQueue = queue.filter((id) => !targets.has(id));
      const nextCurated = [...curated];
      for (const id of targets) if (!nextCurated.includes(id)) nextCurated.push(id);
      const writes: Promise<void>[] = [];
      if (!sameList(nextQueue, queue)) writes.push(writeList(env.CURATION, QUEUE_KEY, nextQueue));
      if (!sameList(nextCurated, curated)) writes.push(writeList(env.CURATION, CURATED_KEY, nextCurated));
      await Promise.all(writes);
      return json({ queue: nextQueue, blocklist, pending });
    }

    if (!repo) return json({ error: "bad-repo", message: "仓库地址格式不对" }, 400);

    let nextQueue = queue;
    let nextBlock = blocklist;
    let nextPending = pending;
    let nextCurated = curated;

    if (action === "queue" || action === "approve") {
      // 恢复/确认收录：同时从黑名单、待确认与归档里移除，队列优先于黑名单
      nextQueue = queue.includes(repo) ? queue : [...queue, repo];
      nextBlock = blocklist.filter((id) => id !== repo);
      nextPending = pending.filter((row) => row.repo !== repo);
      nextCurated = curated.filter((id) => id !== repo);
    } else if (action === "block") {
      nextBlock = blocklist.includes(repo) ? blocklist : [...blocklist, repo];
      nextQueue = queue.filter((id) => id !== repo);
      nextPending = pending.filter((row) => row.repo !== repo);
      nextCurated = curated.filter((id) => id !== repo);
    } else if (action === "dismiss") {
      // 忽略只移出待确认，不拉黑，之后仍可再次提交
      nextPending = pending.filter((row) => row.repo !== repo);
    } else {
      nextQueue = queue.filter((id) => id !== repo);
    }

    const writes: Promise<void>[] = [];
    if (!sameList(nextQueue, queue)) writes.push(writeList(env.CURATION, QUEUE_KEY, nextQueue));
    if (!sameList(nextBlock, blocklist)) writes.push(writeList(env.CURATION, BLOCK_KEY, nextBlock));
    if (!sameList(nextCurated, curated)) writes.push(writeList(env.CURATION, CURATED_KEY, nextCurated));
    if (!samePending(nextPending, pending)) writes.push(writePending(env.CURATION, nextPending));
    await Promise.all(writes);

    return json({ queue: nextQueue, blocklist: nextBlock, pending: nextPending });
  } catch (err) {
    return json({ error: "storage", message: errorText(err) }, 502);
  }
}
