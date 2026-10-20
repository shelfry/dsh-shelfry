import { readFileSync } from "node:fs";
import type { PluginEntry, Verification, VerificationLayer } from "@dsh-shelfry/schema";
import { PROFILE, childEnv, dropHome, makeHome } from "./dsh.ts";
import { spawnBounded } from "./runner.ts";

/**
 * L1/L2 两级验证。
 *
 * L1「能装上」= `dsh plugin --profile web add <spec>` 退出 0，**且** --dump-config
 * 的分层输出里真的多出一层。只认 exit 0 是不够的：实测给 profile 装一个普通 npm 包
 * （非 dsh 插件）同样 exit 0，但 profile 里根本没有它的层 —— 这种「装上了但没挂载」
 * 必须判失败，否则站点会推荐一堆装不上的东西。
 *
 * 判「多了一层」而非「层名等于包名」：远程规格（github:owner/repo）装进来的是仓库
 * package.json 里的真名，跟 spec 字面不同，逐字比对必然误判。
 *
 * L2「能加载」= `dsh --profile web --no-open --port 0` 启动后打印
 * `dsh web: http://127.0.0.1:<port>/?token=…` —— host 挂载完成即模块 import 成功。
 * 用 --port 0 让 OS 选空闲端口，避免并发验证抢 3080。失败信号：
 * `is incompatible with dsh` / `StartupError` / 超时前没打印监听地址。
 */
const L1_TIMEOUT_MS = 180_000;
const L2_TIMEOUT_MS = 180_000;
const DUMP_TIMEOUT_MS = 60_000;

const LISTEN_RE = /dsh web:\s*http:\/\/\S+/;
const INCOMPAT_RE = /is incompatible with dsh|StartupError/i;
const LAYER_RE = /^# == (.+)$/gm;

/** dump-config 的分层头集合（`# == <pkg>`），用来做 add 前后的差集。 */
function layerSet(dump: string): Set<string> {
  const out = new Set<string>();
  for (const m of dump.matchAll(LAYER_RE)) {
    const name = m[1]?.trim();
    if (name) out.add(name);
  }
  return out;
}

function tail(s: string, n = 600): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? t.slice(-n) : t;
}

/** 安装失败时额外落盘的诊断日志路径（dsh 自己会给出）。 */
const OP_LOG_RE = /(\S*\.plugin-manager\/logs\/operation-\S*\/pnpm\.log)/;

/** 兜底：从 dsh 的操作日志里挖一句真因，避免把「pnpm 明明装完了」的尾巴当结论。 */
function reasonFromOpLog(text: string): string | null {
  const path = text.match(OP_LOG_RE)?.[1];
  if (!path) return null;
  try {
    const body = readFileSync(path, "utf8");
    const line = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /is incompatible with dsh|ERR_PNPM_|EACCES|ENOTFOUND|rejected/.test(l));
    return line ? tail(line, 300) : null;
  } catch {
    return null;
  }
}

/** 把 pnpm/启动的原始报错压成一句稳定的诊断摘要。 */
function classifyAddError(stderr: string, stdout: string): string {
  const all = `${stderr}\n${stdout}`;
  // 最常见、也最可解释的一种：插件声明的 dsh-tools 版本范围与当前 CLI 不匹配。
  if (/is incompatible with dsh/i.test(all)) {
    const req = all.match(/requirements (\{[^}]*\})/)?.[1];
    return req ? `与当前 dsh 版本不兼容（要求 ${req}）` : "与当前 dsh 版本不兼容";
  }
  if (/ERR_PNPM_FETCH_404|not in the npm registry/.test(all)) return "npm 上不存在该包（404）";
  if (/ERR_PNPM_IGNORED_BUILDS/.test(all)) return "安装被 pnpm 的构建脚本策略拒绝";
  const code = all.match(/[\[(](ERR_PNPM_[A-Z_]+)[\])]/)?.[1];
  if (code) return `pnpm 安装失败：${code}`;
  if (/EACCES|EPERM/.test(all)) return "文件权限问题";
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/.test(all)) return "网络不可达";
  const fromLog = reasonFromOpLog(all);
  if (fromLog) return `dsh 装载失败：${fromLog}`;
  return `安装失败：${tail(all, 240)}`;
}

export interface VerifyOptions {
  dshBin: string;
  /** 是否跑 L2。默认 true；只跑 L1 时结论保持 pending（证据不全，不冒充已验证）。 */
  l2: boolean;
  dshVersion: string | null;
  l1TimeoutMs?: number;
  l2TimeoutMs?: number;
}

/** 验证单个条目：写完即返回完整 Verification（不落盘，由调用方合并回 catalog）。 */
export async function verifyEntry(entry: PluginEntry, opts: VerifyOptions): Promise<Verification> {
  const pkg = entry.install.packageName;
  const checkedAt = new Date().toISOString();
  const diagnostics: string[] = [];
  const base: Verification = {
    status: "pending",
    checkedAt,
    dshVersion: opts.dshVersion,
    profile: PROFILE,
    diagnostics,
  };

  if (entry.install.method !== "pnpm-profile" || !pkg) {
    diagnostics.push("跳过：无规范化 npm 包名（非 pnpm-profile 安装）");
    return { ...base, checkedAt: null };
  }

  const home = makeHome();
  const env = childEnv(opts.dshBin, home);
  try {
    // 基线：装之前 profile 已有的层（干净 home 通常为空，但变化时也算得准）。
    const before = await spawnBounded({
      bin: opts.dshBin,
      args: ["--profile", PROFILE, "--dump-config"],
      env,
      timeoutMs: DUMP_TIMEOUT_MS,
    });
    const baselineLayers = before.code === 0 ? layerSet(before.stdout) : new Set<string>();

    // ---- L1：装得上 ——
    const add = await spawnBounded({
      bin: opts.dshBin,
      args: ["plugin", "--profile", PROFILE, "add", pkg],
      env,
      timeoutMs: opts.l1TimeoutMs ?? L1_TIMEOUT_MS,
    });
    if (add.timedOut) {
      diagnostics.push(tail(add.stderr + add.stdout));
      return { ...base, status: "failed", l1: { ok: false, ms: add.ms, error: `安装超时（${Math.round(add.ms / 1000)}s）` } };
    }
    if (add.code !== 0) {
      diagnostics.push(tail(add.stderr + add.stdout));
      return { ...base, status: "failed", l1: { ok: false, ms: add.ms, error: classifyAddError(add.stderr, add.stdout) } };
    }

    const dump = await spawnBounded({
      bin: opts.dshBin,
      args: ["--profile", PROFILE, "--dump-config"],
      env,
      timeoutMs: DUMP_TIMEOUT_MS,
    });
    const l1Ms = before.ms + add.ms + dump.ms;
    if (dump.code !== 0) {
      diagnostics.push(tail(dump.stderr));
      return { ...base, status: "failed", l1: { ok: false, ms: l1Ms, error: "dump-config 执行失败" } };
    }
    const after = layerSet(dump.stdout);
    const added = [...after].filter((n) => !baselineLayers.has(n));
    if (added.length === 0) {
      diagnostics.push(`dump-config 未多出新层：装的不是 dsh 插件（${tail(add.stdout, 200)}）`);
      return { ...base, status: "failed", l1: { ok: false, ms: l1Ms, error: "装上了但 profile 未挂载该插件" } };
    }
    const l1: VerificationLayer = { ok: true, ms: l1Ms };
    diagnostics.push(`挂载层：${added.join(", ")}`);

    if (!opts.l2) {
      // 只有一层证据：记录但不升级结论。
      return { ...base, status: "pending", l1 };
    }

    // ---- L2：能加载 ——
    // 注意：有的插件会在启动时先做自己的初始化，把 host 的「监听地址」打印推迟很久
    // （实测 @anionex/dsh-vision-toolkit 约 107s），所以 L2 超时必须给到 L1 同量级，
    // 否则会把「能加载只是慢」误判成装不上。
    const boot = await spawnBounded({
      bin: opts.dshBin,
      args: ["--profile", PROFILE, "--no-open", "--port", "0"],
      env,
      timeoutMs: opts.l2TimeoutMs ?? L2_TIMEOUT_MS,
      until: (stdout) => LISTEN_RE.test(stdout),
      abort: (_stdout, stderr) => INCOMPAT_RE.test(stderr),
    });
    if (boot.matched) {
      return { ...base, status: "verified", l1, l2: { ok: true, ms: boot.ms } };
    }

    diagnostics.push(tail(boot.stderr || boot.stdout));
    const err = INCOMPAT_RE.test(boot.stderr)
      ? "与当前 dsh 版本不兼容"
      : boot.timedOut
        ? "启动超时：未打印监听地址"
        : "启动失败：未打印监听地址";
    return { ...base, status: "failed", l1, l2: { ok: false, ms: boot.ms, error: err } };
  } finally {
    dropHome(home);
  }
}
