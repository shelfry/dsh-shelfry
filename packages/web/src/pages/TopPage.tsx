import { useEffect, useState } from "react";
import type { CatalogMeta } from "@dsh-shelfry/schema";
import { Link } from "react-router-dom";
import { loadTop, loadMeta, type TopLists } from "../lib/data";
import { Avatar, formatDownloads, formatStars, relativeTime, versionLabel } from "../components/PluginCard";
import { RankSkeleton } from "../components/CardSkeleton";
import { detailPath } from "../lib/data";
import { useT } from "../lib/i18n";
import { SEO_SITE_NAME, useSeo } from "../lib/seo";

/**
 * 榜单页（#/top）：星标 / 最近更新 / 精选。
 *
 * 数据来自构建期预生成的 top.json（约 17 KB br），不再拉全量浏览切片：
 * 榜单只要 150 条，为一个页面下载 1 MB 不划算。排序在构建期完成，这里直接取。
 */

type Tab = "stars" | "recent" | "score";

const TOP_N = 50;

const TAB_KEY: Record<Tab, { label: "top.tab.stars" | "top.tab.recent" | "top.tab.score"; hint: "top.hint.stars" | "top.hint.recent" | "top.hint.score" }> = {
  stars: { label: "top.tab.stars", hint: "top.hint.stars" },
  recent: { label: "top.tab.recent", hint: "top.hint.recent" },
  score: { label: "top.tab.score", hint: "top.hint.score" },
};

const TAB_ORDER: Tab[] = ["stars", "recent", "score"];

export default function TopPage() {
  const [top, setTop] = useState<TopLists | null>(null);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [tab, setTab] = useState<Tab>("stars");
  const [error, setError] = useState<string | null>(null);
  const { t } = useT();
  useSeo({
    title: `${t("nav.top")} · ${SEO_SITE_NAME}`,
    description: "DSH 插件与工具榜单：按星标、最近更新与综合分排序，每日自动刷新。",
    path: "/top",
  });

  useEffect(() => {
    (async () => {
      try {
        const [list, m] = await Promise.all([loadTop(), loadMeta()]);
        setTop(list);
        setMeta(m);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // 三个页签的排序在构建期已经排好，这里只取对应切片，不再重复排序
  const rows = top ? top[tab] : [];

  if (error) {
    return <main className="wrap"><div className="empty">{t("common.dataError", { msg: error })}</div></main>;
  }

  return (
    <main className="wrap top-page">
      <section className="hero top-hero">
        <h1>{t("top.title")}</h1>
        <p>{t("top.sub")}</p>
      </section>

      <section className="filters">
        <div className="filter-row">
          {TAB_ORDER.map((key) => (
            <button key={key} className="chip" aria-pressed={tab === key} onClick={() => setTab(key)}>
              {t(TAB_KEY[key].label)}
            </button>
          ))}
          {meta && <span className="filter-label" style={{ marginLeft: "auto" }}>{t("top.meta", { n: meta.total - (meta.external ?? 0), top: TOP_N })}</span>}
        </div>
        <p className="hint" style={{ marginTop: 10 }}>{t(TAB_KEY[tab].hint)}</p>
      </section>

      {!top ? (
        <RankSkeleton count={TOP_N} />
      ) : rows.length === 0 ? (
        <div className="empty">{t("top.empty")}</div>
      ) : (
        <ol className="rank-list">
          {rows.map((v, i) => (
            <li key={v.i} className="rank-row">
              <span className={`rank-no${i < 3 ? " rank-top" : ""}`}>{i + 1}</span>
              <div className="rank-main">
                <Link className="rank-name" to={detailPath(v.i)}>{v.n}</Link>
                <div className="rank-meta">
                  <Avatar id={v.i} />
                  <span>{v.i}</span>
                  {versionLabel(v.vr) && <span className="detail-ver">{versionLabel(v.vr)}</span>}
                </div>
                <p className="rank-desc">{v.d || t("common.noDesc")}</p>
              </div>
              <div className="rank-nums">
                <span className="rank-num"><b>★ {formatStars(v.s)}</b></span>
                <span className="rank-num">↓ {formatDownloads(v.dl) ?? "—"}</span>
                <span className="rank-num rank-num-dim">{relativeTime(v.p, t)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
