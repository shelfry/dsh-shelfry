import type { PluginEntry, ScoreBreakdown } from "@dsh-shelfry/schema";

/**
 * 综合分：加权几何平均。
 * 权重：生态热度 35 / 维护活跃 35 / 实用度 20 / 便捷度 10。
 *
 * 为什么不含「可装性」：站点已停掉安装验证，用户看不到任何验证信号，
 * 再让一个不可见的维度占 40% 权重，排名就会显得没有依据。
 * 现在的口径全部由用户可见的信息构成 —— 有星、有最近提交、有简介与安装方式。
 */
const WEIGHTS = {
  popularity: 35,
  maintenance: 35,
  utility: 20,
  convenience: 10,
} as const;

/** 维护活跃半衰：180 天。 */
const MAINTENANCE_HALF_LIFE_DAYS = 180;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const EPS = 0.01;

function ageDays(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 86_400_000);
}

/** 维护活跃：最近 push 越新越高。 */
export function maintenanceDimension(e: PluginEntry, now: number): number {
  const age = ageDays(e.pushedAt, now);
  if (age === null) return 0.3;
  return clamp01(0.5 ** (age / MAINTENANCE_HALF_LIFE_DAYS));
}

/** 实用度：描述信息完整度（有简介、有标签、有主页、有中文简介）。 */
export function utilityDimension(e: PluginEntry): number {
  let n = 0;
  if (e.description.trim().length >= 20) n += 0.4;
  if (e.tags.length >= 2) n += 0.2;
  if (e.homepage) n += 0.2;
  if (e.descriptionZh) n += 0.2;
  return clamp01(n);
}

/** 生态热度：star 数对数缩放（1000 星 ≈ 满分）。 */
export function popularityDimension(e: PluginEntry): number {
  return clamp01(Math.log10(e.stars + 1) / Math.log10(1001));
}

/** 便捷度：一条命令可装、无需额外配置、有中文说明。 */
export function convenienceDimension(e: PluginEntry): number {
  let n = 0;
  if (e.install.command) n += 0.4;
  if (!e.install.needsConfig) n += 0.3;
  if (!e.install.risky) n += 0.2;
  if (e.install.enginesDsh) n += 0.1;
  return clamp01(n);
}

export function scoreEntry(e: PluginEntry, now: number): ScoreBreakdown {
  const dims = {
    maintenance: maintenanceDimension(e, now),
    utility: utilityDimension(e),
    popularity: popularityDimension(e),
    convenience: convenienceDimension(e),
  } as const;

  let logSum = 0;
  let weightSum = 0;
  for (const key of Object.keys(dims) as Array<keyof typeof dims>) {
    const w = WEIGHTS[key];
    logSum += w * Math.log(Math.max(EPS, dims[key]));
    weightSum += w;
  }
  const geo = Math.exp(logSum / weightSum);

  return {
    ...dims,
    total: Math.round(clamp01(geo) * 1000) / 10, // 0..100，一位小数
  };
}
