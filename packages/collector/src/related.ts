import type { LiteEntry } from "@dsh-shelfry/schema";

/**
 * 详情页推荐预生成：把「同作者 + 相似」的计算从浏览器搬到构建期。
 *
 * 原先详情页为了算 8 条推荐要下载全量切片（约 1 MB br）；现在构建期算好，
 * 每条只存 8 个 id，前端再按 id 去分页文件取卡片，和收藏页同一套取数方式。
 *
 * 相似度口径与前端旧实现完全一致：
 *   权重 = 标签重合数 × 3 + (类型相同 ? 1 : 0)，权重 ≥ 3 才入选，
 *   按权重降序、同权重按星数降序取前 4；权重与星数都相同则按切片原顺序（同旧实现的稳定排序）。
 * 目标侧标签按展示口径剔除通用标签后去重；候选侧沿用原始数组，
 * 同一标签重复出现时重复计分（旧实现是 filter 计数，这里必须同口径，否则排序会漂）。
 *
 * 性能：不做全量两两比较。先用「范围 + 标签」建倒排桶，只遍历与目标共享标签的候选；
 * 计数用下标数组 + 时间戳复用，避免每条都分配对象。14k 条实测 1 秒级。
 */

/** 每条推荐分片承载多少条目的推荐。 */
export const RELATED_SHARD_SIZE = 100;
/** 同作者最多取几条。 */
export const AUTHOR_TAKE = 4;
/** 相似推荐最多取几条。 */
export const SIMILAR_TAKE = 4;

/** 卡片上没信息量的通用标签，口径与 web 端 meaningfulTags 保持一致。 */
const NOISE_TAGS = new Set([
  "cordis-plugin",
  "deepseek-harness",
  "deepseek-harness-plugin",
  "deepseek-harness-plugins",
  "dsh-plugin",
  "dsh-plugins",
  "dsh",
  "plugin",
  "plugins",
]);

/** 单条目的推荐 id 列表：a = 同作者，s = 相似。 */
export interface RelatedLists {
  a: string[];
  s: string[];
}

/** 条目 id 的 owner 段（GitHub 侧不区分大小写，统一小写比较）。 */
const ownerOf = (id: string): string => id.slice(0, id.indexOf("/")).toLowerCase();

/** 条目所属范围：插件与工具互不推荐，避免跨范围串味。 */
const scopeOf = (v: LiteEntry): string => (v.ec === "external" ? "tool" : "plugin");

/**
 * 为全量切片计算推荐关系。
 *
 * 入参 lite：全量浏览切片。出参 id → { 同作者 id、相似 id }。
 */
export function buildRelated(lite: LiteEntry[]): Map<string, RelatedLists> {
  const n = lite.length;

  // 一次性把后续要反复读的字段摊平成数组，循环里不再做属性查找与字符串拼接
  const ids = new Array<string>(n);
  const scopes = new Array<string>(n);
  const owners = new Array<string>(n);
  const types = new Array<string>(n);
  const stars = new Int32Array(n);
  const tags = new Array<string[]>(n);
  /** 候选侧标签重复出现时多出来的次数（键已小写）：旧实现按数组 filter 计数，重复会重复计分 */
  const extra = new Array<Map<string, number> | null>(n);

  const ownerGroups = new Map<string, number[]>();
  const tagBuckets = new Map<string, number[]>();

  for (let i = 0; i < n; i += 1) {
    const v = lite[i]!;
    const id = v.i;
    const scope = scopeOf(v);
    ids[i] = id;
    scopes[i] = scope;
    types[i] = v.t;
    stars[i] = v.s;
    const owner = ownerOf(id);
    owners[i] = owner;

    // 目标侧标签小写去重并剔除通用标签；候选侧同一标签的重复次数单独记下
    // （数组通常只有几个标签，includes 比建 Map 便宜得多）
    const lower: string[] = [];
    let dup: Map<string, number> | null = null;
    for (const raw of v.tg) {
      const low = raw.toLowerCase();
      if (lower.includes(low)) {
        if (!NOISE_TAGS.has(low)) {
          if (!dup) dup = new Map();
          dup.set(low, (dup.get(low) ?? 0) + 1);
        }
        continue;
      }
      lower.push(low);
    }
    tags[i] = lower.filter((t) => !NOISE_TAGS.has(t));
    extra[i] = dup;

    const ownerKey = `${scope}|${owner}`;
    const og = ownerGroups.get(ownerKey);
    if (og) og.push(i);
    else ownerGroups.set(ownerKey, [i]);

    for (const tag of lower) {
      const tagKey = `${scope}|${tag}`;
      const tb = tagBuckets.get(tagKey);
      if (tb) tb.push(i);
      else tagBuckets.set(tagKey, [i]);
    }
  }

  // 同作者候选按星数降序预排一次，每个 owner 组只排一次
  for (const group of ownerGroups.values()) {
    group.sort((a, b) => stars[b]! - stars[a]!);
  }

  const stamp = new Uint32Array(n);
  const weights = new Int32Array(n);
  const out = new Map<string, RelatedLists>();

  for (let i = 0; i < n; i += 1) {
    const scope = scopes[i]!;
    const ownerGroup = ownerGroups.get(`${scope}|${owners[i]!}`) ?? [];
    const author: string[] = [];
    for (const j of ownerGroup) {
      if (j === i) continue;
      author.push(ids[j]!);
      if (author.length === AUTHOR_TAKE) break;
    }

    const mark = i + 1;
    const candidates: number[] = [];
    for (const tag of tags[i]!) {
      const bucket = tagBuckets.get(`${scope}|${tag}`);
      if (!bucket) continue;
      for (const j of bucket) {
        if (j === i) continue;
        // 候选侧该标签重复出现时按次数累计，与旧实现 filter 计数口径一致
        const add = 3 * (1 + (extra[j]?.get(tag) ?? 0));
        if (stamp[j] !== mark) {
          stamp[j] = mark;
          weights[j] = add;
          candidates.push(j);
        } else {
          weights[j] = weights[j]! + add;
        }
      }
    }

    // 权重与星数相同则按切片原顺序，与旧实现的稳定排序结果一致
    candidates.sort((a, b) => {
      const wa = weights[a]! + (types[a] === types[i] ? 1 : 0);
      const wb = weights[b]! + (types[b] === types[i] ? 1 : 0);
      return wb - wa || stars[b]! - stars[a]! || a - b;
    });

    const similar: string[] = [];
    for (const j of candidates) {
      const weight = weights[j]! + (types[j] === types[i] ? 1 : 0);
      if (weight < 3) continue;
      similar.push(ids[j]!);
      if (similar.length === SIMILAR_TAKE) break;
    }

    out.set(ids[i]!, { a: author, s: similar });
  }
  return out;
}
