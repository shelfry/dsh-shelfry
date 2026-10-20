import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactIndex, CatalogMeta, LiteEntry, PluginEntry, PluginType } from "@dsh-shelfry/schema";
import { PluginCard } from "./components/PluginCard";
import { DetailDrawer } from "./components/DetailDrawer";
import { loadArtifacts, loadEntryAt, loadLite, loadMeta, loadPage, siteConfig } from "./lib/data";
import { createSearcher, rankHits, type SearchHit } from "./lib/search";

type StatusFilter = "primary" | "verified" | "pending" | "failed" | "all";
type TypeFilter = "all" | "cordis-plugin" | "skill";

const RESULTS_SHOWN_STEP = 60;

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: "primary", label: "已验证 + 待验证" },
  { key: "verified", label: "已验证" },
  { key: "pending", label: "待验证" },
  { key: "failed", label: "安装失败" },
  { key: "all", label: "全部" },
];

export default function App() {
  const [artifacts, setArtifacts] = useState<ArtifactIndex | null>(null);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [browseItems, setBrowseItems] = useState<LiteEntry[]>([]);
  const [loadedPages, setLoadedPages] = useState(0);
  /** 切到「已验证/待验证/安装失败/全部」时才拉的全量切片。 */
  const [fullLite, setFullLite] = useState<LiteEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("primary");
  const [type, setType] = useState<TypeFilter>("all");
  const [shown, setShown] = useState(RESULTS_SHOWN_STEP);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [detail, setDetail] = useState<PluginEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searcherRef = useRef<ReturnType<typeof createSearcher> | null>(null);

  // 首屏：只拉清单 + 元信息 + 第 0 页，三份都是小文件。
  useEffect(() => {
    (async () => {
      try {
        const [a, m, firstPage] = await Promise.all([loadArtifacts(), loadMeta(), loadPage(0)]);
        setArtifacts(a);
        setMeta(m);
        setBrowseItems(firstPage);
        setLoadedPages(1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // 检索：首次输入时才拉全量切片（懒加载 + 缓存），并建一次索引。
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (!searcherRef.current) {
          const lite = await loadLite();
          searcherRef.current = createSearcher(lite);
        }
        if (!cancelled) setHits(rankHits(searcherRef.current(q)));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [query]);

  useEffect(() => { setShown(RESULTS_SHOWN_STEP); }, [query, status, type]);

  /**
   * 只有「已验证 + 待验证」这个默认口径可以边浏览边翻页 —— 它天然覆盖分数最高的那批条目。
   * 但「已验证 / 待验证 / 安装失败」单档筛选必须看全量：数据按分数降序分页，而已验证条目
   * 分数天然更高（可装性 verified=1.0 vs pending=0.5），只筛已加载的首页必然筛出 0 条 ——
   * 明明有待验证与失败条目却显示「没有匹配结果」，那是数据错误而不是「没有」。所以这几档
   * 切过去就拉全量切片（与搜索同一条路，一次拉完缓存复用），筛的是全站而非首页。
   */
  const needsFullScan = status !== "primary" || type !== "all";
  useEffect(() => {
    if (!needsFullScan || fullLite) return;
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
  }, [needsFullScan, fullLite]);

  // 搜索也用全量切片：首次搜索时一并缓存，之后的筛选切换不必再请求。
  useEffect(() => {
    if (!query.trim() || fullLite) return;
    let cancelled = false;
    (async () => {
      try {
        const lite = await loadLite();
        if (!cancelled && query.trim()) setFullLite(lite);
      } catch { /* 搜索路径自身会处理错误 */ }
    })();
    return () => { cancelled = true; };
  }, [query, fullLite]);

  const filtered = useMemo(() => {
    const keep = (v: LiteEntry) => {
      if (status === "all") return true;
      if (status === "primary") return v.v !== 2;
      if (status === "verified") return v.v === 0;
      if (status === "pending") return v.v === 1;
      return v.v === 2;
    };
    const typeOk = (t: PluginType) => type === "all" || t === type;
    const asHit = (item: LiteEntry, index: number): SearchHit => ({ index, item, fuzzyScore: 0 });

    if (hits) return hits.filter((h) => keep(h.item) && typeOk(h.item.t));
    // 全量口径：序号就是它在全量切片中的位置，同时也是明细分片的定位依据。
    if (fullLite && needsFullScan) return fullLite.map(asHit).filter((h) => keep(h.item) && typeOk(h.item.t));
    // 默认口径：边浏览边翻页，此时计数只反映已加载部分，靠「加载更多」逐步展开。
    // index 即该条目在全局切片中的序号，同时用于定位明细分片。
    return browseItems
      .map(asHit)
      .filter((h) => keep(h.item) && typeOk(h.item.t));
  }, [hits, fullLite, needsFullScan, browseItems, status, type]);

  const visible = filtered.slice(0, shown);
  const canLoadMore = shown < filtered.length || (!hits && !needsFullScan && artifacts !== null && loadedPages < artifacts.pages.count);

  const loadMore = useCallback(async () => {
    if (shown < filtered.length) { setShown((s) => s + RESULTS_SHOWN_STEP); return; }
    // 全量口径下所有条目都已在内存里，没有「下一页」可拉。
    if (hits || needsFullScan || !artifacts || loadedPages >= artifacts.pages.count) return;
    const next = await loadPage(loadedPages);
    setBrowseItems((prev) => [...prev, ...next]);
    setLoadedPages((p) => p + 1);
    setShown((s) => s + RESULTS_SHOWN_STEP);
  }, [shown, filtered.length, hits, needsFullScan, artifacts, loadedPages]);

  const openDetail = useCallback(async (globalIndex: number) => {
    if (!artifacts) return;
    const entry = await loadEntryAt(artifacts, globalIndex);
    if (entry) setDetail(entry);
  }, [artifacts]);

  if (error) {
    return (
      <div className="wrap">
        <div className="empty">
          <p>数据加载失败：{error}</p>
          <p style={{ fontSize: 13 }}>本地开发请先执行 <code>npm run collect -- --source mirror --limit 200 --build</code> 生成数据产物。</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="site-header">
        <div className="wrap">
          <div className="brand">
            {siteConfig.siteName}
            <span className="zh">{siteConfig.siteNameZh}</span>
          </div>
          <div className="header-spacer" />
          <div className="header-stat">
            {meta ? `收录 ${meta.total} · 已验证 ${meta.counts.verified} · 待验证 ${meta.counts.pending} · 失败 ${meta.counts.failed}` : "加载中…"}
          </div>
          <a className="header-link" href={siteConfig.repoUrl} target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </header>

      <main className="wrap">
        <div className="hero">
          <h1>{siteConfig.tagline}</h1>
          <p>{siteConfig.taglineZh}</p>
          <div className="controls">
            <div className="search-box">
              <span className="icon">⌕</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索插件名、作者、标签或中文描述…"
                aria-label="搜索插件"
              />
            </div>
            <div className="chips">
              {STATUS_CHIPS.map((s) => (
                <button key={s.key} className="chip" aria-pressed={status === s.key} onClick={() => setStatus(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
            <div className="chips">
              {(["all", "cordis-plugin", "skill"] as TypeFilter[]).map((t) => (
                <button key={t} className="chip" aria-pressed={type === t} onClick={() => setType(t)}>
                  {{ all: "全部类型", "cordis-plugin": "插件", skill: "skill" }[t]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="result-line">
          {needsFullScan && !fullLite
            ? "正在加载全站条目…"
            : hits
              ? `找到 ${filtered.length} 条`
              : needsFullScan
                ? `共 ${filtered.length} 条匹配（全站）`
                : `共 ${filtered.length} 条匹配（已加载 ${browseItems.length}）`}
          {status === "primary" && <span className="badge tone-mute">默认隐藏「安装失败」的条目</span>}
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            {needsFullScan && !fullLite
              ? "正在加载全站条目…"
              : meta && meta.counts.verified === 0 && status === "primary"
                ? "还没有已验证的插件 —— 验证器尚未跑过。切到「全部」可以看到全部收录。"
                : status === "failed" && meta && meta.counts.failed === 0
                  ? "目前没有实测安装失败的条目 —— 这是个好消息。"
                  : type !== "all" && meta
                    ? "该状态下没有此类型的条目。试试切到「全部类型」。"
                    : "没有匹配结果。"}
          </div>
        ) : (
          <div className="grid">
            {visible.map((h) => (
              <PluginCard key={h.item.i} item={h.item} onOpen={() => openDetail(h.index)} />
            ))}
          </div>
        )}

        <button className="load-more" onClick={loadMore} disabled={!canLoadMore}>
          {canLoadMore ? "加载更多" : "没有更多了"}
        </button>
      </main>

      <footer className="site-footer">
        <div className="wrap">
          <span>{siteConfig.siteName} · {siteConfig.license}</span>
          <span>验证在隔离 DSH 环境中执行，不接触你的本机配置</span>
          <span>数据 {meta?.generatedAt.slice(0, 16).replace("T", " ") ?? "—"} 更新</span>
        </div>
      </footer>

      {detail && <DetailDrawer entry={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
