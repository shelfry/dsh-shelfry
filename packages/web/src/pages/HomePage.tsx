import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginType } from "@dsh-shelfry/schema";
import { Link, useSearchParams } from "react-router-dom";
import { PluginCard } from "../components/PluginCard";
import { HeaderSettings } from "../components/HeaderSettings";
import {
  isExternal,
  loadArtifacts,
  loadCategories,
  loadLite,
  loadMeta,
  loadPage,
  scopeCount,
  siteConfig,
  type CatalogScope,
  type Category,
} from "../lib/data";
import { createSearcher, rankHits, sortItems, type SearchHit, type SortKey } from "../lib/search";
import { categoryLabel } from "../lib/labels";
import { useFavorites } from "../lib/favorites";
import { useT } from "../lib/i18n";
import { SEO_DEFAULT_DESCRIPTION, SEO_SITE_NAME, useSeo } from "../lib/seo";

/**
 * 首页：浏览 + 检索 + 多维筛选。
 *
 * 首屏只拉第 0 页（60 条）—— 足够把「最值得看的」先端出来；
 * 一旦用户开始搜索或选了任何筛选/排序，就切到全量切片在客户端算，
 * 因为按分数分页的首页天然只覆盖高分那一小撮，用它筛分类会得到空结果。
 */

const PAGE_STEP = 60;

/**
 * 首页范围切换：插件（默认）与工具分开浏览。
 *
 * 工具是「有独立安装命令、但不经 DSH profile 加载」的非 DSH 项目，
 * 数量远少于插件，所以切换后按全量切片在客户端过滤，而不是单独产物。
 */

type TypeFilter = "all" | "cordis-plugin" | "skill" | "unknown";
type StarsFilter = "all" | "10" | "100" | "500" | "1000";
type CompatFilter = "all" | "declared" | "undeclared";

const TYPE_ORDER: TypeFilter[] = ["all", "cordis-plugin", "skill", "unknown"];

// 不能用 Object.keys：数字形态的键会被 JS 按数值提前，导致「不限」跑到末尾。
const STARS_ORDER: StarsFilter[] = ["all", "10", "100", "500", "1000"];

const SORT_ORDER: SortKey[] = ["score", "stars", "recent"];

const TYPE_KEY: Record<TypeFilter, "type.all" | "type.plugin" | "type.skill" | "type.unknown"> = {
  all: "type.all",
  "cordis-plugin": "type.plugin",
  skill: "type.skill",
  unknown: "type.unknown",
};

const SORT_KEY: Record<SortKey, "sort.score" | "sort.stars" | "sort.recent"> = {
  score: "sort.score",
  stars: "sort.stars",
  recent: "sort.recent",
};

const needStars = (v: StarsFilter): number => (v === "all" ? 0 : Number(v));

export default function HomePage() {
  // 范围写进 URL（#/?scope=tools），刷新与分享都能回到同一视图
  const [searchParams, setSearchParams] = useSearchParams();
  const scope: CatalogScope = searchParams.get("scope") === "tools" ? "tools" : "plugins";
  const setScope = useCallback((next: CatalogScope) => {
    const params = new URLSearchParams(searchParams);
    if (next === "tools") params.set("scope", "tools");
    else params.delete("scope");
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const [artifacts, setArtifacts] = useState<ArtifactIndex | null>(null);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [firstPage, setFirstPage] = useState<LiteEntry[]>([]);
  const [extraPages, setExtraPages] = useState<LiteEntry[]>([]);
  const [loadedPages, setLoadedPages] = useState(0);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("");
  const [type, setType] = useState<TypeFilter>("all");
  const [stars, setStars] = useState<StarsFilter>("all");
  const [compat, setCompat] = useState<CompatFilter>("all");
  const [sort, setSort] = useState<SortKey>("score");
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [shown, setShown] = useState(PAGE_STEP);
  const [error, setError] = useState<string | null>(null);

  const [fullLite, setFullLite] = useState<LiteEntry[] | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const searcherRef = useRef<ReturnType<typeof createSearcher> | null>(null);
  const { t } = useT();
  useSeo({
    title: `${SEO_SITE_NAME} · DeepSeek Harness 插件与工具`,
    description: SEO_DEFAULT_DESCRIPTION,
    path: "/",
  });

  useEffect(() => {
    (async () => {
      try {
        const [a, m, page0] = await Promise.all([loadArtifacts(), loadMeta(), loadPage(0)]);
        setArtifacts(a);
        setMeta(m);
        setFirstPage(page0);
        setLoadedPages(1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // 分类清单按范围分开拉：工具的分类阈值与插件完全不同
  useEffect(() => {
    let cancelled = false;
    loadCategories(scope)
      .then((rows) => { if (!cancelled) setCategories(rows); })
      .catch(() => { if (!cancelled) setCategories([]); });
    return () => { cancelled = true; };
  }, [scope]);

  // 切换范围时清掉只对上一个范围有意义的筛选
  useEffect(() => {
    setCategory("");
    setType("all");
    setCompat("all");
    setShown(PAGE_STEP);
  }, [scope]);

  // 工具视图本身就是一次筛选，必须切到全量切片才能包含第一页之外的条目
  const hasFilters =
    scope === "tools" || !!query.trim() || !!category || type !== "all" || stars !== "all" || compat !== "all" || sort !== "score";

  // 全量切片：搜索、任一筛选、非默认排序都要求它。
  useEffect(() => {
    if (!hasFilters || fullLite) return;
    let cancelled = false;
    (async () => {
      try {
        const lite = await loadLite();
        if (!cancelled) setFullLite(lite);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [hasFilters, fullLite]);

  // 检索：输入 ≥2 字符才走 Fuse（索引按需建一次）。
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits(null); return; }
    if (!fullLite) return;
    let cancelled = false;
    (async () => {
      if (!searcherRef.current) searcherRef.current = createSearcher(fullLite);
      if (!cancelled) setHits(rankHits(searcherRef.current(q)));
    })();
    return () => { cancelled = true; };
  }, [query, fullLite]);

  useEffect(() => { setShown(PAGE_STEP); }, [query, category, type, stars, compat, sort]);

  const filtered = useMemo(() => {
    const minStars = needStars(stars);
    const keep = (v: LiteEntry): boolean => {
      // 两个范围互斥：插件页不混入工具，工具页也不混入插件
      if (scope === "tools" ? !isExternal(v) : isExternal(v)) return false;
      if (minStars > 0 && v.s < minStars) return false;
      if (type !== "all" && v.t !== type) return false;
      if (compat === "declared" && !v.g) return false;
      if (compat === "undeclared" && v.g) return false;
      if (category && !v.tg.includes(category)) return false;
      return true;
    };
    const asHit = (item: LiteEntry, index: number): SearchHit => ({ index, item, fuzzyScore: 0 });

    const base: SearchHit[] = hits ?? (hasFilters && fullLite ? fullLite.map(asHit) : firstPage.concat(extraPages).map(asHit));
    const kept = base.filter((h) => keep(h.item));
    // 搜索结果已按相关度排过，用户没改排序口径时不要打乱它。
    return hits && sort === "score" ? kept : sortItems(kept, sort);
  }, [hits, hasFilters, fullLite, firstPage, extraPages, scope, type, stars, compat, category, sort]);

  const totalInScope = useMemo(() => {
    if (!hasFilters && meta) return scopeCount(meta, scope);
    return filtered.length;
  }, [hasFilters, meta, filtered.length, scope]);

  const canLoadMore = shown < filtered.length || (!hasFilters && artifacts !== null && loadedPages < artifacts.pages.count);

  const loadMore = useCallback(async () => {
    if (shown < filtered.length) { setShown((s) => s + PAGE_STEP); return; }
    if (hasFilters || !artifacts || loadedPages >= artifacts.pages.count) return;
    const next = await loadPage(loadedPages);
    setExtraPages((prev) => [...prev, ...next]);
    setLoadedPages((p) => p + 1);
    setShown((s) => s + PAGE_STEP);
  }, [shown, filtered.length, hasFilters, artifacts, loadedPages]);

  const resetFilters = useCallback(() => {
    setQuery("");
    setCategory("");
    setType("all");
    setStars("all");
    setCompat("all");
    setSort("score");
    setScope("plugins");
  }, [setScope]);

  const isTools = scope === "tools";

  if (error) {
    return (
      <main className="wrap">
        <div className="empty">
          <p>{t("common.dataError", { msg: error })}</p>
          <p style={{ fontSize: 13 }}>{t("common.devHint")}</p>
        </div>
      </main>
    );
  }

  const visibleCategories = showAllCategories ? categories : categories.slice(0, 14);
  const categorySet = new Set(categories.map((c) => c.t));

  return (
    <main className="wrap">
      <section className="hero">
        <h1>{t(isTools ? "home.title.tools" : "home.title.plugins")}</h1>
        <p>{t(isTools ? "home.sub.tools" : "home.sub.plugins")}</p>
        <div className="search-row">
          <div className="search-box">
            <span className="icon">⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t(isTools ? "home.search.tools" : "home.search.plugins")}
              aria-label={t(isTools ? "home.searchAria.tools" : "home.searchAria.plugins")}
            />
          </div>
          <div className="scope-switch" role="tablist" aria-label={t("home.scope")}>
            {(["plugins", "tools"] as CatalogScope[]).map((key) => (
              <button
                key={key}
                role="tab"
                aria-selected={scope === key}
                className="scope-btn"
                onClick={() => setScope(key)}
              >
                {t(key === "plugins" ? "common.plugins" : "common.tools")}
                <span className="scope-count">{scopeCount(meta, key)}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="filters">
        <div className="filter-row filter-cats">
          <button className="chip chip-all" aria-pressed={category === ""} onClick={() => setCategory("")}>
            {t("common.all")} {meta ? <span className="chip-count">{scopeCount(meta, scope)}</span> : null}
          </button>
          {visibleCategories.map((c) => (
            <button
              key={c.t}
              className="chip"
              aria-pressed={category === c.t}
              onClick={() => setCategory(category === c.t ? "" : c.t)}
            >
              {categoryLabel(c.t)} <span className="chip-count">{c.n}</span>
            </button>
          ))}
          {categories.length > 14 && (
            <button className="chip chip-toggle" onClick={() => setShowAllCategories((v) => !v)}>
              {showAllCategories ? t("common.collapse") : t("filters.expand", { n: categories.length - 14 })}
            </button>
          )}
        </div>

        <div className="filter-row filter-advanced">
          {/* 类型与 DSH 兼容范围只对插件有意义，工具页不展示这两组 */}
          {!isTools && (
            <>
              <span className="filter-label">{t("filters.type")}</span>
              {(TYPE_ORDER).map((key) => (
                <button key={key} className="chip chip-sm" aria-pressed={type === key} onClick={() => setType(key)}>
                  {t(TYPE_KEY[key])}
                </button>
              ))}
              <span className="filter-sep" />
            </>
          )}
          <span className="filter-label">{t("filters.stars")}</span>
          {(STARS_ORDER).map((key) => (
            <button key={key} className="chip chip-sm" aria-pressed={stars === key} onClick={() => setStars(key)}>
              {key === "all" ? t("stars.all") : t("stars.n", { n: key })}
            </button>
          ))}
          {!isTools && (
            <>
              <span className="filter-sep" />
              <span className="filter-label">{t("filters.compat")}</span>
              <button className="chip chip-sm" aria-pressed={compat === "all"} onClick={() => setCompat("all")}>{t("compat.all")}</button>
              <button className="chip chip-sm" aria-pressed={compat === "declared"} onClick={() => setCompat("declared")}>{t("compat.declared")}</button>
              <button className="chip chip-sm" aria-pressed={compat === "undeclared"} onClick={() => setCompat("undeclared")}>{t("compat.undeclared")}</button>
            </>
          )}
          <span className="filter-sep" />
          <span className="filter-label">{t("filters.sort")}</span>
          {(SORT_ORDER).map((key) => (
            <button key={key} className="chip chip-sm" aria-pressed={sort === key} onClick={() => setSort(key)}>
              {t(SORT_KEY[key])}
            </button>
          ))}
          {hasFilters && <button className="chip chip-sm chip-reset" onClick={resetFilters}>{t("filters.reset")}</button>}
        </div>
      </section>

      <div className="result-line">
        {hasFilters && !fullLite
          ? t("home.loadingAll")
          : t(isTools ? "home.total.tools" : "home.total.plugins", { n: totalInScope })}
        {hasFilters && fullLite && ` · ${t("home.shown", { n: Math.min(shown, filtered.length) })}`}
        {!hasFilters && ` · ${t("home.shown", { n: Math.min(shown, filtered.length) })}`}
        {category && <span className="pill pill-soft">{t("home.categoryChip", { name: categoryLabel(category) })}</span>}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          {hasFilters && !fullLite
            ? t("home.loadingAll")
            : t(isTools ? "home.empty.tools" : "home.empty.plugins")}
        </div>
      ) : (
        <div className="grid">
          {filtered.slice(0, shown).map((h) => (
            <PluginCard key={h.item.i} item={h.item} categories={categorySet} />
          ))}
        </div>
      )}

      <button className="load-more" onClick={loadMore} disabled={!canLoadMore}>
        {canLoadMore
          ? t("home.loadMore", { shown: Math.min(shown, filtered.length), total: totalInScope })
          : t("home.end")}
      </button>
    </main>
  );
}

/** 站点头部：首页与详情页共用。 */
export function SiteHeader({ meta }: { meta: CatalogMeta | null }) {
  const { t } = useT();
  const { ids } = useFavorites();

  return (
    <header className="site-header">
      <div className="wrap">
        <Link className="brand" to="/">
          {siteConfig.siteName}
          <span className="zh">{siteConfig.siteNameZh}</span>
        </Link>
        <div className="header-spacer" />
        <div className="header-stat">
          {meta
            ? t("header.stat", { plugins: scopeCount(meta, "plugins"), tools: scopeCount(meta, "tools") })
            : t("common.loading")}
        </div>
        <Link className="header-link" to="/top">{t("nav.top")}</Link>
        <Link className="header-link header-fav" to="/favorites">
          {t("nav.favorites")}
          {ids.length > 0 && <span className="fav-count">{ids.length}</span>}
        </Link>
        <Link className="header-link" to="/submit">{t("nav.submit")}</Link>
        <a className="header-link" href={siteConfig.repoUrl} target="_blank" rel="noreferrer">{t("nav.github")}</a>
        <HeaderSettings />
      </div>
    </header>
  );
}
