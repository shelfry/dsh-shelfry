/**
 * 全站数据契约。
 *
 * 设计原则：
 * - schema 是唯一真相源，collector / web 都从这里取类型。
 * - 条目只描述「上游仓库是什么样」，不承载安装验证结论 —— 站点不提供验证能力，
 *   排名口径全部由用户可见的信息构成（星数、最近提交、简介完整度、安装方式）。
 * - 数据不进 git：这些类型只描述「构建期产物」的形状，不描述条目内容。
 */

/** 插件形态。cordis-plugin 走 pnpm-profile 安装，skill 走 skills-add。 */
export type PluginType = "cordis-plugin" | "skill" | "unknown";

/** 安装方式。 */
export type InstallMethod = "pnpm-profile" | "skills-add" | "manual" | "unknown";

export interface InstallSpec {
  method: InstallMethod;
  /** 由我方生成的规范化安装命令（不直接照搬上游文案）。 */
  command: string | null;
  /** npm 包名（可能带 scope）。 */
  packageName: string | null;
  /** 上游声明的 dsh 兼容范围（engines.dsh）。 */
  enginesDsh: string | null;
  needsConfig: boolean;
  /** 需要写配置/授权才能用 —— 提升「便捷度」扣分。 */
  risky: boolean;
}

/** 综合分，各维 0..1，total 为加权几何平均 ×100。 */
export interface ScoreBreakdown {
  maintenance: number;
  utility: number;
  popularity: number;
  convenience: number;
  total: number;
}

/** 完整条目（详情页 + 验证输入）。 */
export interface PluginEntry {
  /** 主键：owner/repo。 */
  id: string;
  name: string;
  fullName: string;
  type: PluginType;
  stars: number;
  description: string;
  descriptionZh: string | null;
  tags: string[];
  curated: boolean;
  homepage: string | null;
  /** 上游仓库最后 push 时间（ISO）。 */
  pushedAt: string | null;
  /** 插件自身发布版本（取自 npm registry 的 latest）。取不到为 null。 */
  version: string | null;
  /** npm 近一周下载量。非 npm 包或取不到为 null。 */
  downloads: number | null;
  install: InstallSpec;
  score: ScoreBreakdown;
  /** 汇聚来源标识，用于溯源。 */
  sources: string[];
  /** 我方首次收录时间，merge 时保持不变。 */
  firstSeenAt: string;
  /** 我方最近一次刷新时间。 */
  updatedAt: string;
}

/** 浏览切片（首屏用）：短键名压体积，全站 13k 条也要足够小。 */
export interface LiteEntry {
  /** id */ i: string;
  /** name */ n: string;
  /** type */ t: PluginType;
  /** stars */ s: number;
  /** curated 0/1 */ c: 0 | 1;
  /** pushedAt */ p: string | null;
  /** score.total */ sc: number;
  /** engines.dsh */ g: string | null;
  /** version（插件自身版本） */ vr: string | null;
  /** npm 近一周下载量 */ dl: number | null;
  /** tags */ tg: string[];
  /** descriptionZh ?? description */ d: string;
}

export interface CatalogMeta {
  schemaVersion: number;
  generatedAt: string;
  /** 条目总数。 */
  total: number;
  /** 每种类型的条目数（首页筛选直接用它显示规模）。 */
  types: Record<string, number>;
  /** 数据来源清单。 */
  sources: string[];
  /**
   * 本轮收录实际用的检索源。
   * mirror 表示没拿到 GitHub token 或检索失败、走了镜像兜底 —— 站上要让用户知道数据可能滞后。
   */
  collectSource?: { label: "github" | "mirror"; reason?: string };
}

/** 拼接产物索引。 */
export interface ArtifactIndex {
  schemaVersion: number;
  generatedAt: string;
  /** 明细文件分片：每片包含的 id 区间描述 + 文件名。 */
  shards: Array<{ file: string; from: number; to: number; count: number }>;
  /** 倒排索引分片：token 哈希取模落片。 */
  index: { shardCount: number; shards: Array<{ id: number; file: string; tokens: number }> };
  /** 浏览分页文件：首屏只拉第 0 页。 */
  pages: { size: number; count: number; filePattern: string };
  /** 中文意图词典文件（零 token 自建）。 */
  intents: string | null;
}

export const SCHEMA_VERSION = 1;

/**
 * 倒排索引分片数：固定 128 片，token 按哈希落片。
 *
 * 为什么不用「前缀切片」：实测按 2 字符前缀切会产生 1.3 万个分片文件，静态托管与部署都不划算。
 * 固定片数下，一次查询只会命中「查询词所在的 1~N 片」，既保证首屏只拉小片，又让文件数有界。
 */
export const INDEX_SHARD_COUNT = 128;

/** FNV-1a 32bit：客户端与服务端必须用同一实现，故放在 schema 里共用。 */
export function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function indexShardId(token: string): number {
  return hashToken(token) % INDEX_SHARD_COUNT;
}


/**
 * 从 InstallMethod 推导我方规范化安装命令。
 *
 * 已实测（dsh 0.2.1-rc.2）：
 * - `dsh plugin --profile <name> <pnpm-args>` 的 `--profile` 是**必填**，缺了就报
 *   `required option '--profile <name>' not specified`。所以命令必须带 profile，
 *   且 profile 名因用户而异 ⇒ 用 `<profile>` 占位而非硬编码某个 profile。
 * - **不存在** `dsh skill add`：`dsh skill` 会被当成名为 "skill" 的 profile 而报错。
 *   skill 类内容由 skill provider（如 dsh-skill-filesystem）扫描目录/插件提供，
 *   没有等价的 CLI 安装动作 ⇒ 返回 null，由 UI 说明，不杜撰命令。
 */
export function defaultInstallCommand(method: InstallMethod, packageName: string | null): string | null {
  if (!packageName) return null;
  switch (method) {
    case "pnpm-profile":
      return `dsh plugin --profile <profile> add ${packageName}`;
    default:
      return null;
  }
}

/**
 * 轻量结构校验（不引第三方依赖，保持管道零负担）。
 * 返回空数组代表通过。
 */
export function validateEntry(input: unknown): string[] {
  const errs: string[] = [];
  if (typeof input !== "object" || input === null) return ["entry 不是对象"];
  const e = input as Record<string, unknown>;
  const req = (k: string, t: string) => {
    if (typeof e[k] !== t) errs.push(`${k} 应为 ${t}，实际 ${typeof e[k]}`);
  };
  req("id", "string");
  req("name", "string");
  req("fullName", "string");
  req("type", "string");
  req("description", "string");
  if (!Array.isArray(e.tags)) errs.push("tags 应为数组");
  if (typeof e.score !== "object" || e.score === null) errs.push("score 缺失");
  else {
    const s = e.score as Record<string, unknown>;
    if (typeof s.total !== "number" || !Number.isFinite(s.total)) errs.push("score.total 应为有限数字");
  }
  return errs;
}

export function toLiteEntry(e: PluginEntry): LiteEntry {
  return {
    i: e.id,
    n: e.name,
    t: e.type,
    s: e.stars,
    c: e.curated ? 1 : 0,
    p: e.pushedAt,
    sc: e.score.total,
    g: e.install.enginesDsh,
    vr: e.version,
    dl: e.downloads,
    tg: e.tags,
    d: e.descriptionZh ?? e.description,
  };
}
