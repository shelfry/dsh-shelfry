import type { PluginEntry, ScoreBreakdown, Verification } from "@dsh-shelfry/schema";

/**
 * 六维综合分：加权几何平均。
 * 权重：可装性 40 / 维护活跃 20 / 实用度 15 / 生态热度 10 / 便捷度 10 / 信号质量 5。
 *
 * 几何平均的好处：任一维趋近 0 会把总分显著拉低，避免「生态热度高但装不上」的条目霸榜。
 */

const WEIGHTS = {
  installable: 40,
  maintenance: 20,
  utility: 15,
  popularity: 10,
  convenience: 10,
  signal: 5,
} as const;

/** 可装性半衰回归常数：14 天。验证结果随时间回归中性 0.5，避免旧结论被永久信任。 */
const INSTALL_HALF_LIFE_DAYS = 14;
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

/** 可装性：verified=1 / pending=0.5 / failed=0，并按 14 天半衰回归中性 0.5。 */
export function installableDimension(v: Verification, now: number): number {
  const base = v.status === "verified" ? 1 : v.status === "failed" ? 0 : 0.5;
  const age = ageDays(v.checkedAt, now) ?? INSTALL_HALF_LIFE_DAYS;
  const decay = 0.5 ** (age / INSTALL_HALF_LIFE_DAYS);
  // pending 没有实证信号，恒为中性。
  if (v.status === "pending") return 0.5;
  return clamp01(0.5 + (base - 0.5) * decay);
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

/** 信号质量：独立来源数 + 是否声明兼容范围 + 描述长度。 */
export function signalDimension(e: PluginEntry): number {
  let n = 0;
  n += clamp01(e.sources.length / 3) * 0.5;
  if (e.install.enginesDsh) n += 0.25;
  if (e.description.length >= 60) n += 0.25;
  return clamp01(n);
}

export function scoreEntry(e: PluginEntry, now: number): ScoreBreakdown {
  const dims = {
    installable: installableDimension(e.verification, now),
    maintenance: maintenanceDimension(e, now),
    utility: utilityDimension(e),
    popularity: popularityDimension(e),
    convenience: convenienceDimension(e),
    signal: signalDimension(e),
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
