import { spawn } from "node:child_process";

/**
 * 有界子进程执行器。
 *
 * 为什么不直接用 timeout(1)/gtimeout：本机与 CI 都不保证存在，且 verify 要在
 * 任意平台跑。这里用 spawn + 定时 SIGKILL 自己实现硬超时，保证：
 * - 永不悬挂（L2 是「常驻服务」，必须能主动判成败并杀掉）；
 * - `until` 命中即成功并立刻结束（L2 打印监听地址就等于 host 挂载完成）；
 * - `abort` 命中即确定性失败并立刻结束（如「与 dsh 不兼容」），省去等满超时。
 */
export interface BoundedResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  stdout: string;
  stderr: string;
  /** 是否因超时被 SIGKILL。 */
  timedOut: boolean;
  /** `until` 谓词是否命中（即「提前判定成功」）。 */
  matched: boolean;
}

export interface BoundedOptions {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  /** 命中即视为成功并立刻结束进程。 */
  until?: (stdout: string, stderr: string) => boolean;
  /** 命中即视为确定性失败并立刻结束进程。 */
  abort?: (stdout: string, stderr: string) => boolean;
}

export function spawnBounded(o: BoundedOptions): Promise<BoundedResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(o.bin, o.args, {
      env: o.env,
      cwd: o.cwd ?? "/tmp",
      // stdin 置空：避免子进程等待交互输入而假死。
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null, matched: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, ms: Date.now() - t0, stdout, stderr, timedOut, matched });
    };

    const kill = (): void => {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);

    const inspect = (): void => {
      if (o.until?.(stdout, stderr)) { kill(); finish(null, "SIGKILL", true); return; }
      if (o.abort?.(stdout, stderr)) { kill(); finish(null, "SIGKILL", false); }
    };

    child.stdout?.on("data", (d: Buffer) => { stdout += String(d); inspect(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += String(d); inspect(); });
    child.on("error", (err: Error) => { stderr += String(err); finish(-1, null, false); });
    child.on("close", (code, signal) => finish(code, signal, false));
  });
}
