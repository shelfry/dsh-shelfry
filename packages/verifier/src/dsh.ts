import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnBounded } from "./runner.ts";

/**
 * 被验证的插件统一装进 `web` profile —— L1 装这里，L2 也 boot 这里，
 * 两层校验必须落在同一个 profile 上才自洽。
 */
export const PROFILE = "web";

/**
 * dsh CLI 定位。
 *
 * 优先 DSH_BIN（CI 里指向本地安装的 @deepseek-ai/dsh 可执行文件），
 * 否则回落到 PATH 上的 `dsh`。验证永远不碰用户的真实 DSH_HOME。
 */
export function resolveDshBin(): string {
  const explicit = process.env.DSH_BIN?.trim();
  return explicit && explicit.length > 0 ? explicit : "dsh";
}

/**
 * 每个条目一份全新 DSH_HOME：实测一次失败的 add 会把该 profile 里已装插件的
 * deps/bundles/lock 一并抹掉，复用长期 profile 会互相污染 ⇒ 强隔离是硬要求。
 * fresh home 也意味着全新 profile，天然满足「绝不复用长期 profile」。
 */
export function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "dsh-verify-"));
}

export function dropHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/** 把 dsh 所在目录注入 PATH，pnpm 才能被 dsh 内部调起。 */
export function childEnv(dshBin: string, home: string): NodeJS.ProcessEnv {
  const binDir = dshBin.includes("/") ? dirname(dshBin) : null;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    CI: "1",
    NO_COLOR: "1",
  };
  if (binDir) env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  return env;
}

/** 读取用于验证的 dsh CLI 版本号（写进验证证据，便于「结论随版本变化」）。 */
export async function readDshVersion(dshBin: string): Promise<string | null> {
  const home = makeHome();
  try {
    const r = await spawnBounded({ bin: dshBin, args: ["--version"], env: childEnv(dshBin, home), timeoutMs: 30_000 });
    const m = r.stdout.trim().match(/\d+\.\d+\.\d+[\w.-]*/);
    return m ? m[0] : null;
  } finally {
    dropHome(home);
  }
}
