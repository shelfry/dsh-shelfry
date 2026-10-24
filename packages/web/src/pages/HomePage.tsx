import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginType } from "@dsh-shelfry/schema";
import { Link, useSearchParams } from "react-router-dom";
import { PluginCard } from "../components/PluginCard";
import { HeaderSettings } from "../components/HeaderSettings";
import { CurationDialog } from "../components/CurationDialog";
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
import { ORIGIN, SEO_DEFAULT_DESCRIPTION, SEO_SITE_NAME, useSeo } from "../lib/seo";

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

/** 与样式表里的手机断点保持一致，用来决定分类折叠数量。 */
const MOBILE_QUERY = "(max-width: 640px)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

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
  // 手机端高级筛选默认折叠成一行，避免标签和按钮混排
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const isMobile = useMediaQuery(MOBILE_QUERY);
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
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SEO_SITE_NAME,
      alternateName: siteConfig.siteName,
      url: `${ORIGIN}/`,
      description: SEO_DEFAULT_DESCRIPTION,
    },
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
    const sorted = hits && sort === "score" ? kept : sortItems(kept, sort);
    // 综合排序里把镜像/克隆仓沉底：不删除（搜索与筛选仍可见），只是不占前排。
    if (sort !== "score" || hits) return sorted;
    const normal: SearchHit[] = [];
    const mirrors: SearchHit[] = [];
    for (const h of sorted) (h.item.dp === 1 ? mirrors : normal).push(h);
    return normal.concat(mirrors);
  }, [hits, hasFilters, fullLite, firstPage, extraPages, scope, type, stars, compat, category, sort]);

  const totalInScope = useMemo(() => {
    if (!hasFilters && meta) return scopeCount(meta, scope);
    return filtered.length;
  }, [hasFilters, meta, filtered.length, scope]);

  const canLoadMore = shown < filtered.length || (!hasFilters && artifacts !== null && loadedPages < artifacts.pages.count);

  // 综合排序把镜像仓沉底后，首屏按「非镜像条目数」判断是否够一屏，不够就继续补页。
  const normalCount = useMemo(
    () => (sort === "score" && !hits ? filtered.reduce((n, h) => n + (h.item.dp === 1 ? 0 : 1), 0) : filtered.length),
    [filtered, sort, hits],
  );

  const loadMore = useCallback(() => {
    if (!canLoadMore) return;
    setShown((s) => s + PAGE_STEP);
  }, [canLoadMore]);

  // 首屏 60 条里混着工具，插件视图筛掉后只剩 43/44 条，会留下半行空位。
  // 这里自动补拉下一页，直到够 60 条（能被 1/2/3/4/5/6 列整除）或数据取完。
  const fillingRef = useRef(false);
  useEffect(() => {
    if (hasFilters || !artifacts || fillingRef.current) return;
    if (normalCount >= shown || loadedPages >= artifacts.pages.count) return;
    fillingRef.current = true;
    (async () => {
      try {
        const next = await loadPage(loadedPages);
        setExtraPages((prev) => [...prev, ...next]);
        setLoadedPages((p) => p + 1);
      } catch {
        // 失败时保持现状，用户点「加载更多」会重试
      } finally {
        fillingRef.current = false;
      }
    })();
  }, [hasFilters, artifacts, normalCount, shown, loadedPages]);

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

  // 手机首屏只铺两行分类（含「全部」与「展开」，共 6 个按钮），其余折进展开；桌面维持 14 个
  const categoryLimit = isMobile ? 4 : 14;
  const visibleCategories = showAllCategories ? categories : categories.slice(0, categoryLimit);
  const advancedActive = (type !== "all" ? 1 : 0) + (stars !== "all" ? 1 : 0) + (compat !== "all" ? 1 : 0);
  const categorySet = new Set(categories.map((c) => c.t));

  // 同一批选项在桌面（单行直出）与手机（分组折叠）两套结构里复用
  const typeChips = (TYPE_ORDER).map((key) => (
    <button key={key} className="chip chip-sm" aria-pressed={type === key} onClick={() => setType(key)}>
      {t(TYPE_KEY[key])}
    </button>
  ));
  const starChips = (STARS_ORDER).map((key) => (
    <button key={key} className="chip chip-sm" aria-pressed={stars === key} onClick={() => setStars(key)}>
      {key === "all" ? t("stars.all") : t("stars.n", { n: key })}
    </button>
  ));
  const compatChips = (["all", "declared", "undeclared"] as CompatFilter[]).map((key) => (
    <button key={key} className="chip chip-sm" aria-pressed={compat === key} onClick={() => setCompat(key)}>
      {t(key === "all" ? "compat.all" : key === "declared" ? "compat.declared" : "compat.undeclared")}
    </button>
  ));
  const sortChips = (SORT_ORDER).map((key) => (
    <button key={key} className="chip chip-sm" aria-pressed={sort === key} onClick={() => setSort(key)}>
      {t(SORT_KEY[key])}
    </button>
  ));

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
          {categories.length > categoryLimit && (
            <button className="chip chip-toggle" onClick={() => setShowAllCategories((v) => !v)}>
              {showAllCategories ? t("common.collapse") : t("filters.expand", { n: categories.length - categoryLimit })}
            </button>
          )}
        </div>

        {isMobile ? (
          <div className="filter-row filter-advanced">
            {/* 手机端：排序与三个分组共用一条左标签列，四行左边缘对齐；筛选开关放在排序行右侧 */}
            <div className="filter-sort">
              <span className="filter-label">{t("filters.sort")}</span>
              <div className="filter-chips">{sortChips}</div>
              <div className="filter-sort-end">
                {hasFilters && (
                  <button className="chip chip-sm chip-reset" onClick={resetFilters}>{t("filters.reset")}</button>
                )}
                <button
                  type="button"
                  className="chip chip-sm filter-toggle"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  {t("filters.toggle")}
                  {advancedActive > 0 && <span className="chip-count">{advancedActive}</span>}
                  <span className="filter-caret" aria-hidden="true">{advancedOpen ? "▴" : "▾"}</span>
                </button>
              </div>
            </div>

            <div className={`filter-groups${advancedOpen ? "" : " is-collapsed"}`}>
              {/* 类型与 DSH 兼容范围只对插件有意义，工具页不展示这两组 */}
              {!isTools && (
                <div className="filter-group">
                  <span className="filter-label">{t("filters.type")}</span>
                  <div className="filter-chips">{typeChips}</div>
                </div>
              )}
              <div className="filter-group">
                <span className="filter-label">{t("filters.stars")}</span>
                <div className="filter-chips">{starChips}</div>
              </div>
              {!isTools && (
                <div className="filter-group">
                  <span className="filter-label">{t("filters.compat")}</span>
                  <div className="filter-chips">{compatChips}</div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="filter-row filter-advanced">
            {/* 桌面端每组「标签 + 选项」捆成整体换行：分割线不会落在行尾，换行后也从最左侧起排 */}
            {!isTools && (
              <div className="filter-seg">
                <span className="filter-label">{t("filters.type")}</span>
                {typeChips}
              </div>
            )}
            <div className="filter-seg">
              <span className="filter-label">{t("filters.stars")}</span>
              {starChips}
            </div>
            {!isTools && (
              <div className="filter-seg">
                <span className="filter-label">{t("filters.compat")}</span>
                {compatChips}
              </div>
            )}
            <div className="filter-seg">
              <span className="filter-label">{t("filters.sort")}</span>
              {sortChips}
            </div>
            {hasFilters && <button className="chip chip-sm chip-reset" onClick={resetFilters}>{t("filters.reset")}</button>}
          </div>
        )}
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
  const [curationOpen, setCurationOpen] = useState(false);
  const curationWrapRef = useRef<HTMLSpanElement>(null);

  return (
    <>
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
        <nav className="header-nav">
          <Link className="header-link" to="/top">{t("nav.top")}</Link>
          <Link className="header-link header-fav" to="/favorites">
            {t("nav.favorites")}
            <span className="fav-count">{ids.length}</span>
          </Link>
          <Link className="header-link" to="/submit">{t("nav.submit")}</Link>
          <span className="curation-wrap" ref={curationWrapRef}>
            <button
              type="button"
              className="header-link header-link-btn"
              aria-haspopup="dialog"
              aria-expanded={curationOpen}
              onClick={() => setCurationOpen((v) => !v)}
            >
              {t("nav.curation")}
            </button>
            <CurationDialog
              open={curationOpen}
              onClose={() => setCurationOpen(false)}
              anchorRef={curationWrapRef}
            />
          </span>
        </nav>
        <div className="header-actions">
          <a className="header-link header-github" href={siteConfig.repoUrl} target="_blank" rel="noreferrer" aria-label="GitHub">
            <svg className="github-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.53-1.33-1.29-1.69-1.29-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.41-2.69 5.38-5.25 5.67.41.35.78 1.04.78 2.1v3.11c0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z"
              />
            </svg>
            <span className="github-label">{t("nav.github")}</span>
          </a>
          <HeaderSettings />
        </div>
      </div>
    </header>
    </>
  );
}
