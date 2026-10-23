import { useEffect, useRef, useState } from "react";
import type { LiteEntry } from "@dsh-shelfry/schema";
import { Link } from "react-router-dom";
import { detailPath, loadArtifacts, loadEntryById } from "../lib/data";
import { copyText } from "../lib/clipboard";
import { assistantPrompt } from "../lib/assistant";
import { applyProfile, useProfile } from "../lib/install";
import { ProfilePicker } from "./ProfilePicker";
import { StarButton } from "./StarButton";
import { categoryLabel, meaningfulTags } from "../lib/labels";
import { useT, type TFunc } from "../lib/i18n";

/** 「今天/3 天前/5 个月前」——比裸日期更容易判断插件还活不活。 */
export function relativeTime(iso: string | null, t: TFunc): string {
  if (!iso) return t("card.noCommit");
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return t("card.noCommit");
  if (days <= 0) return t("card.today");
  if (days < 30) return t("card.daysAgo", { n: days });
  if (days < 365) return t("card.monthsAgo", { n: Math.floor(days / 30) });
  return t("card.yearsAgo", { n: Math.floor(days / 365) });
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

/** 同一时刻只允许一张卡片打开安装浮层。 */
const SHEET_EVENT = "dsh-install-sheet";

/**
 * 卡片上的「安装」浮层。
 *
 * 命令不再塞进卡片流里 —— 那会把卡片撑高、连带同排其它卡片一起变形。
 * 浮层绝对定位在卡片本体上，卡片尺寸保持原样；命令不在 lite 切片里，
 * 打开时按需拉一次明细分片，拿到前先显示读取中。
 */
function InstallSheet({ item, onClose }: { item: LiteEntry; onClose: () => void }) {
  const [cmd, setCmd] = useState<string | null>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "copied" | "manual">("loading");
  const [copiedAssistant, setCopiedAssistant] = useState(false);
  const [more, setMore] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useProfile();
  const { t } = useT();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const artifacts = await loadArtifacts();
        const entry = await loadEntryById(artifacts, item.i);
        if (cancelled) return;
        const command = entry?.install.command ?? null;
        setCmd(command);
        setMethod(entry?.install.method ?? null);
        setState(command ? "ready" : "missing");
      } catch {
        if (!cancelled) setState("missing");
      }
    })();
    return () => { cancelled = true; };
  }, [item.i]);

  // ESC 或点浮层之外的任何地方都关闭，避免浮层粘在卡片上挡住浏览
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (!el?.closest(".install-sheet")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  // 卡片上的命令同样跟着 profile 选择走；上游安装器没有 --profile，原样返回
  const command = cmd ? applyProfile(cmd, profile) : null;

  const copy = async () => {
    if (!command) return;
    const ok = await copyText(command);
    setState(ok ? "copied" : "manual");
    if (ok) setTimeout(() => setState("ready"), 1600);
  };

  const copyAssistant = async () => {
    if (!command) return;
    const ok = await copyText(assistantPrompt({ name: item.n, repo: item.i, command }));
    if (ok) {
      setCopiedAssistant(true);
      setTimeout(() => setCopiedAssistant(false), 1600);
    } else {
      setState("manual");
    }
  };

  // 命令太长、内容超出卡片高度时，用底部渐隐代替系统滚动条提示还能下滑。
  // 滚动条本身在 CSS 里隐藏，滚到手底就把渐隐撤掉，避免盖住「查看详情」。
  const measure = () => {
    const el = bodyRef.current;
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  };
  useEffect(measure, [cmd, state]);

  return (
    <div className="install-sheet" onClick={(e) => e.stopPropagation()}>
      <div className="install-sheet-body" ref={bodyRef} onScroll={measure}>
        <div className="install-sheet-head">
          <span className="install-sheet-title">{item.n}</span>
          <button className="install-sheet-close" onClick={onClose} aria-label={t("common.close")}>×</button>
        </div>

        {state === "loading" && <p className="hint">{t("sheet.reading")}</p>}
        {state === "missing" && (
          <p className="hint">{t("sheet.missing")}</p>
        )}
        {command && (
          <>
            {method === "pnpm-profile" && (
              <ProfilePicker value={profile} onChange={setProfile} compact />
            )}
            <div className="code">
              <code>{command}</code>
              <button onClick={copy}>{state === "copied" ? t("common.copied") : t("common.copy")}</button>
            </div>
            <button className="btn-assistant" onClick={copyAssistant}>
              {copiedAssistant ? t("sheet.copiedAssistant") : t("sheet.copyAssistant")}
            </button>
            <p className="hint">
              {state === "manual"
                ? t("sheet.manual")
                : method === "native"
                  ? t("sheet.native")
                  : method === "standalone"
                    ? t("sheet.standalone")
                    : <>{t("sheet.profiles")}</>}
            </p>
          </>
        )}

        <Link className="install-sheet-more" to={detailPath(item.i)}>{t("sheet.more")}</Link>
      </div>
      {more && <span className="install-sheet-fade" aria-hidden="true" />}
    </div>
  );
}

/** 最多铺 2 条标签，其余收进 +N —— 再多就会挤到右下角的分类。 */
const MAX_TAGS = 2;

export function PluginCard({ item, categories }: { item: LiteEntry; categories: Set<string> }) {
  const [installOpen, setInstallOpen] = useState(false);
  const version = versionLabel(item.vr);
  const { t } = useT();

  // 别的卡片打开浮层时，这一张自动收起
  useEffect(() => {
    const onOther = (ev: Event) => {
      if ((ev as CustomEvent<string>).detail !== item.i) setInstallOpen(false);
    };
    window.addEventListener(SHEET_EVENT, onOther);
    return () => window.removeEventListener(SHEET_EVENT, onOther);
  }, [item.i]);

  const toggleInstall = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !installOpen;
    setInstallOpen(next);
    if (next) window.dispatchEvent(new CustomEvent(SHEET_EVENT, { detail: item.i }));
  };

  // 与详情页同一套标签口径：先去噪声标签，再挑一个分类固定到右下角。
  const tags = meaningfulTags(item.tg);
  const matched = tags.find((t) => categories.has(t)) ?? null;
  // 工具的标签常常是独一份，凑不满分类阈值（出现 ≥2 次）就兜底成「其他」，
  // 免得卡片右下角空着和别的工具不一致。
  const category = matched ?? (item.ec === "external" ? t("common.other") : null);
  const restTags = tags.filter((t) => t !== matched);
  const shownTags = restTags.slice(0, MAX_TAGS);
  // +N 要把「分类已显示」也算进去，这样 2 + N + 1 正好等于详情页的标签总数。
  // 兜底的「其他」不在 tags 里，只统计真实标签，不参与这个等式。
  const hiddenCount = tags.length - shownTags.length - (matched ? 1 : 0);

  return (
    <article className="card">
      <div className="card-head">
        <div className="card-title">
          {/* 链接::after 铺满整张卡片 ⇒ 卡片任意处可点，按钮靠 z-index 浮在上面 */}
          <Link className="card-name" to={detailPath(item.i)}>{item.n}</Link>
          {item.ec === "external" && <span className="pill pill-tool">{t("common.tool")}</span>}
          {item.t === "skill" && <span className="pill pill-type">skill</span>}
          {item.c === 1 && <span className="pill pill-curated">{t("common.curated")}</span>}
        </div>
        <div className="card-actions">
          <StarButton id={item.i} />
          <button className="btn-install" onClick={toggleInstall} title={t("card.installTitle")}>{t("card.install")}</button>
        </div>
      </div>

      <div className="card-path">
        <span className="path">{item.i}</span>
        {version && <span className="ver">{version}</span>}
      </div>

      <div className="card-meta">
        <Avatar id={item.i} />
        <span className="author-name">{ownerOf(item.i)}</span>
        <span className="dot">·</span>
        <span>{relativeTime(item.p, t)}</span>
      </div>

      <p className="card-desc">{item.d || t("common.noDesc")}</p>

      {/* 三项硬指标固定一行：星数、npm 周下载量、综合分，空值也占位，保证卡片等高 */}
      <div className="card-stats">
        <span className="stat" title={t("card.starsTitle", { n: item.s })}>
          <span className="stat-k">★</span>{formatStars(item.s)}
        </span>
        <span className="stat" title={t("card.dlTitle")}>
          <span className="stat-k">↓</span>{formatDownloads(item.dl) ?? "—"}
        </span>
        <span className="stat stat-end" title={t("card.scoreTitle")}>{t("card.score", { score: item.sc.toFixed(1) })}</span>
      </div>

      <div className="card-foot">
        <div className="tags">
          {shownTags.map((t) => <span className="tag" key={t}>{t}</span>)}
          {hiddenCount > 0 && <span className="tag tag-more">+{hiddenCount}</span>}
        </div>
        {category && <span className="tag tag-cat" title={t("common.category")}>{categoryLabel(category)}</span>}
      </div>

      {installOpen && <InstallSheet item={item} onClose={() => setInstallOpen(false)} />}
    </article>
  );
}
