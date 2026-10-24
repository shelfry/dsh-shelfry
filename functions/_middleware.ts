/**
 * 旧域名 301 到主域名。
 *
 * 站点搬到 https://shelfry.app 后，dsh.shelfry.app 仍作为自定义域挂在 Pages 上，
 * 这里把它的所有请求永久重定向到新域名，保留原路径与查询串：
 * 已收录的详情页、外部链接与搜索结果都能落到对应页面，不会 404。
 *
 * 只拦截旧域名；shelfry.app 与 *.pages.dev 直接放行，不增加额外跳转。
 */

interface Ctx {
  request: Request;
  next: () => Promise<Response>;
}

const LEGACY_HOST = "dsh.shelfry.app";
const CANONICAL_ORIGIN = "https://shelfry.app";

export async function onRequest({ request, next }: Ctx): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== LEGACY_HOST) return next();
  return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 301);
}
