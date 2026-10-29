/**
 * idmap 查表：先精确匹配，未命中再忽略大小写匹配一次。
 *
 * GitHub 仓库地址不区分大小写，用户手打或外部分享时可能改了大小写；
 * 而数据里的键保留 GitHub 原始大小写，所以只能靠忽略大小写的兜底匹配接住。
 *
 * 入参 map：id → 全局序号；id：待查的 owner/repo。
 * 返回：命中时的**原始键**（保留正确大小写）；未命中返回 null。
 */
export function resolveEntryId(map: Record<string, number>, id: string): string | null {
  if (!id) return null;
  if (map[id] !== undefined) return id;
  const lower = id.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}
