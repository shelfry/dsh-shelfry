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
        <Route path="*" element={<HomePage />} />
      </Routes>
      <footer className="site-footer">
        <div className="wrap">
          <span>{siteConfig.siteName} · {siteConfig.license}</span>
          <span>{t("footer.source")}</span>
          <span>{t("footer.updated", { time: meta?.generatedAt.slice(0, 16).replace("T", " ") ?? "—" })}</span>
          {cssTag && <span className="footer-build">CSS {cssTag}</span>}
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
