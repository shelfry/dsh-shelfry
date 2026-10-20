import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginType } from "@dsh-shelfry/schema";
import { Link } from "react-router-dom";
import { PluginCard } from "../components/PluginCard";
import {
  loadArtifacts,
  loadCategories,
  loadLite,
  loadMeta,
  loadPage,
  siteConfig,
  type Category,
} from "../lib/data";
import { createSearcher, rankHits, sortItems, type SearchHit, type SortKey } from "../lib/search";

/**
 * 首页：浏览 + 检索 + 多维筛选。
 *
 * 首屏只拉第 0 页（60 条）—— 足够把「最值得看的」先端出来；
 * 一旦用户开始搜索或选了任何筛选/排序，就切到全量切片在客户端算，
 * 因为按分数分页的首页天然只覆盖高分那一小撮，用它筛分类会得到空结果。
 */

const PAGE_STEP = 60;

type TypeFilter = "all" | "cordis-plugin" | "skill" | "unknown";
type StarsFilter = "all" | "10" | "100" | "500" | "1000";
type CompatFilter = "all" | "declared" | "undeclared";

const TYPE_LABEL: Record<TypeFilter, string> = {
  all: "全部类型",
  "cordis-plugin": "插件",
  skill: "Skill",
  unknown: "未识别",
};
const TYPE_ORDER: TypeFilter[] = ["all", "cordis-plugin", "skill", "unknown"];

const STARS_LABEL: Record<StarsFilter, string> = {
  all: "不限星标",
  "10": "10+ 星标",
  "100": "100+ 星标",
  "500": "500+ 星标",
  "1000": "1000+ 星标",
};
// 不能用 Object.keys：数字形态的键会被 JS 按数值提前，导致「不限」跑到末尾。
const STARS_ORDER: StarsFilter[] = ["all", "10", "100", "500", "1000"];

const SORT_LABEL: Record<SortKey, string> = {
  score: "综合推荐",
  stars: "最多星标",
  recent: "最近更新",
};
const SORT_ORDER: SortKey[] = ["score", "stars", "recent"];

const needStars = (v: StarsFilter): number => (v === "all" ? 0 : Number(v));

export default function HomePage() {
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

  useEffect(() => {
    (async () => {
      try {
        const [a, m, c, page0] = await Promise.all([loadArtifacts(), loadMeta(), loadCategories(), loadPage(0)]);
        setArtifacts(a);
        setMeta(m);
        setCategories(c);
        setFirstPage(page0);
        setLoadedPages(1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const hasFilters = !!query.trim() || !!category || type !== "all" || stars !== "all" || compat !== "all" || sort !== "score";

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
  }, [hits, hasFilters, fullLite, firstPage, extraPages, type, stars, compat, category, sort]);

  const totalInScope = useMemo(() => {
    if (!hasFilters && meta) return meta.total;
    return filtered.length;
  }, [hasFilters, meta, filtered.length]);

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
  }, []);

  if (error) {
    return (
      <main className="wrap">
        <div className="empty">
          <p>数据加载失败：{error}</p>
          <p style={{ fontSize: 13 }}>本地开发请先执行 <code>npm run collect -- --source mirror --build</code> 生成数据产物。</p>
        </div>
      </main>
    );
  }

  const visibleCategories = showAllCategories ? categories : categories.slice(0, 14);
  const categorySet = new Set(categories.map((c) => c.t));

  return (
    <main className="wrap">
      <section className="hero">
        <h1>{siteConfig.tagline}</h1>
        <p>{siteConfig.taglineZh}</p>
        <div className="search-box">
          <span className="icon">⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索插件名、作者或功能关键词…"
            aria-label="搜索插件"
          />
        </div>
      </section>

      <section className="filters">
        <div className="filter-row filter-cats">
          <button className="chip chip-all" aria-pressed={category === ""} onClick={() => setCategory("")}>
            全部 {meta ? <span className="chip-count">{meta.total}</span> : null}
          </button>
          {visibleCategories.map((c) => (
            <button
              key={c.t}
              className="chip"
              aria-pressed={category === c.t}
              onClick={() => setCategory(category === c.t ? "" : c.t)}
            >
              {c.t} <span className="chip-count">{c.n}</span>
            </button>
          ))}
          {categories.length > 14 && (
            <button className="chip chip-toggle" onClick={() => setShowAllCategories((v) => !v)}>
              {showAllCategories ? "收起" : `展开 ${categories.length - 14} 个`}
            </button>
          )}
        </div>

        <div className="filter-row filter-advanced">
          <span className="filter-label">类型</span>
          {(TYPE_ORDER).map((key) => (
            <button key={key} className="chip chip-sm" aria-pressed={type === key} onClick={() => setType(key)}>
              {TYPE_LABEL[key]}
            </button>
          ))}
          <span className="filter-sep" />
          <span className="filter-label">星标</span>
          {(STARS_ORDER).map((key) => (
            <button key={key} className="chip chip-sm" aria-pressed={stars === key} onClick={() => setStars(key)}>
              {STARS_LABEL[key]}
            </button>
          ))}
          <span className="filter-sep" />
          <span className="filter-label">兼容</span>
          <button className="chip chip-sm" aria-pressed={compat === "all"} onClick={() => setCompat("all")}>不限</button>
          <button className="chip chip-sm" aria-pressed={compat === "declared"} onClick={() => setCompat("declared")}>已声明版本</button>
          <button className="chip chip-sm" aria-pressed={compat === "undeclared"} onClick={() => setCompat("undeclared")}>未声明</button>
          <span className="filter-sep" />
          <span className="filter-label">排序</span>
          {(SORT_ORDER).map((key) => (
            <button key={key} className="chip chip-sm" aria-pressed={sort === key} onClick={() => setSort(key)}>
              {SORT_LABEL[key]}
            </button>
          ))}
          {hasFilters && <button className="chip chip-sm chip-reset" onClick={resetFilters}>清空条件</button>}
        </div>
      </section>

      <div className="result-line">
        {hasFilters && !fullLite
          ? "正在加载全量条目…"
          : `共 ${totalInScope} 个插件`}
        {hasFilters && fullLite && ` · 已显示 ${Math.min(shown, filtered.length)} 个`}
        {!hasFilters && ` · 已显示 ${Math.min(shown, filtered.length)} 个`}
        {category && <span className="pill pill-soft">分类：{category}</span>}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          {hasFilters && !fullLite
            ? "正在加载全量条目…"
            : "没有符合条件的插件，试试放宽筛选。"}
        </div>
      ) : (
        <div className="grid">
          {filtered.slice(0, shown).map((h) => (
            <PluginCard key={h.item.i} item={h.item} categories={categorySet} />
          ))}
        </div>
      )}

      <button className="load-more" onClick={loadMore} disabled={!canLoadMore}>
        {canLoadMore ? `加载更多（已显示 ${Math.min(shown, filtered.length)} / ${totalInScope}）` : "已经到底了"}
      </button>
    </main>
  );
}

/** 站点头部：首页与详情页共用。 */
export function SiteHeader({ meta }: { meta: CatalogMeta | null }) {
  return (
    <header className="site-header">
      <div className="wrap">
        <Link className="brand" to="/">
          {siteConfig.siteName}
          <span className="zh">{siteConfig.siteNameZh}</span>
        </Link>
        <div className="header-spacer" />
        <div className="header-stat">{meta ? `已收录 ${meta.total} 个插件` : "加载中…"}</div>
        <a className="header-link" href={siteConfig.repoUrl} target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </header>
  );
}
