import { MIRROR_LITE_URL } from "../config.ts";
import type { RawRecord } from "../normalize.ts";

/**
 * 冷启动镜像源：一次性拉上游 lite 索引做种子。
 *
 * 定位说明（重要）：这是**冷启动种子**，不是长期主源。理由：
 * - 自建 GitHub 检索管道才是数据主权所在（重名、描述、tags 都要我们自己的口径）。
 * - 镜像只用一次把 13k 条种子灌进来，之后靠自有管道增量滚动覆盖。
 * 我们不复用对手的评分、徽章、文案；只取客观字段（id/name/type/stars/pushedAt/tags）。
 */
export async function fetchMirrorRecords(limit: number): Promise<RawRecord[]> {
  const res = await fetch(MIRROR_LITE_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`镜像源拉取失败: HTTP ${res.status}`);
  const data = (await res.json()) as { plugins?: unknown };
  if (!Array.isArray(data.plugins)) throw new Error("镜像源结构异常：缺少 plugins 数组");
  return (data.plugins as RawRecord[]).slice(0, limit);
}
