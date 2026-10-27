import type { PluginEntry } from "@dsh-shelfry/schema";

/**
 * 站长点名收录的条目。
 *
 * 三种来源都代表「人来判断过」：站内收录队列（sources 含 curation）、
 * 清理后归档（curated）、以及用户通过 Issue 主动提交（issue-submission）。
 * 这些条目不该再被自动的质量门槛、生态判定或类型过滤刷掉 ——
 * 手动加进去的，就是明确想要的。
 */

/**
 * 判断一条记录是否属于点名收录。
 *
 * 入参 entry：至少包含 curated 与 sources 两个字段的条目。
 * 返回值：命中任一来源则为 true。
 */
export function isManualPick(entry: Pick<PluginEntry, "curated" | "sources">): boolean {
  if (entry.curated) return true;
  const sources = entry.sources ?? [];
  return sources.includes("curation") || sources.includes("issue-submission");
}
