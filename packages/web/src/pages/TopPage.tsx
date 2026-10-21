import { useEffect, useMemo, useState } from "react";
import type { CatalogMeta, LiteEntry } from "@dsh-shelfry/schema";
import { Link } from "react-router-dom";
import { loadLite, loadMeta, siteConfig } from "../lib/data";
import { Avatar, formatDownloads, formatStars, relativeTime, versionLabel } from "../components/PluginCard";
import { detailPath } from "../lib/data";

/**
 * 榜单页（#/top）：星标 / 最近更新 / 精选。
 *
 * 数据全部来自浏览切片 lite —— 首页本来就要拉它做检索，这里复用同一份，不额外加产物。
 */

type Tab = "stars" | "recent" | "score";

const TABS: Array<{ key: Tab; label: string; hint: string }> = [
  { key: "stars", label: "星标榜", hint: "按 GitHub star 数排序，反映生态关注度" },
  { key: "recent", label: "活跃榜", hint: "按仓库最近提交时间排序，反映还在维护" },
  { key: "score", label: "综合榜", hint: "按综合推荐分排序：生态热度、维护活跃、信息完整、上手便捷四项加权" },
];

const TOP_N = 50;

export default function TopPage() {
  const [lite, setLite] = useState<LiteEntry[] | null>(null);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [tab, setTab] = useState<Tab>("stars");
  const [error, setError] = useState<string | null>(null);

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
    const list = [...lite];
    if (tab === "stars") list.sort((a, b) => b.s - a.s || b.sc - a.sc);
    else if (tab === "recent") list.sort((a, b) => (b.p ?? "").localeCompare(a.p ?? "") || b.s - a.s);
    else list.sort((a, b) => b.sc - a.sc || b.s - a.s);
    return list.slice(0, TOP_N);
  }, [lite, tab]);

  if (error) {
    return <main className="wrap"><div className="empty">数据加载失败：{error}</div></main>;
  }

  return (
    <main className="wrap top-page">
      <section className="hero top-hero">
        <h1>榜单</h1>
        <p>{siteConfig.siteNameZh}的三种排名口径，全部基于可核对的上游信息。</p>
      </section>

      <section className="filters">
        <div className="filter-row">
          {TABS.map((t) => (
            <button key={t.key} className="chip" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
          {meta && <span className="filter-label" style={{ marginLeft: "auto" }}>收录 {meta.total} 个 · 展示前 {TOP_N}</span>}
        </div>
        <p className="hint" style={{ marginTop: 10 }}>{TABS.find((t) => t.key === tab)?.hint}</p>
      </section>

      {!lite ? (
        <div className="empty">正在加载榜单…</div>
      ) : rows.length === 0 ? (
        <div className="empty">这个榜单暂时没有条目。</div>
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
                <p className="rank-desc">{v.d || "（上游未提供简介）"}</p>
              </div>
              <div className="rank-nums">
                <span className="rank-num"><b>★ {formatStars(v.s)}</b></span>
                <span className="rank-num">↓ {formatDownloads(v.dl) ?? "—"}</span>
                <span className="rank-num rank-num-dim">{relativeTime(v.p)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
