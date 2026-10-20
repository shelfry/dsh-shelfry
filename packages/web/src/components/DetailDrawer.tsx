import { useEffect, useState } from "react";
import type { PluginEntry } from "@dsh-shelfry/schema";
import { StatusBadge, STATUS_CODE, STATUS_TEXT } from "./PluginCard";

/** 详情抽屉：展示安装命令 + 验证证据。证据必须可见 —— 「可验证的装得上」不能只靠一个徽章。 */
export function DetailDrawer({ entry, onClose }: { entry: PluginEntry; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const verified = entry.verification;
  const evidence: string[] = [];
  evidence.push(`状态：${STATUS_TEXT[verified.status]}`);
  if (verified.checkedAt) evidence.push(`验证时间：${verified.checkedAt}`);
  if (verified.dshVersion) evidence.push(`dsh 版本：${verified.dshVersion}`);
  if (verified.profile) evidence.push(`隔离 profile：${verified.profile}`);
  if (verified.l1) evidence.push(`L1 安装：${verified.l1.ok ? "通过" : "失败"}（${verified.l1.ms}ms）${verified.l1.error ? ` — ${verified.l1.error}` : ""}`);
  if (verified.l2) evidence.push(`L2 加载：${verified.l2.ok ? "通过" : "失败"}（${verified.l2.ms}ms）${verified.l2.error ? ` — ${verified.l2.error}` : ""}`);
  if (verified.diagnostics?.length) evidence.push("", ...verified.diagnostics);

  const copy = async () => {
    if (!entry.install.command) return;
    try {
      await navigator.clipboard.writeText(entry.install.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* 剪贴板不可用时忽略 */ }
  };

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <button className="close-btn" onClick={onClose} aria-label="关闭">×</button>
        <StatusBadge v={STATUS_CODE[verified.status]} />
        <h2>{entry.name}</h2>
        <div className="sub">{entry.fullName}</div>

        <section>
          <h3>简介</h3>
          <p style={{ margin: 0 }}>{entry.descriptionZh ?? entry.description ?? "（无简介）"}</p>
        </section>

        <section>
          <h3>安装</h3>
          {entry.install.command ? (
            <>
              <div className="code">
                <code>{entry.install.command}</code>
                <button onClick={copy}>{copied ? "已复制" : "复制"}</button>
              </div>
              <p style={{ margin: "8px 0 0", color: "var(--text-faint)", fontSize: 12.5 }}>
                把 <code>&lt;profile&gt;</code> 换成你要装入的 profile 名（如 web）。桌面版 profile 由 App 独占，不能用 CLI 安装。
              </p>
            </>
          ) : entry.type === "skill" ? (
            <p style={{ margin: 0, color: "var(--text-faint)" }}>
              skill 类内容没有等价的 CLI 安装命令 —— 它由 DSH 的 skill provider 扫描目录或随插件提供，请在 App 内管理。
            </p>
          ) : (
            <p style={{ margin: 0, color: "var(--text-faint)" }}>未识别到可自动执行的安装方式，请按仓库说明手动安装。</p>
          )}
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>安装方式</dt><dd>{entry.install.method}</dd>
            <dt>兼容范围</dt><dd>{entry.install.enginesDsh ?? "未声明"}</dd>
            <dt>需要额外配置</dt><dd>{entry.install.needsConfig ? "是" : "否"}</dd>
          </dl>
        </section>

        <section>
          <h3>验证证据</h3>
          <div className="evidence">{evidence.join("\n")}</div>
        </section>

        <section>
          <h3>信息</h3>
          <dl className="kv">
            <dt>Star</dt><dd>{entry.stars}</dd>
            <dt>综合分</dt><dd>{entry.score.total}（可装性 {entry.score.installable.toFixed(2)} / 维护 {entry.score.maintenance.toFixed(2)}）</dd>
            <dt>最近提交</dt><dd>{entry.pushedAt ?? "—"}</dd>
            <dt>标签</dt><dd>{entry.tags.join("、") || "—"}</dd>
            <dt>来源</dt><dd>{entry.sources.join("、")}</dd>
          </dl>
        </section>

        <div className="foot-note">
          仓库：{entry.homepage ? <a href={entry.homepage} target="_blank" rel="noreferrer">{entry.homepage}</a> : "—"}
          <br />
          收录于 {entry.firstSeenAt.slice(0, 10)}，最近更新 {entry.updatedAt.slice(0, 10)}
        </div>
      </aside>
    </>
  );
}
