import { Link } from "react-router-dom";
import { useT } from "../lib/i18n";
import { SEO_SITE_NAME, useSeo } from "../lib/seo";

/**
 * 404 页面：路由表兜底。
 *
 * 服务端中间件对未知路径返回真实 404 状态码，但仍交付同一份单页应用，
 * 因此这里只管渲染提示，状态码由 functions/_middleware.ts 负责。
 * 页面标 noindex，避免搜索引擎把不存在的地址当成有效内容收录。
 */
export default function NotFoundPage() {
  const { t } = useT();
  useSeo({
    title: `${t("notFound.title")} · ${SEO_SITE_NAME}`,
    description: t("notFound.desc"),
    path: "/404",
    noindex: true,
  });

  return (
    <main className="wrap">
      <section className="hero">
        <h1>{t("notFound.title")}</h1>
        <p>{t("notFound.desc")}</p>
      </section>
      <div className="empty">
        <Link className="btn-browse" to="/">{t("notFound.back")}</Link>
      </div>
    </main>
  );
}
