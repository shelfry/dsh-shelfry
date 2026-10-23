import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { loadCategories, siteConfig, type Category } from "../lib/data";
import { categoryLabel } from "../lib/labels";
import { copyText } from "../lib/clipboard";

/**
 * 提交插件页（#/submit）。
 *
 * 站点是纯静态的，没有后端可提交，所以这里做两件事：
 *   1. 把用户填的内容整理成一份标准 issue 正文；
 *   2. 生成带 title/body 预填的 GitHub issue 链接，点一下就能提交。
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
    if (ok) setTimeout(() => setCopied(false), 2000);
  };

  const ready = !!parsed;

  return (
    <main className="wrap page-narrow">
      <section className="hero">
        <h1>提交插件或工具</h1>
        <p>填好仓库和安装规格，一键生成 GitHub Issue。收录由每日定时任务完成，无需你改代码。</p>
      </section>

      <section className="panel">
        <div className="field">
          <label htmlFor="repo">仓库地址 <span className="req">*</span></label>
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
              ? "支持完整链接、git@ 地址或 owner/repo 简写。"
              : parsed
                ? <>识别为 <a href={repoUrl} target="_blank" rel="noreferrer">{parsed.owner}/{parsed.repo}</a></>
                : <span className="bad">地址格式不对，需要形如 owner/repo。</span>}
          </div>
        </div>

        <div className="field">
          <label htmlFor="install">安装规格</label>
          <input
            id="install"
            value={install}
            onChange={(e) => setInstall(e.target.value)}
            placeholder="dsh-better-sidebar@latest"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="field-hint">插件只写 <code>dsh add</code> 后面的部分；非 DSH 工具可留空，README 里有安装命令即可。不确定就留空，维护者会补。</div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="category">分类</label>
            <select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">不指定</option>
              {categories.map((c) => (
                <option key={c.t} value={c.t}>{categoryLabel(c.t)}（{c.n}）</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="summary">一句话说明</label>
            <input
              id="summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="它解决什么问题"
              maxLength={80}
            />
          </div>
        </div>

        <details className="preview">
          <summary>预览 Issue 内容</summary>
          <pre>{title ? `${title}\n\n${body}` : body}</pre>
        </details>

        <div className="form-actions">
          <a
            className={`btn-primary${ready ? "" : " is-disabled"}`}
            href={ready ? issueUrl : undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!ready}
            onClick={(e) => { if (!ready) e.preventDefault(); }}
          >
            在 GitHub 提交
          </a>
          <button className="btn-ghost" onClick={onCopy} disabled={!ready}>
            {copied ? "已复制" : "复制内容"}
          </button>
          {!ready && <span className="form-note">填好仓库地址后即可生成链接。</span>}
        </div>
      </section>

      <section className="panel panel-soft">
        <h2 className="panel-title">收录规则</h2>
        <ul className="rule-list">
          <li>只收录公开 GitHub 仓库：DSH 插件 / skill 需要有可识别的 DSH 特征；非 DSH 项目必须写明 curl / brew / go install 等安装方式，并归入「工具」范围。</li>
          <li>工具需要满 3 星才会自动收录；不足 3 星的可通过本页提交，人工审核后放行。</li>
          <li>安装规格以 README 里明确写出的 <code>add</code>/<code>install</code> 命令为准，全局安装与本地路径不计。</li>
          <li>版本号与下载量来自 npm 或仓库 <code>package.json</code>，取不到就不显示。</li>
          <li>收录后可随时在站内搜索自己的仓库名确认；没有出现通常是仓库还没有 README 安装说明。</li>
        </ul>
        <p className="panel-foot">
          想直接看已收录的？<Link to="/">回到首页</Link>
        </p>
      </section>
    </main>
  );
}
