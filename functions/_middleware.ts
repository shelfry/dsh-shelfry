/**
 * 全站中间件：让不存在的路径返回真实的 404 状态码。
 *
 * 站点是单页应用，`_redirects` 里的 `/* /index.html 200` 把所有路径都按 200 交付，
 * 于是 `/about` 这类不存在的地址会变成 soft 404（状态码 200、内容是首页），
 * 搜索引擎会把它们当成有效页面收录。这里在链路最前面做一次判定：
 *
 * 只拦「不带扩展名、也不在站内路由白名单里」的请求，其余一律放行，
 * 所以静态资源、数据切片、收录接口都不会被误伤，详情页直达行为也不变。
 *
 * 拦截时不另外维护一份 404 页面：直接把单页应用的入口以 404 状态码返回，
 * 前端路由会渲染 NotFoundPage，文案与样式只保留一份。
 */

/** 站内真实路由：只有这些无扩展名路径才交给单页应用处理。 */
const APP_ROUTES = [/^\/$/, /^\/top\/?$/, /^\/favorites\/?$/, /^\/submit\/?$/, /^\/p\/[^/]+\/[^/]+\/?$/];

/** 这些前缀一律放行：构建产物与收录接口（/data/ 在上面的缓存分支里单独处理）。 */
const OPEN_PREFIXES = ["/assets/", "/api/"];

/** 只声明用到的方法，避免为 Functions 引入整套 workers-types 与 DOM 类型打架。 */
interface AssetFetcher {
  fetch(input: Request | URL): Promise<Response>;
}

interface Ctx {
  request: Request;
  env: { ASSETS: AssetFetcher };
  next: () => Promise<Response>;
}

export async function onRequest(context: Ctx): Promise<Response> {
  const { request, env, next } = context;
  // 只管读请求，写方法交给后面的处理逻辑
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const { pathname, searchParams } = new URL(request.url);
  // 数据产物：带 ?v=<generatedAt> 的 URL 内容不可变，可以长缓存，
  // 回访用户直接命中浏览器/边缘缓存、不再回源；不带版本的（artifacts.json、
  // 以及旧 bundle 的请求）仍走 _headers 里的 300 秒，保证拿到最新布局。
  if (pathname.startsWith("/data/")) {
    const asset = await env.ASSETS.fetch(request);
    if (!searchParams.has("v")) return asset;
    const headers = new Headers(asset.headers);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  }
  // 带扩展名的（js/css/json/svg/png/txt/xml）与入口页本身一律放行
  if (pathname === "/index.html" || /\.[a-z0-9]+$/i.test(pathname)) return next();
  if (OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next();
  if (APP_ROUTES.some((route) => route.test(pathname))) return next();

  // 其余路径：交付单页应用，但状态码用 404，前端路由会渲染 404 提示
  const asset = await env.ASSETS.fetch(new URL("/index.html", request.url));
  const headers = new Headers(asset.headers);
  // 以后这些路径可能真的被建出来，别让 404 结果留在缓存里
  headers.set("cache-control", "no-store");
  return new Response(asset.body, { status: 404, headers });
}
