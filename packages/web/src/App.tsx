import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import type { CatalogMeta } from "@dsh-shelfry/schema";
import { loadMeta, siteConfig } from "./lib/data";
import HomePage, { SiteHeader } from "./pages/HomePage";
import DetailPage from "./pages/DetailPage";
import TopPage from "./pages/TopPage";
import SubmitPage from "./pages/SubmitPage";

/**
 * 应用外壳：头部 + 路由 + 页脚。
 *
 * 路由：列表（/）、详情（/p/:id）、榜单（/top）。用 hash 路由是因为 GitHub Pages
 * 没有服务端 rewrite —— 用 history 路由刷新 /p/xxx 会直接 404。
 */
export default function App() {
  const [meta, setMeta] = useState<CatalogMeta | null>(null);

  useEffect(() => {
    loadMeta().then(setMeta).catch(() => { /* 头部统计取不到不影响主体 */ });
  }, []);

  return (
    <>
      <SiteHeader meta={meta} />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/top" element={<TopPage />} />
        <Route path="/submit" element={<SubmitPage />} />
        {/* id 形如 owner/repo，含斜杠，必须用通配段接住 */}
        <Route path="/p/*" element={<DetailPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
      <footer className="site-footer">
        <div className="wrap">
          <span>{siteConfig.siteName} · {siteConfig.license}</span>
          <span>收录数据来自 GitHub，每日自动刷新</span>
          <span>数据 {meta?.generatedAt.slice(0, 16).replace("T", " ") ?? "—"} 更新</span>
          {/* 没拿到 token 或检索失败时收录走镜像兜底，数据可能滞后，别让用户以为它是新鲜的 */}
          {meta?.collectSource?.label === "mirror" && (
            <span className="footer-warn" title={meta.collectSource.reason ?? "未启用 GitHub 检索"}>
              数据源：镜像兜底
            </span>
          )}
        </div>
      </footer>
    </>
  );
}
