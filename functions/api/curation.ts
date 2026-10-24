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
  put(key: string, value: string): Promise<void>;
}

interface Ctx {
  request: Request;
  env: Env;
}

type Action = "auth" | "queue" | "block" | "unqueue";

const QUEUE_KEY = "queue";
const BLOCK_KEY = "blocklist";

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

export async function onRequestGet({ env }: Ctx): Promise<Response> {
  if (!env.CURATION) return json({ error: "config", message: "服务端未绑定 CURATION KV" }, 500);
  try {
    const [queue, blocklist] = await Promise.all([readList(env.CURATION, QUEUE_KEY), readList(env.CURATION, BLOCK_KEY)]);
    return json({ queue, blocklist });
  } catch (err) {
    return json({ error: "storage", message: errorText(err) }, 502);
  }
}

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  if (!env.CURATION) return json({ error: "config", message: "服务端未绑定 CURATION KV" }, 500);
  if (!env.CURATION_PASS) return json({ error: "config", message: "服务端未配置 CURATION_PASS" }, 500);

  let body: { action?: unknown; repo?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad-request", message: "请求体不是 JSON" }, 400);
  }

  const action = body.action;
  if (action !== "auth" && action !== "queue" && action !== "block" && action !== "unqueue") {
    return json({ error: "bad-request", message: "未知操作" }, 400);
  }
  // auth 只校验密码，不需要仓库；其余操作必须有合法仓库（在密码校验后统一判）
  const repo = typeof body.repo === "string" ? normalizeGitHubRepo(body.repo) : null;

  const password = typeof body.password === "string" ? body.password : "";
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
    const [queue, blocklist] = await Promise.all([readList(env.CURATION, QUEUE_KEY), readList(env.CURATION, BLOCK_KEY)]);
    // 闸门：密码对了就把当前名单一起返回，省掉一次 GET
    if (action === "auth") return json({ ok: true, queue, blocklist });
    if (!repo) return json({ error: "bad-repo", message: "仓库地址格式不对" }, 400);

    let nextQueue = queue;
    let nextBlock = blocklist;

    if (action === "queue") {
      // 恢复收录：同时从黑名单移除，队列优先于黑名单
      nextQueue = queue.includes(repo) ? queue : [...queue, repo];
      nextBlock = blocklist.filter((id) => id !== repo);
    } else if (action === "block") {
      nextBlock = blocklist.includes(repo) ? blocklist : [...blocklist, repo];
      nextQueue = queue.filter((id) => id !== repo);
    } else {
      nextQueue = queue.filter((id) => id !== repo);
    }

    const writes: Promise<void>[] = [];
    if (!sameList(nextQueue, queue)) writes.push(writeList(env.CURATION, QUEUE_KEY, nextQueue));
    if (!sameList(nextBlock, blocklist)) writes.push(writeList(env.CURATION, BLOCK_KEY, nextBlock));
    await Promise.all(writes);

    return json({ queue: nextQueue, blocklist: nextBlock });
  } catch (err) {
    return json({ error: "storage", message: errorText(err) }, 502);
  }
}
