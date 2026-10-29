import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { LiteEntry } from "@dsh-shelfry/schema";
import { PluginCard } from "../components/PluginCard";
import { CardSkeleton } from "../components/CardSkeleton";
import { loadCategories, loadEntriesByIds } from "../lib/data";
import { useFavorites } from "../lib/favorites";
import { useT } from "../lib/i18n";
import { SEO_SITE_NAME, useSeo } from "../lib/seo";

/**
 * 收藏页（#/favorites）。
 *
 * 收藏只存 id，条目内容仍从静态产物读：换设备、清缓存最多丢「收藏」这一层，
 * 不会把条目的旧快照一并留在本地。顺序按收藏时间倒序，新收藏在最前。
 *
 * 取数走「idmap + 命中分页」：收藏通常只有几条到几十条，没必要为它下载
 * 全量浏览切片（约 1 MB br）；命中分片与详情页共用同一套产物。
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
  const [byId, setById] = useState<Map<string, LiteEntry> | null>(null);
  const [categories, setCategories] = useState<Set<string>>(new Set());
  // ids 每次渲染都是新数组，用拼接串做依赖，避免无意义的重复取数
  const idsKey = ids.join("|");

  useEffect(() => {
    let cancelled = false;
    loadEntriesByIds(ids)
      .then((map) => { if (!cancelled) setById(map); })
      .catch(() => { if (!cancelled) setById(new Map()); });
    // 收藏可以混着插件与工具，两边分类并成一份，卡片右下角才不会漏
    Promise.all([loadCategories("plugins"), loadCategories("tools")])
      .then(([plugins, tools]) => {
        if (!cancelled) setCategories(new Set([...plugins, ...tools].map((c) => c.t)));
      })
      .catch(() => { /* 分类取不到只是右下角空着 */ });
    return () => { cancelled = true; };
  }, [idsKey]);

  const items = useMemo(() => {
    if (!byId) return [];
    return ids.map((id) => byId.get(id)).filter((v): v is LiteEntry => !!v);
  }, [byId, ids]);

  // 收藏数量存在本地，进页面就能知道，不用等数据；加载态先行显示，
  // 数据到达后只替换卡片内容，行数与高度都不变，页面不会跳动。
  const count = byId ? items.length : ids.length;
  // 骨架数量与实际收藏数保持一致，避免「3 张骨架 → 1 张卡」的高度突变
  const skeletonCount = Math.min(ids.length, 60);

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
      ) : byId && items.length === 0 ? (
        <div className="empty fav-empty">
          <p>{t("fav.empty")}</p>
          <Link className="btn-browse" to="/">{t("fav.browse")}</Link>
        </div>
      ) : (
        <>
          <div className="result-line">{t("fav.count", { n: count })}</div>
          {!byId ? (
            <CardSkeleton count={skeletonCount} />
          ) : (
            <div className="grid">
              {items.map((item) => (
                <PluginCard key={item.i} item={item} categories={categories} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
