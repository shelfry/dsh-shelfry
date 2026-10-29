import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { loadCategories, siteConfig, type Category } from "../lib/data";
import { categoryLabel } from "../lib/labels";
import { copyText } from "../lib/clipboard";
import { useT } from "../lib/i18n";
import { SEO_SITE_NAME, useSeo } from "../lib/seo";

/**
 * 提交插件页（/submit）。
 *
 * 主路径：直接 POST /api/curation 的 submit 动作，仓库进入「待确认收录」，
 * 站长在收录面板里核实后再决定是否收录。
 * 备用路径：生成带 title/body 预填的 GitHub issue 链接，静态兜底环境（GitHub Pages）也能提交。
 * 内容格式跟着收录管道的口径走（仓库 + 安装规格），免得维护者再回头问一遍。
 */

interface RepoRef {
  owner: string;
  repo: string;
}

/** 兼容 https://github.com/o/r、git@github.com:o/r.git、o/r 三种写法。 */
function parseRepo(input: string): RepoRef | null {
  const raw = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!raw) return null;
  let rest = raw;
  const https = raw.match(/^https?:\/\/(?:www\.)?github\.com\/(.+)$/i);
  const ssh = raw.match(/^git@github\.com:(.+)$/i);
  if (https) rest = https[1]!;
  else if (ssh) rest = ssh[1]!;
  else if (/^https?:\/\//i.test(raw)) return null;
  const parts = rest.split("/");
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

export default function SubmitPage() {
  const [repoInput, setRepoInput] = useState("");
  const [install, setInstall] = useState("");
  const [category, setCategory] = useState("");
  const [summary, setSummary] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [copied, setCopied] = useState(false);
  // 复制反馈的定时器：连点时先清掉上一个，卸载时一并清理
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const { t } = useT();
  useSeo({
    title: `${t("nav.submit")} · ${SEO_SITE_NAME}`,
    description: "提交一个 DSH 插件或非 DSH 独立工具：填写仓库与安装方式，站长确认后收录。",
    path: "/submit",
  });

  // 分类候选来自已收录数据：新插件也能一眼看到现有口径，减少口径漂移
  useEffect(() => {
    loadCategories()
      .then((list) => setCategories(list.slice(0, 40)))
      .catch(() => { /* 分类取不到就不给下拉，手写也行 */ });
  }, []);

  const parsed = useMemo(() => parseRepo(repoInput), [repoInput]);
  const repoUrl = parsed ? `https://github.com/${parsed.owner}/${parsed.repo}` : "";

  const title = parsed ? `[插件提交] ${parsed.owner}/${parsed.repo}` : "";

  const body = useMemo(() => {
    const lines = [
      "### 插件信息",
      `- 仓库：${repoUrl || "（未填写）"}`,
    ];
    if (install.trim()) lines.push(`- 安装规格：\`${install.trim()}\``);
    if (category) lines.push(`- 分类：${categoryLabel(category)}（${category}）`);
    if (summary.trim()) lines.push(`- 一句话说明：${summary.trim()}`);
    lines.push(
      "",
      "### 提交前自检",
      "- [ ] 仓库公开可访问，README 里有安装方式",
      "- [ ] 插件：安装规格写的是 `add` 后面的部分，例如 `dsh-market/dsh-market` 或 `dsh-better-sidebar@1.2.0`",
      "- [ ] 工具：不是 DSH 插件，README 里有 curl / brew / go install 等可直接执行的安装命令",
      "- [ ] 不是 fork 或纯清单仓库",
      "",
      "<!-- 提交后由每日定时任务抓取，一般次日出现在站内 -->",
    );
    return lines.join("\n");
  }, [repoUrl, install, category, summary]);

  const issueUrl = `${siteConfig.repoUrl}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=plugin-submission`;

  const onCopy = async () => {
    const ok = await copyText(`${title}\n\n${body}`);
    setCopied(ok);
    if (ok) {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    }
  };

  // 站内提交：进待确认列表，等站长在收录面板核实
  const onSubmit = async () => {
    if (!parsed || submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/curation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          repo: `${parsed.owner}/${parsed.repo}`,
          install: install.trim(),
          category,
          summary: summary.trim(),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { status?: string; error?: string; message?: string }
        | null;
      if (res.status === 403 || data?.error === "blocked") {
        setResult({ kind: "error", text: t("submit.blocked") });
        return;
      }
      if (!res.ok) {
        throw new Error(data?.message ?? `HTTP ${res.status}`);
      }
      setResult({
        kind: "ok",
        text: data?.status === "queued" ? t("submit.alreadyQueued") : t("submit.submitted"),
      });
    } catch (err) {
      setResult({
        kind: "error",
        text: t("submit.failed", { msg: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const ready = !!parsed;

  return (
    <main className="wrap page-narrow">
      <section className="hero">
        <h1>{t("submit.title")}</h1>
        <p>{t("submit.intro")}</p>
      </section>

      <section className="panel">
        <div className="field">
          <label htmlFor="repo">{t("submit.repo")} <span className="req">*</span></label>
          <input
            id="repo"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="https://github.com/owner/repo 或 owner/repo"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="field-hint">
            {repoInput.trim() === ""
              ? t("submit.repoHint.empty")
              : parsed
                ? <>{t("submit.repoHint.okPre")}<a href={repoUrl} target="_blank" rel="noreferrer">{parsed.owner}/{parsed.repo}</a>{t("submit.repoHint.okPost")}</>
                : <span className="bad">{t("submit.repoHint.bad")}</span>}
          </div>
        </div>

        <div className="field">
          <label htmlFor="install">{t("submit.install")}</label>
          <input
            id="install"
            value={install}
            onChange={(e) => setInstall(e.target.value)}
            placeholder="dsh-better-sidebar@latest"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="field-hint">{t("submit.installHint")}</div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="category">{t("submit.category")}</label>
            <select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t("submit.category.none")}</option>
              {categories.map((c) => (
                <option key={c.t} value={c.t}>{categoryLabel(c.t)}（{c.n}）</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="summary">{t("submit.summary")}</label>
            <input
              id="summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t("submit.summaryPlaceholder")}
              maxLength={200}
            />
            <div className="field-hint">{t("submit.summaryCount", { n: summary.length })}</div>
          </div>
        </div>

        <details className="preview">
          <summary>{t("submit.preview")}</summary>
          <pre>{title ? `${title}\n\n${body}` : body}</pre>
        </details>

        <div className="form-actions">
          <button
            type="button"
            className={`btn-primary${ready ? "" : " is-disabled"}`}
            disabled={!ready || submitting}
            onClick={() => void onSubmit()}
          >
            {submitting ? t("submit.submitting") : t("submit.station")}
          </button>
          <a
            className={`btn-ghost${ready ? "" : " is-disabled"}`}
            href={ready ? issueUrl : undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!ready}
            onClick={(e) => { if (!ready) e.preventDefault(); }}
          >
            {t("submit.github")}
          </a>
          <button className="btn-ghost" onClick={onCopy} disabled={!ready}>
            {copied ? t("common.copied") : t("submit.copy")}
          </button>
          {!ready && <span className="form-note">{t("submit.fillRepo")}</span>}
        </div>

        {result && <p className={`submit-status ${result.kind}`}>{result.text}</p>}
      </section>

      <section className="panel panel-soft">
        <h2 className="panel-title">{t("submit.rules")}</h2>
        <ul className="rule-list">
          <li>{t("submit.rule1")}</li>
          <li>{t("submit.rule2")}</li>
          <li>{t("submit.rule3")}</li>
          <li>{t("submit.rule4")}</li>
          <li>{t("submit.rule5")}</li>
        </ul>
        <p className="panel-foot">
          {t("submit.backHome.pre")}<Link to="/">{t("submit.backHome.link")}</Link>
        </p>
      </section>
    </main>
  );
}
