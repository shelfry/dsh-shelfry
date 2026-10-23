import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { LiteEntry } from "@dsh-shelfry/schema";
import { PluginCard } from "../components/PluginCard";
import { loadCategories, loadLite } from "../lib/data";
import { useFavorites } from "../lib/favorites";
import { useT } from "../lib/i18n";
import { SEO_SITE_NAME, useSeo } from "../lib/seo";

/**
 * 收藏页（#/favorites）。
 *
 * 收藏只存 id，条目内容仍从全量切片读：换设备、清缓存最多丢「收藏」这一层，
 * 不会把条目的旧快照一并留在本地。顺序按收藏时间倒序，新收藏在最前。
 */
export default function FavoritesPage() {
  const { ids } = useFavorites();
  const { t } = useT();
  useSeo({
    title: `${t("nav.favorites")} · ${SEO_SITE_NAME}`,
    description: "我收藏的 DSH 插件与独立工具，保存在本机浏览器。",
    path: "/favorites",
    noindex: true,
  });
  const [lite, setLite] = useState<LiteEntry[] | null>(null);
  const [categories, setCategories] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    loadLite()
      .then((rows) => { if (!cancelled) setLite(rows); })
      .catch(() => { if (!cancelled) setLite([]); });
    // 收藏可以混着插件与工具，两边分类并成一份，卡片右下角才不会漏
    Promise.all([loadCategories("plugins"), loadCategories("tools")])
      .then(([plugins, tools]) => {
        if (!cancelled) setCategories(new Set([...plugins, ...tools].map((c) => c.t)));
      })
      .catch(() => { /* 分类取不到只是右下角空着 */ });
    return () => { cancelled = true; };
  }, []);

  const items = useMemo(() => {
    if (!lite) return [];
    const byId = new Map(lite.map((v) => [v.i, v]));
    return ids.map((id) => byId.get(id)).filter((v): v is LiteEntry => !!v);
  }, [lite, ids]);

  return (
    <main className="wrap fav-page">
      <section className="hero">
        <h1>{t("fav.title")}</h1>
        <p>{t("fav.intro")}</p>
      </section>

      {ids.length === 0 ? (
        <div className="empty fav-empty">
          <p>{t("fav.empty")}</p>
          <Link className="btn-browse" to="/">{t("fav.browse")}</Link>
        </div>
      ) : !lite ? (
        <div className="empty">{t("fav.loading")}</div>
      ) : items.length === 0 ? (
        <div className="empty fav-empty">
          <p>{t("fav.empty")}</p>
          <Link className="btn-browse" to="/">{t("fav.browse")}</Link>
        </div>
      ) : (
        <>
          <div className="result-line">{t("fav.count", { n: items.length })}</div>
          <div className="grid">
            {items.map((item) => (
              <PluginCard key={item.i} item={item} categories={categories} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
