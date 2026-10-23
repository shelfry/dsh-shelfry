import { useEffect, useMemo, useState } from "react";
import type { CatalogMeta, LiteEntry } from "@dsh-shelfry/schema";
import { Link } from "react-router-dom";
import { loadLite, loadMeta } from "../lib/data";
import { Avatar, formatDownloads, formatStars, relativeTime, versionLabel } from "../components/PluginCard";
import { detailPath } from "../lib/data";
import { useT } from "../lib/i18n";
import { SEO_SITE_NAME, useSeo } from "../lib/seo";

/**
 * 榜单页（#/top）：星标 / 最近更新 / 精选。
 *
 * 数据全部来自浏览切片 lite —— 首页本来就要拉它做检索，这里复用同一份，不额外加产物。
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
  const [lite, setLite] = useState<LiteEntry[] | null>(null);
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
        const [l, m] = await Promise.all([loadLite(), loadMeta()]);
        setLite(l);
        setMeta(m);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const rows = useMemo(() => {
    if (!lite) return [];
    // 榜单只排 DSH 插件：独立工具不是插件，混进来会把整个榜的语义打乱
    const list = lite.filter((v) => v.ec !== "external");
    if (tab === "stars") list.sort((a, b) => b.s - a.s || b.sc - a.sc);
    else if (tab === "recent") list.sort((a, b) => (b.p ?? "").localeCompare(a.p ?? "") || b.s - a.s);
    else list.sort((a, b) => b.sc - a.sc || b.s - a.s);
    return list.slice(0, TOP_N);
  }, [lite, tab]);

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

      {!lite ? (
        <div className="empty">{t("top.loading")}</div>
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
