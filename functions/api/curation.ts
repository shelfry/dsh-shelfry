import { normalizeGitHubRepo } from "../../packages/schema/src/index.ts";

/**
 * 收录名单读写接口（Cloudflare Pages Function，路由 /api/curation）。
 *
 * 名单以文件形式存在仓库里（curation/queue.json / curation/blocklist.json），
 * 写入走 GitHub Contents API：一次操作一个 commit，永久留存、可 diff 追溯，不引数据库。
 *
 * 鉴权：密码明文不入库，Cloudflare 环境变量里只放 PBKDF2-SHA256 哈希，
 * 请求到达时用 WebCrypto 重算并做等长比较。明文密码不会出现在仓库、日志或响应里。
 *
 * 环境变量：
 *   CURATION_PASS      pbkdf2$<iterations>$<saltHex>$<hashHex>
 *   CURATION_GH_TOKEN  细粒度 PAT，仅本仓库 Contents 读写
 *   CURATION_REPO      可选，默认 shelfry/dsh-shelfry
 */

interface Env {
  CURATION_PASS?: string;
  CURATION_GH_TOKEN?: string;
  CURATION_REPO?: string;
}

interface Ctx {
  request: Request;
  env: Env;
}

type Action = "queue" | "block" | "unqueue";

const BRANCH = "main";
const QUEUE_PATH = "curation/queue.json";
const BLOCK_PATH = "curation/blocklist.json";
const API = "https://api.github.com";
const DEFAULT_REPO = "shelfry/dsh-shelfry";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const repoOf = (env: Env): string => env.CURATION_REPO?.trim() || DEFAULT_REPO;

const ghHeaders = (env: Env): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${env.CURATION_GH_TOKEN}`,
  "user-agent": "dsh-shelfry-curation",
  "x-github-api-version": "2022-11-28",
});

function decodeBase64Utf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function encodeBase64Utf8(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  // 显式分配 ArrayBuffer：WebCrypto 的 BufferSource 不接受 SharedArrayBuffer 的可能性
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
  // 迭代次数过低等于没加密；这里拒绝明显被改小的配置
  if (!Number.isInteger(iterations) || iterations < 100_000) return false;
  const salt = hexToBytes(saltHex);
  if (!salt) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  const hex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(hex, hashHex.toLowerCase());
}

interface StoredList {
  repos: string[];
  sha: string | null;
}

async function readList(env: Env, path: string): Promise<StoredList> {
  const res = await fetch(`${API}/repos/${repoOf(env)}/contents/${path}?ref=${BRANCH}`, { headers: ghHeaders(env) });
  if (res.status === 404) return { repos: [], sha: null };
  if (!res.ok) throw new Error(`GitHub 读取 ${path} 失败：HTTP ${res.status}`);
  const body = (await res.json()) as { content?: string; sha?: string; encoding?: string };
  if (!body.content || body.encoding !== "base64") throw new Error(`GitHub 返回的 ${path} 不是 base64 内容`);
  try {
    const parsed = JSON.parse(decodeBase64Utf8(body.content.replace(/\n/g, ""))) as unknown;
    const rows = Array.isArray(parsed) ? parsed : (parsed as { repos?: unknown }).repos;
    const repos = Array.isArray(rows)
      ? rows
          .filter((v): v is string => typeof v === "string")
          .map((v) => normalizeGitHubRepo(v))
          .filter((v): v is string => !!v)
      : [];
    return { repos: [...new Set(repos)], sha: body.sha ?? null };
  } catch {
    // 文件被手改坏了也照常工作：按空名单读，下一次写入会重建
    return { repos: [], sha: body.sha ?? null };
  }
}

async function writeList(
  env: Env,
  path: string,
  repos: string[],
  sha: string | null,
  message: string,
): Promise<void> {
  const content = `${JSON.stringify({ repos }, null, 2)}\n`;
  const res = await fetch(`${API}/repos/${repoOf(env)}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({
      message,
      content: encodeBase64Utf8(content),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.status === 409) throw new Error("conflict");
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub 写入 ${path} 失败：HTTP ${res.status} ${detail.slice(0, 160)}`);
  }
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export async function onRequestGet({ env }: Ctx): Promise<Response> {
  if (!env.CURATION_GH_TOKEN) return json({ error: "config", message: "服务端未配置 CURATION_GH_TOKEN" }, 500);
  try {
    const [queue, blocklist] = await Promise.all([readList(env, QUEUE_PATH), readList(env, BLOCK_PATH)]);
    return json({ queue: queue.repos, blocklist: blocklist.repos });
  } catch (err) {
    return json({ error: "github", message: errorText(err) }, 502);
  }
}

export async function onRequestPost({ request, env }: Ctx): Promise<Response> {
  if (!env.CURATION_PASS) return json({ error: "config", message: "服务端未配置 CURATION_PASS" }, 500);
  if (!env.CURATION_GH_TOKEN) return json({ error: "config", message: "服务端未配置 CURATION_GH_TOKEN" }, 500);

  let body: { action?: unknown; repo?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad-request", message: "请求体不是 JSON" }, 400);
  }

  const action = body.action;
  if (action !== "queue" && action !== "block" && action !== "unqueue") {
    return json({ error: "bad-request", message: "未知操作" }, 400);
  }
  const repo = typeof body.repo === "string" ? normalizeGitHubRepo(body.repo) : null;
  if (!repo) return json({ error: "bad-repo", message: "仓库地址格式不对" }, 400);

  const password = typeof body.password === "string" ? body.password : "";
  if (!password) return json({ error: "unauthorized", message: "缺少管理密码" }, 401);
  if (!(await verifyPassword(password, env.CURATION_PASS))) {
    return json({ error: "unauthorized", message: "密码不对" }, 401);
  }

  try {
    const [queue, blocklist] = await Promise.all([readList(env, QUEUE_PATH), readList(env, BLOCK_PATH)]);
    let nextQueue = queue.repos;
    let nextBlock = blocklist.repos;

    if (action === "queue") {
      // 恢复收录：同时从黑名单移除，队列优先于黑名单
      nextQueue = queue.repos.includes(repo) ? queue.repos : [...queue.repos, repo];
      nextBlock = blocklist.repos.filter((id) => id !== repo);
    } else if (action === "block") {
      nextBlock = blocklist.repos.includes(repo) ? blocklist.repos : [...blocklist.repos, repo];
      nextQueue = queue.repos.filter((id) => id !== repo);
    } else {
      nextQueue = queue.repos.filter((id) => id !== repo);
    }

    // 只提交真正变化的文件，避免一次操作刷出两个空 commit
    const writes: Promise<void>[] = [];
    if (!sameList(nextQueue, queue.repos)) {
      writes.push(writeList(env, QUEUE_PATH, nextQueue, queue.sha, `curation: ${action} ${repo}`));
    }
    if (!sameList(nextBlock, blocklist.repos)) {
      writes.push(writeList(env, BLOCK_PATH, nextBlock, blocklist.sha, `curation: ${action} ${repo}`));
    }
    await Promise.all(writes);

    return json({ queue: nextQueue, blocklist: nextBlock });
  } catch (err) {
    if (errorText(err) === "conflict") {
      return json({ error: "conflict", message: "名单刚被其他操作改过，请重试" }, 409);
    }
    return json({ error: "github", message: errorText(err) }, 502);
  }
}
