import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { LiteEntry, PluginEntry } from "@dsh-shelfry/schema";
import { loadArtifacts, loadCategories, loadEntryById, loadLite, siteConfig, type Category } from "../lib/data";
import { Avatar, formatDownloads, formatStars, PluginCard, relativeTime, versionLabel } from "../components/PluginCard";
import { copyText } from "../lib/clipboard";
import { assistantPrompt } from "../lib/assistant";
import { DEFAULT_PROFILE, applyProfile, useProfile } from "../lib/install";
import { ProfilePicker } from "../components/ProfilePicker";
import { RobotMark } from "../components/RobotMark";
import { StarButton } from "../components/StarButton";
import { meaningfulTags } from "../lib/labels";
import { loadReadme, type ReadmeResult } from "../lib/readme";
import { useT } from "../lib/i18n";
import { ORIGIN, SEO_DEFAULT_DESCRIPTION, SEO_SITE_NAME, useSeo } from "../lib/seo";

type MethodKey = "pnpm-profile" | "standalone" | "native" | "skills-add" | "manual";

const METHOD_LABEL: Record<MethodKey, "method.pnpm-profile" | "method.standalone" | "method.native" | "method.skills-add" | "method.manual"> = {
  "pnpm-profile": "method.pnpm-profile",
  standalone: "method.standalone",
  native: "method.native",
  "skills-add": "method.skills-add",
  manual: "method.manual",
};

const METHOD_SHORT: Record<MethodKey, "methodShort.pnpm-profile" | "methodShort.standalone" | "methodShort.native" | "methodShort.skills-add" | "methodShort.manual"> = {
  "pnpm-profile": "methodShort.pnpm-profile",
  standalone: "methodShort.standalone",
  native: "methodShort.native",
  "skills-add": "methodShort.skills-add",
  manual: "methodShort.manual",
};

/**
 * 插件详情页（独立路由 #/p/owner/repo）。
 *
 * 为什么是独立页而不是抽屉：详情要能分享、能被浏览器前进后退、能被搜索引擎录入。
 * 直达链接时手上只有 id，用 idmap.json 翻成明细分片序号再取详情。
 */
export default function DetailPage() {
  // route 是 /p/*：splat 取出 owner/repo（可能是 %2F 形式，这里统一解码）
  const params = useParams();
  const raw = params["*"] ?? "";
  const decoded = (() => {
    try { return decodeURIComponent(raw); } catch { return raw; }
  })();
  const [entry, setEntry] = useState<PluginEntry | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [copied, setCopied] = useState(false);
  const [copiedAssistant, setCopiedAssistant] = useState(false);
  const [copiedPkg, setCopiedPkg] = useState(false);
  const [readme, setReadme] = useState<ReadmeResult | null | "loading">("loading");
  const [similar, setSimilar] = useState<LiteEntry[]>([]);
  const [byAuthor, setByAuthor] = useState<LiteEntry[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [readmeOpen, setReadmeOpen] = useState(false);
  const [profile, setProfile] = useProfile();
  // 标签只占一行，多出来的收进 +N：条目之间标签数量差异大，不限高会把简介面板撑得高低不一。
  const tagsRef = useRef<HTMLDivElement>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [overflowTags, setOverflowTags] = useState(0);
  const { t } = useT();
  // 详情加载完再用条目自己的名字与简介覆盖默认标题，搜索引擎看到的就是这一条
  const seoDescription = (entry ? entry.descriptionZh ?? entry.description ?? SEO_DEFAULT_DESCRIPTION : SEO_DEFAULT_DESCRIPTION).slice(0, 160);
  useSeo({
    title: entry ? `${entry.name} · ${SEO_SITE_NAME}` : SEO_SITE_NAME,
    description: seoDescription,
    path: `/p/${entry?.id ?? decoded}`,
    // 仓库下架/收录缺失时页面只剩一句「未找到」：200 空页会被判软 404，明确告诉爬虫别索引
    noindex: state === "missing" || state === "error",
    // 星标数不是用户评分，不能写成 aggregateRating；只声明项目本体与仓库地址
    jsonLd: entry
      ? {
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: entry.name,
          description: entry.descriptionZh ?? entry.description ?? undefined,
          url: `${ORIGIN}/p/${entry.id}`,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "macOS, Linux, Windows",
          codeRepository: `https://github.com/${entry.fullName}`,
          softwareVersion: entry.version ?? undefined,
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        }
      : undefined,
  });

  // 换了条目就把标签收起，避免上一页的展开状态带过来
  useEffect(() => {
    setTagsOpen(false);
  }, [entry?.id]);

  useEffect(() => {
    const el = tagsRef.current;
    if (!el || tagsOpen) return;
    const measure = () => {
      const first = el.firstElementChild as HTMLElement | null;
      if (!first) {
        setOverflowTags(0);
        return;
      }
      // 折叠时容器裁到两行高，但子元素仍在正常换行排版，按行顶位置就能数出被裁掉几条
      let hidden = 0;
      const tops = [...new Set(Array.from(el.children).map((c) => (c as HTMLElement).offsetTop))].sort((a, b) => a - b);
      const lastShown = tops[1] ?? tops[0] ?? 0;
      for (const child of Array.from(el.children)) {
        if ((child as HTMLElement).offsetTop > lastShown + 2) hidden++;
      }
      setOverflowTags(hidden);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tagsOpen, entry?.id, entry?.tags.length]);

  // 换一个插件就回到默认 profile：详情页内切换同类推荐时不该沿用上一个插件的选择
  useEffect(() => {
    setProfile(DEFAULT_PROFILE);
  }, [decoded, setProfile]);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    (async () => {
      try {
        const artifacts = await loadArtifacts();
        const found = await loadEntryById(artifacts, decoded);
        if (cancelled) return;
        if (found) { setEntry(found); setState("ok"); }
        else setState("missing");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [decoded]);

  // README 与相似插件都依赖 entry，进页面后再异步补 —— 主信息先出来，别让用户干等
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setReadme("loading");
    setReadmeOpen(false);
    loadReadme(entry.fullName)
      .then((r) => { if (!cancelled) setReadme(r); })
      .catch(() => { if (!cancelled) setReadme(null); });
    return () => { cancelled = true; };
  }, [entry]);

  // 弹窗打开时锁住背景滚动、支持 ESC 关闭
  useEffect(() => {
    if (!readmeOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setReadmeOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [readmeOpen]);

  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    (async () => {
      try {
        const tool = entry.ecosystem === "external";
        const [lite, cats] = await Promise.all([loadLite(), loadCategories(tool ? "tools" : "plugins")]);
        if (cancelled) return;
        setCategories(cats);
        const owner = entry.fullName.split("/")[0]!.toLowerCase();
        // 推荐不跨范围：工具页不推 DSH 插件，插件页也不推独立工具
        const sameScope = lite.filter((v) => (v.ec === "external") === tool);
        setByAuthor(
          sameScope
            .filter((v) => v.i !== entry.id && v.i.split("/")[0]!.toLowerCase() === owner)
            .sort((a, b) => b.s - a.s)
            .slice(0, 4),
        );
        const myTags = new Set(meaningfulTags(entry.tags).map((t) => t.toLowerCase()));
        const picked = sameScope
          .filter((v) => v.i !== entry.id)
          .map((v) => ({
            v,
            // 同一个标签算 3 分，同类型再加 1 分：标签重合比类型更能说明「是同类插件」
            weight: v.tg.filter((t) => myTags.has(t.toLowerCase())).length * 3 + (v.t === entry.type ? 1 : 0),
          }))
          .filter((x) => x.weight >= 3)
          .sort((a, b) => b.weight - a.weight || b.v.s - a.v.s)
          .slice(0, 4)
          .map((x) => x.v);
        setSimilar(picked);
      } catch {
        // 推荐只是锦上添花，失败就留空
      }
    })();
    return () => { cancelled = true; };
  }, [entry]);

  // 命令里的 profile 统一由选择器决定；上游安装器（npx ...）没有 --profile，会原样返回
  const command = entry?.install.command ? applyProfile(entry.install.command, profile) : null;
  // 原始 skill 仓库没有 dsh 安装动作：给一条能直接执行的克隆命令，
  // 落到 DSH 会自动扫描的共享技能目录，避免安装区只剩一句说明。
  const skillCommand = !command && entry?.type === "skill"
    ? `git clone --depth 1 https://github.com/${entry.fullName}.git ~/.agents/skills/${entry.fullName.replace("/", "-")}`
    : null;
  const shownCommand = command ?? skillCommand;

  const copy = async () => {
    if (!shownCommand) return;
    if (await copyText(shownCommand)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const copyPkg = async () => {
    const pkg = entry?.install.packageName;
    if (!pkg) return;
    if (await copyText(pkg)) {
      setCopiedPkg(true);
      setTimeout(() => setCopiedPkg(false), 1600);
    }
  };

  const copyForAssistant = async () => {
    if (!shownCommand || !entry) return;
    const ok = await copyText(assistantPrompt({ name: entry.name, repo: entry.fullName, command: shownCommand }));
    if (ok) {
      setCopiedAssistant(true);
      setTimeout(() => setCopiedAssistant(false), 1600);
    }
  };

  if (state === "loading") {
    return <main className="wrap detail"><div className="empty">{t("detail.loading")}</div></main>;
  }
  if (state === "missing" || state === "error") {
    return (
      <main className="wrap detail">
        <div className="empty-state">
          <RobotMark size={96} tone="muted" />
          <p className="empty-state__title">
            {state === "missing" ? t("detail.missing", { id: decoded }) : t("detail.error")}
          </p>
          {/* 未收录时才补一句可能的原因，加载失败不给猜测 */}
          {state === "missing" && <p className="empty-state__hint">{t("detail.missingHint")}</p>}
          <Link className="back-link" to="/">{t("detail.back.plugins")}</Link>
        </div>
      </main>
    );
  }
  if (!entry) return null;

  const repoUrl = entry.homepage ?? `https://github.com/${entry.fullName}`;
  const version = versionLabel(entry.version);
  // 非 DSH 独立工具：不加载进 profile，详情页要把与之无关的行和文案去掉
  const isTool = entry.ecosystem === "external";
  const backToList = isTool ? "/?scope=tools" : "/";
  const methodKey = entry.install.method in METHOD_LABEL ? (entry.install.method as MethodKey) : null;
  const methodLabel = methodKey ? t(METHOD_LABEL[methodKey]) : t("method.unknown");
  // 简介里的四个信息徽标用短标签，完整说明放在下方安装区，避免同一句话出现两遍
  const methodShort = methodKey ? t(METHOD_SHORT[methodKey]) : t("methodShort.unknown");
  // 与卡片同一口径：先去噪声标签；skill 的类型并进标签区，没有有效标签时用类型兜底，
  // 避免详情页出现一块空标签区，也与卡片底部保持一致。
  const detailTags = [
    ...(entry.type === "skill" ? ["skill"] : []),
    ...meaningfulTags(entry.tags),
  ];
  if (detailTags.length === 0) detailTags.push(isTool ? t("common.tool") : t("common.plugin"));

  const dims = [
    { label: t("detail.dim.popularity"), value: entry.score.popularity },
    { label: t("detail.dim.maintenance"), value: entry.score.maintenance },
    { label: t("detail.dim.utility"), value: entry.score.utility },
    { label: t("detail.dim.convenience"), value: entry.score.convenience },
  ];

  return (
    <main className="wrap detail">
      <Link className="back-link" to={backToList}>{t(isTool ? "detail.back.tools" : "detail.back.plugins")}</Link>

      <header className="detail-head">
        <div className="detail-title">
          <h1>{entry.name}</h1>
          {isTool && <span className="pill pill-tool">{t("common.tool")}</span>}
          {entry.curated && <span className="pill pill-curated">{t("common.curated")}</span>}
          <StarButton id={entry.id} withLabel />
        </div>
        <div className="detail-sub">
          <Avatar id={entry.id} />
          <a href={repoUrl} target="_blank" rel="noreferrer">{entry.fullName}</a>
          {version && <span className="detail-ver">{version}</span>}
          <span className="dot">·</span>
          <span>★ {formatStars(entry.stars)}</span>
          {entry.downloads !== null && (
            <>
              <span className="dot">·</span>
              <span title={t("card.dlTitle")}>{t("detail.weekDownloads", { n: formatDownloads(entry.downloads) ?? "—" })}</span>
            </>
          )}
          <span className="dot">·</span>
          <span>{relativeTime(entry.pushedAt, t)}</span>
        </div>
      </header>

      <section className="panel">
        <h2>{t("detail.about")}</h2>
        <div className="about-grid">
          <div className="about-main">
            {/* 固定两行高，超出部分省略；悬停可看全文 */}
            <p className="detail-desc" title={entry.descriptionZh ?? entry.description ?? ""}>
              {entry.descriptionZh ?? entry.description ?? t("common.noDesc")}
            </p>
            {/* 描述之外补四条可核对的事实，避免左栏只有一段文字显得空 */}
            <div className="about-facts">
              <span className="fact">
                <span className="fact-k">{t("detail.fact.stars")}</span>
                <span className="fact-v">★ {formatStars(entry.stars)}</span>
              </span>
              <span className="fact">
                <span className="fact-k">{t("detail.fact.updated")}</span>
                <span className="fact-v">{relativeTime(entry.pushedAt, t)}</span>
              </span>
              <span className="fact">
                <span className="fact-k">{t("detail.fact.firstSeen")}</span>
                <span className="fact-v">{entry.firstSeenAt.slice(0, 10)}</span>
              </span>
              <span className="fact">
                <span className="fact-k">{t("detail.fact.method")}</span>
                <span className="fact-v">{methodShort}</span>
              </span>
            </div>
            {detailTags.length > 0 && (
              <div className={`about-tags${tagsOpen ? "" : " is-capped"}`}>
                <div className="tags detail-tags" ref={tagsRef}>
                  {detailTags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
                </div>
                {overflowTags > 0 && (
                  <button type="button" className="tags-toggle" onClick={() => setTagsOpen((v) => !v)}>
                    {tagsOpen ? t("common.collapse") : `+${overflowTags}`}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 推荐依据跟简介放同一块：左边讲「是什么」，右边讲「为什么推荐」 */}
          <aside className="about-score">
            <div className="about-score-head">
              <span className="about-score-title">{t("detail.score")}</span>
              <span className="about-score-total">{t("detail.total")} <strong>{entry.score.total}</strong></span>
            </div>
            <div className="bars">
              {dims.map((d) => (
                <div className="bar-row" key={d.label}>
                  <span className="bar-label">{d.label}</span>
                  <span className="bar-track">
                    {/* 高分用主色、中低分逐级变浅，一眼能看出哪项拖了后腿 */}
                    <span
                      className={`bar-fill ${d.value >= 0.9 ? "is-high" : d.value >= 0.7 ? "is-mid" : "is-low"}`}
                      style={{ width: `${Math.round(d.value * 100)}%` }}
                    />
                  </span>
                  <span className="bar-value">{d.value.toFixed(2)}</span>
                </div>
              ))}
            </div>
            <p className="about-score-note">{t("detail.scoreNote")}</p>
          </aside>
        </div>

        {/* 来源并进简介底部：只留还需要看的两项，仓库链接与首次收录已在标题和徽标里 */}
        <div className="about-meta">
          <span className="about-meta-item">
            <span className="about-meta-k">{t("detail.meta.source")}</span>
            <span className="about-meta-v" title={entry.sources.join("、")}>{entry.sources.join(" · ")}</span>
          </span>
          <span className="about-meta-item">
            <span className="about-meta-k">{t("detail.meta.refreshed")}</span>
            <span className="about-meta-v">{entry.updatedAt.slice(0, 10)}</span>
          </span>
        </div>
      </section>

      <section className="panel">
        <h2>{t(isTool ? "detail.installTool" : "detail.install")}</h2>
        {isTool && (
          <p className="hint" style={{ marginTop: 0 }}>
            {t("detail.installToolNote")}
          </p>
        )}
        {/* 命令行与桌面版分开写：desktop profile 由 App 独占，把两者混成一段最容易误导 */}
        <div className="install-rows">
          <div className="install-row">
            <div className="install-row-head">
              <span className="install-row-k">{t("detail.row.cli")}</span>
              {entry.install.method === "pnpm-profile" && command && (
                <ProfilePicker value={profile} onChange={setProfile} compact />
              )}
            </div>
            <div>
              {shownCommand ? (
                <>
                  <div className="code">
                    <code>{shownCommand}</code>
                    <button onClick={copy}>{copied ? t("common.copied") : t("common.copy")}</button>
                  </div>
                  {entry.install.method === "skills-add" ? (
                    <p className="hint">{t("detail.hint.skill")}</p>
                  ) : entry.install.method === "standalone" ? (
                    <p className="hint">{t("detail.hint.standalone")}</p>
                  ) : entry.install.method === "native" ? (
                    <p className="hint">{t("detail.hint.native")}</p>
                  ) : (
                    <p className="hint">{t("detail.hint.pnpm")}</p>
                  )}
                  <div className="install-extra">
                    <button className="btn-assistant" onClick={copyForAssistant}>
                      {copiedAssistant ? t("sheet.copiedAssistant") : t("sheet.copyAssistant")}
                    </button>
                    <span className="hint">{t("detail.assistantNote")}</span>
                  </div>
                </>
              ) : entry.type === "skill" ? (
                <p className="install-row-note">{t("detail.skillNote")}</p>
              ) : (
                <p className="install-row-note">{t("detail.manualNote")}</p>
              )}
            </div>
          </div>

          {!isTool && <div className="install-row">
            <span className="install-row-k">{t("detail.row.desktop")}</span>
            <p className="install-row-note">
              {entry.install.method === "native"
                ? t("detail.desktop.native")
                : entry.type === "skill"
                  ? t("detail.desktop.skill")
                  : entry.install.packageName
                    ? <>{t("detail.desktop.pkgPre")}<code>{entry.install.packageName}</code>{t("detail.desktop.pkgPost")}</>
                    : t("detail.desktop.generic")}
            </p>
          </div>}
        </div>

        <dl className="kv">
          <dt>{t("detail.kv.method")}</dt><dd>{methodLabel}</dd>
          {/* 工具多数不走 npm（curl / brew / go install），没有包名就不摆这些空行 */}
          {(!isTool || entry.install.packageName) && (
            <>
              <dt>{t("detail.kv.pkg")}</dt>
              <dd>
                {entry.install.packageName ? (
                  <span className="kv-copy">
                    <code>{entry.install.packageName}</code>
                    <button className="btn-copy-sm" onClick={copyPkg}>{copiedPkg ? t("common.copied") : t("common.copy")}</button>
                  </span>
                ) : t("detail.kv.noPkg")}
              </dd>
              <dt>{t(isTool ? "detail.kv.toolVersion" : "detail.kv.version")}</dt>
              <dd>{entry.version ?? t("detail.kv.noVersion")}</dd>
              <dt>{t("detail.kv.downloads")}</dt>
              <dd>{entry.downloads !== null ? t("detail.dlValue", { n: entry.downloads.toLocaleString("en-US") }) : t("detail.kv.noDownloads")}</dd>
            </>
          )}
          {!isTool && <><dt>{t("detail.kv.engines")}</dt><dd>{entry.install.enginesDsh ?? t("detail.kv.undeclared")}</dd>
            <dt>{t("detail.kv.needsConfig")}</dt><dd>{entry.install.needsConfig ? t("detail.kv.yes") : t("detail.kv.no")}</dd></>}
          {entry.install.risky && <><dt>{t("detail.kv.risky")}</dt><dd>{t("detail.kv.riskyValue")}</dd></>}
        </dl>
      </section>

      <section className="panel">
        <h2>{t("detail.readme")}</h2>
        {readme === "loading" && <p className="hint" style={{ marginTop: 0 }}>{t("detail.readme.loading")}</p>}
        {readme === null && (
          <p className="hint" style={{ marginTop: 0 }}>
            {t("detail.readme.missing.pre")}<a href={`https://github.com/${entry.fullName}`} target="_blank" rel="noreferrer">{t("detail.readme.missing.link")}</a>。
          </p>
        )}
        {readme && readme !== "loading" && (
          <>
            {/* 详情页只放摘要，完整内容进弹窗 —— 有的 README 比整页还长，平铺会把安装/评分全挤下去 */}
            <div className="readme-clamp">
              <div className="readme" dangerouslySetInnerHTML={{ __html: readme.html }} />
            </div>
            <div className="readme-actions">
              <button className="btn-readme" onClick={() => setReadmeOpen(true)}>{t("detail.readme.viewFull")}</button>
              <a href={readme.url} target="_blank" rel="noreferrer">{t("detail.readme.original")}</a>
            </div>
          </>
        )}
      </section>

      {byAuthor.length > 0 && (
        <section className="panel">
          <h2>{t(isTool ? "detail.byAuthor.tools" : "detail.byAuthor.plugins")}</h2>
          <div className="grid grid-similar">
            {byAuthor.map((v) => (
              <PluginCard key={v.i} item={v} categories={new Set(categories.map((c) => c.t))} />
            ))}
          </div>
        </section>
      )}

      {similar.length > 0 && (
        <section className="panel">
          <h2>{t(isTool ? "detail.similar.tools" : "detail.similar.plugins")}</h2>
          <div className="grid grid-similar">
            {similar.map((v) => (
              <PluginCard key={v.i} item={v} categories={new Set(categories.map((c) => c.t))} />
            ))}
          </div>
        </section>
      )}

      <footer className="detail-foot">
        {siteConfig.siteName} · {t("detail.foot")}
      </footer>

      {readmeOpen && readme && readme !== "loading" && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setReadmeOpen(false); }}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("detail.readme.aria", { name: entry.name })}
          >
            <div className="modal-head">
              <strong>{entry.name} · {t("detail.readme")}</strong>
              <div className="modal-head-actions">
                <a href={readme.url} target="_blank" rel="noreferrer">GitHub</a>
                <button className="modal-close" onClick={() => setReadmeOpen(false)} aria-label={t("common.close")}>×</button>
              </div>
            </div>
            <div className="modal-body">
              <div className="readme" dangerouslySetInnerHTML={{ __html: readme.html }} />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
