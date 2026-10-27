import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import type { CatalogMeta } from "@dsh-shelfry/schema";
import { loadMeta, siteConfig } from "./lib/data";
import { useT } from "./lib/i18n";
import HomePage, { SiteHeader } from "./pages/HomePage";
import DetailPage from "./pages/DetailPage";
import TopPage from "./pages/TopPage";
import SubmitPage from "./pages/SubmitPage";
import FavoritesPage from "./pages/FavoritesPage";
import NotFoundPage from "./pages/NotFoundPage";

/**
 * 页脚更新时间统一按北京时间（UTC+8）展示。
 * 产物里的 generatedAt 是 UTC 的 ISO 串，直接截取会让访客看到早 8 小时的时间。
 */
function beijingTime(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * 应用外壳：头部 + 路由 + 页脚。
 *
 * 路由：列表（/）、详情（/p/:id）、榜单（/top）、收藏（/favorites）、提交（/submit）。
 * 用 hash 路由是因为 GitHub Pages 没有服务端 rewrite —— 用 history 路由刷新 /p/xxx 会直接 404。
 */
export default function App() {
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const { t } = useT();

  // 页脚展示当前实际加载的样式表哈希：手机上刷新后一眼就能核对是否拿到了最新构建
  const [cssTag] = useState(() => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.getAttribute("href") ?? "";
    return href.match(/index-([A-Za-z0-9_-]+)\.css/)?.[1] ?? "";
  });

  useEffect(() => {
    loadMeta().then(setMeta).catch(() => { /* 头部统计取不到不影响主体 */ });
  }, []);

  return (
    <>
      <SiteHeader meta={meta} />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/top" element={<TopPage />} />
        <Route path="/favorites" element={<FavoritesPage />} />
        <Route path="/submit" element={<SubmitPage />} />
        {/* id 形如 owner/repo，含斜杠，必须用通配段接住 */}
        <Route path="/p/*" element={<DetailPage />} />
        {/* 其余路径给 404 提示，不再回落首页：服务端同时会返回真实 404 状态码 */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <footer className="site-footer">
        <div className="wrap">
          <span>{siteConfig.siteName} · {siteConfig.license}</span>
          <span>{t("footer.source")}</span>
          <span>{t("footer.updated", { time: beijingTime(meta?.generatedAt) })}</span>
          {/* 页脚只展示版本号；悬停可看构建哈希，需要精确核对时仍能对上产物文件名 */}
          <span className="footer-build" title={cssTag ? `构建哈希 ${cssTag}` : undefined}>{__BUILD_VERSION__}</span>
          {/* 没拿到 token 或检索失败时收录走镜像兜底，数据可能滞后，别让用户以为它是新鲜的 */}
          {meta?.collectSource?.label === "mirror" && (
            <span className="footer-warn" title={meta.collectSource.reason ?? t("footer.mirrorReason")}>
              {t("footer.mirror")}
            </span>
          )}
        </div>
      </footer>
    </>
  );
}
