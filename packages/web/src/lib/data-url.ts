/**
 * 数据文件 URL 拼接。
 *
 * 数据产物之间强耦合（idmap 序号 ↔ artifacts.shards ↔ 各分片），部署后若
 * 新旧产物混用，序号会落到分片之外，详情页就会误报「仓库已下架」。
 * 给同一次会话的所有请求带上产物版本（artifacts.generatedAt），
 * 新旧版本就不会拼在一起：版本变了 URL 就变，浏览器不会拿旧缓存顶上。
 *
 * 入参 base：站点根路径（import.meta.env.BASE_URL）；path：data 下的相对路径；
 * version：产物版本，空串表示不带版本。
 * 返回：拼好的完整路径。
 */
export function dataUrl(base: string, path: string, version: string): string {
  const root = `${base}data/${path}`;
  return version ? `${root}?v=${encodeURIComponent(version)}` : root;
}
