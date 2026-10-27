import { Link } from "react-router-dom";
import { RobotMark } from "../components/RobotMark";
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
      <section className="empty-state not-found">
        {/* 超大号 404 只做背景水印，压在机器人后面 */}
        <span className="not-found__watermark">404</span>
        <RobotMark size={132} />
        <h1 className="empty-state__title not-found__title">{t("notFound.title")}</h1>
        <p className="empty-state__hint">{t("notFound.desc")}</p>
        <div className="not-found__actions">
          <Link className="btn-browse" to="/">{t("notFound.back")}</Link>
          <Link className="btn-outline" to="/top">{t("notFound.top")}</Link>
        </div>
      </section>
    </main>
  );
}
