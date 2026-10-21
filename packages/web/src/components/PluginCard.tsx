import { useState } from "react";
import type { LiteEntry } from "@dsh-shelfry/schema";
import { Link } from "react-router-dom";
import { detailPath, loadArtifacts, loadEntryById } from "../lib/data";
import { copyText } from "../lib/clipboard";
import { categoryLabel, meaningfulTags } from "../lib/labels";

/** 「今天/3 天前/5 个月前」——比裸日期更容易判断插件还活不活。 */
export function relativeTime(iso: string | null): string {
  if (!iso) return "无提交记录";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return "无提交记录";
  if (days <= 0) return "今天有提交";
  if (days < 30) return `${days} 天前更新`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前更新`;
  return `${Math.floor(days / 365)} 年前更新`;
}

const ownerOf = (id: string): string => {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(0, slash);
};

/** 插件自身版本 → `v1.66.44`；没有登记版本就不显示。 */
export function versionLabel(version: string | null): string | null {
  return version ? `v${version.replace(/^v/, "")}` : null;
}

/** 下载量：1.2k / 34.5k / 1.2M，太大就直接用 M。 */
export function formatDownloads(n: number | null): string | null {
  if (n === null || !Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 星数同样做压缩，避免五位数把一行撑开。 */
export function formatStars(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("en-US");
}

/**
 * 作者头像直接用 GitHub 的 .png 头像端点，不额外存字段、不加一次 API 调用；
 * 加载失败（改名/删号/离线）退回首字母占位。
 */
export function Avatar({ id }: { id: string }) {
  const owner = ownerOf(id);
  const [failed, setFailed] = useState(false);

  if (failed) return <span className="avatar avatar-fallback" aria-hidden="true">{owner.slice(0, 1).toUpperCase()}</span>;

  return (
    <img
      className="avatar"
      src={`https://github.com/${owner}.png?size=64`}
      alt=""
      width={18}
      height={18}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * 卡片上的「安装」按钮：点一下把安装命令复制走。
 *
 * 命令不在 lite 切片里（那会给全量浏览数据多背几百 KB），所以按需拉一次明细分片。
 * 异步取数会让浏览器丢掉「用户手势」，剪贴板可能被拒 —— 这时不跳走，
 * 改成在卡片里展开命令让用户手动复制。
 */
function InstallButton({
  id,
  cmd,
  onCmd,
}: {
  id: string;
  cmd: string | null;
  onCmd: (cmd: string | null) => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "manual">("idle");

  const onClick = async () => {
    if (state === "busy") return;
    setState("busy");
    try {
      let command = cmd;
      if (!command) {
        const artifacts = await loadArtifacts();
        const entry = await loadEntryById(artifacts, id);
        command = entry?.install.command ?? null;
        if (!command) { setState("idle"); return; }
        onCmd(command);
      }
      if (await copyText(command)) {
        setState("copied");
        setTimeout(() => setState("idle"), 1600);
      } else {
        setState("manual");
      }
    } catch {
      setState("idle");
    }
  };

  return (
    <button className="btn-install" onClick={onClick} title="复制安装命令">
      {state === "copied" ? "已复制" : state === "busy" ? "读取中" : state === "manual" ? "手动复制" : "安装"}
    </button>
  );
}

/** 最多铺 2 条标签，其余收进 +N —— 再多就会挤到右下角的分类。 */
const MAX_TAGS = 2;

export function PluginCard({ item, categories }: { item: LiteEntry; categories: Set<string> }) {
  const [cmd, setCmd] = useState<string | null>(null);
  const version = versionLabel(item.vr);
  // 与详情页同一套标签口径：先去噪声标签，再挑一个分类固定到右下角。
  const tags = meaningfulTags(item.tg);
  const category = tags.find((t) => categories.has(t)) ?? null;
  const restTags = tags.filter((t) => t !== category);
  const shownTags = restTags.slice(0, MAX_TAGS);
  // +N 要把「分类已显示」也算进去，这样 2 + N + 1 正好等于详情页的标签总数。
  const hiddenCount = tags.length - shownTags.length - (category ? 1 : 0);

  return (
    <article className="card">
      <div className="card-head">
        <div className="card-title">
          {/* 链接::after 铺满整张卡片 ⇒ 卡片任意处可点，按钮靠 z-index 浮在上面 */}
          <Link className="card-name" to={detailPath(item.i)}>{item.n}</Link>
          {item.t === "skill" && <span className="pill pill-type">skill</span>}
          {item.c === 1 && <span className="pill pill-curated">精选</span>}
        </div>
        <InstallButton id={item.i} cmd={cmd} onCmd={setCmd} />
      </div>

      <div className="card-path">
        <span className="path">{item.i}</span>
        {version && <span className="ver">{version}</span>}
      </div>

      <div className="card-meta">
        <Avatar id={item.i} />
        <span className="author-name">{ownerOf(item.i)}</span>
        <span className="dot">·</span>
        <span>{relativeTime(item.p)}</span>
      </div>

      <p className="card-desc">{item.d || "（上游未提供简介）"}</p>

      {/* 三项硬指标固定一行：星数、npm 周下载量、综合分，空值也占位，保证卡片等高 */}
      <div className="card-stats">
        <span className="stat" title={`${item.s} 个 star`}>
          <span className="stat-k">★</span>{formatStars(item.s)}
        </span>
        <span className="stat" title="npm 近一周下载量">
          <span className="stat-k">↓</span>{formatDownloads(item.dl) ?? "—"}
        </span>
        <span className="stat stat-end" title="综合推荐分">综合 {item.sc.toFixed(1)}</span>
      </div>

      {cmd && (
        <div className="card-cmd" onClick={(e) => e.stopPropagation()}>
          <code>{cmd}</code>
        </div>
      )}

      <div className="card-foot">
        <div className="tags">
          {shownTags.map((t) => <span className="tag" key={t}>{t}</span>)}
          {hiddenCount > 0 && <span className="tag tag-more">+{hiddenCount}</span>}
        </div>
        {category && <span className="tag tag-cat" title="分类">{categoryLabel(category)}</span>}
      </div>
    </article>
  );
}
