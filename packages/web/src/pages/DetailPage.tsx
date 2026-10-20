import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { PluginEntry } from "@dsh-shelfry/schema";
import { loadArtifacts, loadEntryById, siteConfig } from "../lib/data";
import { Avatar, relativeTime } from "../components/PluginCard";
import { copyText } from "../lib/clipboard";

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

  const copy = async () => {
    const cmd = entry?.install.command;
    if (!cmd) return;
    if (await copyText(cmd)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  if (state === "loading") {
    return <main className="wrap detail"><div className="empty">正在加载插件信息…</div></main>;
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
  const dims = [
    { label: "生态热度", value: entry.score.popularity },
    { label: "维护活跃", value: entry.score.maintenance },
    { label: "信息完整", value: entry.score.utility },
    { label: "上手便捷", value: entry.score.convenience },
  ];

  return (
    <main className="wrap detail">
      <Link className="back-link" to="/">← 返回全部插件</Link>

      <header className="detail-head">
        <div className="detail-title">
          <h1>{entry.name}</h1>
          {entry.type === "skill" && <span className="pill pill-type">skill</span>}
          {entry.curated && <span className="pill pill-curated">精选</span>}
        </div>
        <div className="detail-sub">
          <Avatar id={entry.id} />
          <a href={repoUrl} target="_blank" rel="noreferrer">{entry.fullName}</a>
          <span className="dot">·</span>
          <span>★ {entry.stars}</span>
          <span className="dot">·</span>
          <span>{relativeTime(entry.pushedAt)}</span>
        </div>
      </header>

      <section className="panel">
        <h2>简介</h2>
        <p className="detail-desc">{entry.descriptionZh ?? entry.description ?? "（上游未提供简介）"}</p>
        {entry.tags.length > 0 && (
          <div className="tags" style={{ marginTop: 12 }}>
            {entry.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>安装</h2>
        {entry.install.command ? (
          <>
            <div className="code">
              <code>{entry.install.command}</code>
              <button onClick={copy}>{copied ? "已复制" : "复制"}</button>
            </div>
            <p className="hint">
              把 <code>&lt;profile&gt;</code> 换成你要装入的 profile 名（如 web）。桌面版 profile 由 App 独占，不能用 CLI 安装。
            </p>
          </>
        ) : entry.type === "skill" ? (
          <p className="hint">
            skill 类内容没有等价的 CLI 安装命令 —— 它由 DSH 的 skill provider 扫描目录或随插件提供，请在 App 内管理。
          </p>
        ) : (
          <p className="hint">上游未写清安装命令，请按仓库 README 手动安装。</p>
        )}

        <dl className="kv">
          <dt>安装方式</dt><dd>{entry.install.method}</dd>
          <dt>兼容范围</dt><dd>{entry.install.enginesDsh ?? "上游未声明"}</dd>
          <dt>需要配置</dt><dd>{entry.install.needsConfig ? "是" : "否"}</dd>
          {entry.install.risky && <><dt>注意</dt><dd>安装路径较重或需额外授权</dd></>}
        </dl>
      </section>

      <section className="panel">
        <h2>推荐依据</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          综合分 {entry.score.total}，由下列四项加权得出，全部来自可核对的上游信息。
        </p>
        <div className="bars">
          {dims.map((d) => (
            <div className="bar-row" key={d.label}>
              <span className="bar-label">{d.label}</span>
              <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.round(d.value * 100)}%` }} /></span>
              <span className="bar-value">{d.value.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </section>

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
    </main>
  );
}
