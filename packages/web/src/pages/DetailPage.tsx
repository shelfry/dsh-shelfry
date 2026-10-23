import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { LiteEntry, PluginEntry } from "@dsh-shelfry/schema";
import { loadArtifacts, loadCategories, loadEntryById, loadLite, siteConfig, type Category } from "../lib/data";
import { Avatar, formatDownloads, formatStars, PluginCard, relativeTime, versionLabel } from "../components/PluginCard";
import { copyText } from "../lib/clipboard";
import { assistantPrompt } from "../lib/assistant";
import { DEFAULT_PROFILE, applyProfile, useProfile } from "../lib/install";
import { ProfilePicker } from "../components/ProfilePicker";
import { meaningfulTags } from "../lib/labels";
import { loadReadme, type ReadmeResult } from "../lib/readme";

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

  const copy = async () => {
    if (!command) return;
    if (await copyText(command)) {
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
    if (!command || !entry) return;
    const ok = await copyText(assistantPrompt({ name: entry.name, repo: entry.fullName, command }));
    if (ok) {
      setCopiedAssistant(true);
      setTimeout(() => setCopiedAssistant(false), 1600);
    }
  };

  if (state === "loading") {
    return <main className="wrap detail"><div className="empty">正在加载条目信息…</div></main>;
  }
  if (state === "missing" || state === "error") {
    return (
      <main className="wrap detail">
        <div className="empty">
          <p>{state === "missing" ? `没有收录 ${decoded}` : "插件信息加载失败，请稍后重试。"}</p>
          <Link className="back-link" to="/">← 返回全部插件</Link>
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
  const methodLabel =
    entry.install.method === "pnpm-profile"
      ? "CLI 装入 profile（pnpm）"
      : entry.install.method === "standalone"
        ? "独立工具，按上游 README 安装"
        : entry.install.method === "native"
          ? "上游自带安装器"
          : entry.install.method === "skills-add"
            ? "随 skill provider 提供"
            : entry.install.method === "manual"
              ? "按 README 手动安装"
              : "未知";
  // 简介里的四个信息徽标用短标签，完整说明放在下方安装区，避免同一句话出现两遍
  const methodShort =
    entry.install.method === "pnpm-profile"
      ? "pnpm profile"
      : entry.install.method === "standalone"
        ? "独立安装"
        : entry.install.method === "native"
          ? "自带安装器"
          : entry.install.method === "skills-add"
            ? "skill"
            : entry.install.method === "manual"
              ? "手动安装"
              : "未知";
  // 与卡片同一口径：卡片上显示「2 条 + +N + 分类」，这里的总数必须对上。
  const detailTags = meaningfulTags(entry.tags);
  const dims = [
    { label: "生态热度", value: entry.score.popularity },
    { label: "维护活跃", value: entry.score.maintenance },
    { label: "信息完整", value: entry.score.utility },
    { label: "上手便捷", value: entry.score.convenience },
  ];

  return (
    <main className="wrap detail">
      <Link className="back-link" to={backToList}>← 返回全部{isTool ? "工具" : "插件"}</Link>

      <header className="detail-head">
        <div className="detail-title">
          <h1>{entry.name}</h1>
          {isTool && <span className="pill pill-tool">工具</span>}
          {entry.type === "skill" && <span className="pill pill-type">skill</span>}
          {entry.curated && <span className="pill pill-curated">精选</span>}
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
              <span title="npm 近一周下载量">↓ {formatDownloads(entry.downloads)}/周</span>
            </>
          )}
          <span className="dot">·</span>
          <span>{relativeTime(entry.pushedAt)}</span>
        </div>
      </header>

      <section className="panel">
        <h2>简介</h2>
        <div className="about-grid">
          <div className="about-main">
            <p className="detail-desc">{entry.descriptionZh ?? entry.description ?? "（上游未提供简介）"}</p>
            {/* 描述之外补四条可核对的事实，避免左栏只有一段文字显得空 */}
            <div className="about-facts">
              <span className="fact">
                <span className="fact-k">星标</span>
                <span className="fact-v">★ {formatStars(entry.stars)}</span>
              </span>
              <span className="fact">
                <span className="fact-k">最近更新</span>
                <span className="fact-v">{relativeTime(entry.pushedAt)}</span>
              </span>
              <span className="fact">
                <span className="fact-k">首次收录</span>
                <span className="fact-v">{entry.firstSeenAt.slice(0, 10)}</span>
              </span>
              <span className="fact">
                <span className="fact-k">安装方式</span>
                <span className="fact-v">{methodShort}</span>
              </span>
            </div>
            {detailTags.length > 0 && (
              <div className="tags detail-tags">
                {detailTags.map((t) => <span className="tag" key={t}>{t}</span>)}
              </div>
            )}
          </div>

          {/* 推荐依据跟简介放同一块：左边讲「是什么」，右边讲「为什么推荐」 */}
          <aside className="about-score">
            <div className="about-score-head">
              <span className="about-score-title">推荐依据</span>
              <span className="about-score-total">综合 <strong>{entry.score.total}</strong></span>
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
            <p className="about-score-note">四项加权，全部来自可核对的上游信息。</p>
          </aside>
        </div>
      </section>

      <section className="panel">
        <h2>{isTool ? "安装（独立工具）" : "安装"}</h2>
        {isTool && (
          <p className="hint" style={{ marginTop: 0 }}>
            这是非 DSH 独立工具，命令摘自上游 README，装在本机直接使用，不经过插件 profile。
          </p>
        )}
        {/* 命令行与桌面版分开写：desktop profile 由 App 独占，把两者混成一段最容易误导 */}
        <div className="install-rows">
          <div className="install-row">
            <div className="install-row-head">
              <span className="install-row-k">命令行</span>
              {entry.install.method === "pnpm-profile" && command && (
                <ProfilePicker value={profile} onChange={setProfile} compact />
              )}
            </div>
            <div>
              {command ? (
                <>
                  <div className="code">
                    <code>{command}</code>
                    <button onClick={copy}>{copied ? "已复制" : "复制"}</button>
                  </div>
                  {entry.install.method === "standalone" ? (
                    <p className="hint">
                      命令来自上游 README 的快速开始，直接执行即可；安装后的用法以仓库说明为准。
                    </p>
                  ) : entry.install.method === "native" ? (
                    <p className="hint">
                      这是上游自带的安装器：会先给出安装计划，确认后再写入配置；装完请按 README 验证是否连上。
                    </p>
                  ) : (
                    <p className="hint">
                      <code>web</code> / <code>tui</code> 都是 DSH 自带的 profile，首次使用会自动创建、命令可直接执行；也可以填自己的 profile 名。
                    </p>
                  )}
                  <div className="install-extra">
                    <button className="btn-assistant" onClick={copyForAssistant}>
                      {copiedAssistant ? "已复制，粘贴给助手" : "复制给编程助手"}
                    </button>
                    <span className="hint">连同「先给计划、确认后执行、最后验证」的要求一起复制</span>
                  </div>
                </>
              ) : entry.type === "skill" ? (
                <p className="install-row-note">skill 由 skill provider 扫描目录或随插件提供，没有等价的 CLI 安装动作。</p>
              ) : (
                <p className="install-row-note">上游未写清安装命令，请按仓库 README 手动安装。</p>
              )}
            </div>
          </div>

          {!isTool && <div className="install-row">
            <span className="install-row-k">桌面版</span>
            <p className="install-row-note">
              {entry.install.method === "native"
                ? "上游安装器会写入你当前所用编程助手的配置；DSH App 桌面版是否同样适用，请以仓库 README 为准。"
                : entry.type === "skill"
                  ? "skill 在 DSH App 里启用和管理，桌面版 profile 由 App 独占，不能用 CLI 装。"
                  : entry.install.packageName
                    ? <>桌面版 profile 由 App 独占，CLI 装不进去；请在 DSH App 的插件面板里添加 <code>{entry.install.packageName}</code>。</>
                    : "桌面版 profile 由 App 独占，CLI 装不进去；请在 DSH App 的插件面板里添加该插件。"}
            </p>
          </div>}
        </div>

        <dl className="kv">
          <dt>安装方式</dt><dd>{methodLabel}</dd>
          {/* 工具多数不走 npm（curl / brew / go install），没有包名就不摆这些空行 */}
          {(!isTool || entry.install.packageName) && (
            <>
              <dt>npm 包名</dt>
              <dd>
                {entry.install.packageName ? (
                  <span className="kv-copy">
                    <code>{entry.install.packageName}</code>
                    <button className="btn-copy-sm" onClick={copyPkg}>{copiedPkg ? "已复制" : "复制"}</button>
                  </span>
                ) : "无（非 npm 分发）"}
              </dd>
              <dt>{isTool ? "版本" : "插件版本"}</dt>
              <dd>{entry.version ?? "未在 npm 发布"}</dd>
              <dt>周下载量</dt>
              <dd>{entry.downloads !== null ? `${entry.downloads.toLocaleString("en-US")} 次` : "未在 npm 统计"}</dd>
            </>
          )}
          {!isTool && <><dt>兼容范围</dt><dd>{entry.install.enginesDsh ?? "上游未声明"}</dd>
            <dt>需要配置</dt><dd>{entry.install.needsConfig ? "是" : "否"}</dd></>}
          {entry.install.risky && <><dt>注意</dt><dd>安装路径较重或需额外授权</dd></>}
        </dl>
      </section>

      <section className="panel">
        <h2>README</h2>
        {readme === "loading" && <p className="hint" style={{ marginTop: 0 }}>正在读取仓库 README…</p>}
        {readme === null && (
          <p className="hint" style={{ marginTop: 0 }}>
            这个仓库没有可直接渲染的 README，<a href={`https://github.com/${entry.fullName}`} target="_blank" rel="noreferrer">去 GitHub 看看</a>。
          </p>
        )}
        {readme && readme !== "loading" && (
          <>
            {/* 详情页只放摘要，完整内容进弹窗 —— 有的 README 比整页还长，平铺会把安装/评分全挤下去 */}
            <div className="readme-clamp">
              <div className="readme" dangerouslySetInnerHTML={{ __html: readme.html }} />
            </div>
            <div className="readme-actions">
              <button className="btn-readme" onClick={() => setReadmeOpen(true)}>查看完整 README</button>
              <a href={readme.url} target="_blank" rel="noreferrer">在 GitHub 查看原文</a>
            </div>
          </>
        )}
      </section>

      {byAuthor.length > 0 && (
        <section className="panel">
          <h2>同作者的其他{isTool ? "工具" : "插件"}</h2>
          <div className="grid grid-similar">
            {byAuthor.map((v) => (
              <PluginCard key={v.i} item={v} categories={new Set(categories.map((c) => c.t))} />
            ))}
          </div>
        </section>
      )}

      {similar.length > 0 && (
        <section className="panel">
          <h2>相似{isTool ? "工具" : "插件"}</h2>
          <div className="grid grid-similar">
            {similar.map((v) => (
              <PluginCard key={v.i} item={v} categories={new Set(categories.map((c) => c.t))} />
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>来源</h2>
        <dl className="kv">
          <dt>仓库</dt><dd><a href={repoUrl} target="_blank" rel="noreferrer">{repoUrl}</a></dd>
          <dt>收录来源</dt><dd>{entry.sources.join("、")}</dd>
          <dt>首次收录</dt><dd>{entry.firstSeenAt.slice(0, 10)}</dd>
          <dt>最近更新</dt><dd>{entry.updatedAt.slice(0, 10)}</dd>
        </dl>
      </section>

      <footer className="detail-foot">
        {siteConfig.siteName} · 数据每日自动刷新
      </footer>

      {readmeOpen && readme && readme !== "loading" && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setReadmeOpen(false); }}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${entry.name} 的完整 README`}
          >
            <div className="modal-head">
              <strong>{entry.name} · README</strong>
              <div className="modal-head-actions">
                <a href={readme.url} target="_blank" rel="noreferrer">GitHub</a>
                <button className="modal-close" onClick={() => setReadmeOpen(false)} aria-label="关闭">×</button>
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
