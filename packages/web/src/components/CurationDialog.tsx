import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { normalizeGitHubRepo } from "@dsh-shelfry/schema";
import { loadCollectedIds } from "../lib/data";
import { useT } from "../lib/i18n";

/**
 * 收录管理面板：站长专用，挂在顶部「收录」按钮下方。
 *
 * 打开后先是密码闸门：服务端校验通过才显示名单与操作，
 * 校验用的密码留在内存里供后续写操作复用，关掉面板立即清空。
 * 名单读写走 /api/curation（Pages Function + KV），写成功后直接用响应刷新。
 */

type Tab = "pending" | "queue" | "block";
/** 写接口的超时上限：国内直连偶发挂起，超过它就让用户重试而不是无限转圈 */
const POST_TIMEOUT_MS = 8000;
type Action = "queue" | "block" | "unqueue" | "approve" | "dismiss" | "prune";
/** 需要二次确认的操作：prune 是批量，其余用 target 定位单条 */
type ConfirmAction = "dismiss" | "unqueue" | "block" | "prune" | "restore";
type OkKey =
  | "curation.queued"
  | "curation.blocked"
  | "curation.unqueued"
  | "curation.restored"
  | "curation.approved"
  | "curation.dismissed"
  | "curation.pruned";

/** 访客提交的收录申请，只有解锁后才可见 */
interface PendingItem {
  repo: string;
  install?: string;
  category?: string;
  summary?: string;
  at: string;
}

interface Lists {
  queue: string[];
  blocklist: string[];
  pending: PendingItem[];
}

interface ApiError {
  message?: string;
}

const API = "/api/curation";

/**
 * 名单右侧状态图标：空心圆 = 等下次构建生效，圈内绿勾 = 已生效。
 * 两种状态的圈径与线宽完全一致，切换时只是圈内多一笔勾，图标不会跳动。
 * 收录队列与剔除记录共用同一套视觉，避免两处状态样式不一致。
 */
function StatusIcon({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={`curation-icon${done ? " done" : ""}`} role="img" aria-label={label} title={label}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        {done ? (
          <>
            {/* 圈与待生效的空心圆同径同粗，只在内部多一个勾 */}
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M4.5 7.2l1.6 1.6 3.3-3.6"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
        )}
      </svg>
    </span>
  );
}

export function CurationDialog({
  open,
  onClose,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLSpanElement | null>;
}) {
  const { t } = useT();
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("pending");
  const [repo, setRepo] = useState("");
  const [lists, setLists] = useState<Lists | null>(null);
  /** 已收录仓库：用来给队列条目标状态，并决定「清理已收录」是否可点 */
  const [collected, setCollected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  /** 名单默认收起：只露标题与数量，点「展开记录」才列出条目 */
  const [listOpen, setListOpen] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  /** 破坏性/不可逆操作的二次确认：非空时弹出居中确认框 */
  const [confirm, setConfirm] = useState<{ action: ConfirmAction; target?: string } | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * 判断某个仓库是否已收录。
   *
   * 入参 id：队列里的仓库全名，大小写可能与数据里的原始写法不同。
   * 返回值：已收录为 true；名单尚未加载完成时返回 false。
   */
  const isCollected = (id: string) => collected?.has(id.toLowerCase()) ?? false;

  // 面板直接挂在 body 上（头部有 backdrop-filter，fixed 子元素会被困在头部盒子里）：
  // 桌面贴着固定导航下沿、右边缘与「收录」按钮对齐；手机版交给媒体查询改成居中弹窗。
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const header = anchor.closest("header");
      const bottom = header ? header.getBoundingClientRect().bottom : rect.bottom;
      setPos({
        top: Math.round(bottom + 8),
        right: Math.round(Math.max(12, window.innerWidth - rect.right)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchorRef]);

  // 关闭即清空凭据；点面板外或按 ESC 收起
  useEffect(() => {
    if (!open) {
      setAuthed(false);
      setPassword("");
      setRepo("");
      setNotice(null);
      setLists(null);
      setCollected(null);
      setListOpen(false);
      setConfirm(null);
      // 页签也归位：下次打开从「待确认」开始，不沿用上次停留的页签
      setTab("pending");
      return;
    }
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      // 确认框开着时点面板外只收起确认框，面板本身留着，避免一次误点丢掉整个操作现场
      if (confirm) {
        setConfirm(null);
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      // 确认框开着时 ESC 只关确认框，不连整个面板一起收掉
      if (e.key === "Escape") {
        if (confirm) setConfirm(null);
        else onClose();
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef, confirm]);

  const parse = (data: unknown, status: number): Lists => {
    const body = (data ?? {}) as Partial<Lists> & ApiError;
    if (status >= 400) throw Object.assign(new Error(body.message ?? `HTTP ${status}`), { status });
    return {
      queue: body.queue ?? [],
      blocklist: body.blocklist ?? [],
      pending: Array.isArray(body.pending) ? body.pending : [],
    };
  };

  const post = async (payload: Record<string, unknown>) => {
    // 接口被墙或挂起时不能无限转圈：8 秒兜底中断，并转成可读文案
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      return parse(await res.json().catch(() => null), res.status);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw new Error(t("curation.timeout"));
      throw err;
    } finally {
      window.clearTimeout(timer);
    }
  };

  const unlock = async () => {
    if (!password) {
      setNotice({ kind: "error", text: t("curation.needPassword") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // 先解锁再拉名单：密码错时不该白下载 400 KB 的反查表
      const next = await post({ action: "auth", password });
      setLists(next);
      setAuthed(true);
      // 名单状态是锦上添花：后台补，别让 400 KB 的反查表把弹窗卡在加载态
      loadCollectedIds()
        .then((ids) => setCollected(ids))
        .catch(() => setCollected(null));
    } catch (err) {
      const status = (err as { status?: number }).status;
      setNotice({
        kind: "error",
        text: status === 401
          ? t("curation.wrongPassword")
          : t("curation.failed", { msg: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setBusy(false);
    }
  };

  const fail = (err: unknown) => {
    const status = (err as { status?: number }).status;
    if (status === 401) {
      // 密码被改过：退回闸门，别让后续操作继续失败
      setAuthed(false);
      setPassword("");
      setNotice({ kind: "error", text: t("curation.wrongPassword") });
    } else {
      setNotice({
        kind: "error",
        text: t("curation.failed", { msg: err instanceof Error ? err.message : String(err) }),
      });
    }
  };

  const run = async (action: Action, target: string, okKey: OkKey) => {
    const repoId = normalizeGitHubRepo(target);
    if (!repoId) {
      setNotice({ kind: "error", text: t("curation.badRepo") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const next = await post({ action, repo: repoId, password });
      setLists(next);
      setNotice({ kind: "ok", text: t(okKey) });
      setConfirm(null);
      if (action !== "unqueue") setRepo("");
      // 剔除成功后直接展开，让用户马上看到新记录和它的下线状态
      if (action === "block") setListOpen(true);
    } catch (err) {
      // 失败也收起确认框，错误信息交给下方状态行展示
      fail(err);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  /** 只清理「确实已经在站点里」的队列条目，未收录的保持不动 */
  const prune = async () => {
    const targets = (lists?.queue ?? []).filter((id) => isCollected(id));
    if (targets.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = await post({ action: "prune", repos: targets, password });
      setLists(next);
      setNotice({ kind: "ok", text: t("curation.pruned", { n: targets.length }) });
      setConfirm(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const isPending = tab === "pending";
  const isQueue = tab === "queue";
  const pending = lists?.pending ?? [];
  const current = lists ? (isQueue ? lists.queue : lists.blocklist) : [];
  const indexed = isQueue && collected ? current.filter((id) => isCollected(id)) : [];

  /** 确认框提示文案：按操作类型取对应句子 */
  const confirmMessage = () => {
    if (!confirm) return "";
    switch (confirm.action) {
      case "block": return t("curation.confirmBlock", { repo: confirm.target ?? "" });
      case "dismiss": return t("curation.confirmDismiss");
      case "unqueue": return t("curation.confirmUnqueue");
      case "prune": return t("curation.confirmPrune", { n: indexed.length });
      case "restore": return t("curation.confirmRestore", { repo: confirm.target ?? "" });
    }
  };

  /** 点「确认」才真正提交；恢复收录复用 queue 接口 */
  const execConfirm = () => {
    if (!confirm) return;
    const target = confirm.target ?? repo;
    switch (confirm.action) {
      case "prune":
        void prune();
        break;
      case "restore":
        void run("queue", target, "curation.restored");
        break;
      case "block":
        void run("block", target, "curation.blocked");
        break;
      case "dismiss":
        void run("dismiss", target, "curation.dismissed");
        break;
      case "unqueue":
        void run("unqueue", target, "curation.unqueued");
        break;
    }
  };

  /**
   * 提交输入框里的仓库。
   *
   * 加入队列是意图明确的无害操作，直接执行；剔除会让仓库从站点下线，
   * 先切到确认态，等用户点「确认」再真正提交。
   */
  const submitRepo = () => {
    if (isQueue) {
      void run("queue", repo, "curation.queued");
      return;
    }
    setNotice(null);
    setConfirm({ action: "block", target: repo.trim() });
  };

  return createPortal(
    <div
      ref={menuRef}
      className="curation-menu"
      role="dialog"
      aria-label={t("curation.title")}
      style={
        pos
          ? ({ "--curation-top": `${pos.top}px`, "--curation-right": `${pos.right}px` } as CSSProperties)
          : undefined
      }
    >
      <div className="modal-head">
        <strong>{t("curation.title")}</strong>
        <button className="modal-close" onClick={onClose} aria-label={t("common.close")}>×</button>
      </div>

      {!authed ? (
        <div className="curation-body">
          <p className="curation-note">{t("curation.gateNote")}</p>
          <div className="curation-actions">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void unlock();
              }}
              placeholder={t("curation.passwordPlaceholder")}
              aria-label={t("curation.password")}
              autoComplete="current-password"
              autoFocus
            />
            <button type="button" className="btn-primary" disabled={busy || !password} onClick={() => void unlock()}>
              {busy ? t("curation.working") : t("curation.enter")}
            </button>
          </div>
          {notice && <p className={`curation-status ${notice.kind}`}>{notice.text}</p>}
        </div>
      ) : (
        <>
          <div className="curation-tabs" role="tablist" aria-label={t("curation.title")}>
            {(["pending", "queue", "block"] as Tab[]).map((key) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className="curation-tab"
                onClick={() => {
                  setTab(key);
                  setNotice(null);
                  setRepo("");
                  setListOpen(false);
                  setConfirm(null);
                }}
              >
                {key === "pending"
                  ? t("curation.tab.pending", { n: pending.length })
                  : t(key === "queue" ? "curation.tab.queue" : "curation.tab.block")}
              </button>
            ))}
          </div>

          <div className="curation-body">
            <p className="curation-note">
              {t(isPending ? "curation.pendingNote" : isQueue ? "curation.queueNote" : "curation.blockNote")}
            </p>

            {!isPending && (
              <>
                <div className="field">
                  <label htmlFor="curation-repo">{t("curation.repo")}</label>
                  <input
                    id="curation-repo"
                    value={repo}
                    onChange={(e) => {
                      setRepo(e.target.value);
                      // 输入变了就退出确认态，避免确认框里还挂着上一个仓库
                      setConfirm(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && repo.trim()) submitRepo();
                    }}
                    placeholder="https://github.com/owner/repo 或 owner/repo"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="curation-actions">
                  <button
                    type="button"
                    className="btn-primary curation-submit"
                    disabled={busy || !repo.trim()}
                    onClick={submitRepo}
                  >
                    {busy ? t("curation.working") : t(isQueue ? "curation.submit" : "curation.block")}
                  </button>
                </div>
              </>
            )}

            {notice && <p className={`curation-status ${notice.kind}`}>{notice.text}</p>}

            {isPending ? (
              <>
                <h3 className="curation-list-title">{t("curation.pendingList", { n: pending.length })}</h3>
                {pending.length === 0 ? (
                  <p className="curation-empty">{t("curation.pendingEmpty")}</p>
                ) : (
                  <ul className="curation-list">
                    {pending.map((item) => (
                      <li className="curation-pending" key={item.repo}>
                        <div className="curation-pending-head">
                          <a
                            className="curation-repo"
                            href={`https://github.com/${item.repo}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {item.repo}
                          </a>
                          <div className="curation-pending-btns">
                            <button
                              type="button"
                              className="curation-item-btn primary"
                              disabled={busy}
                              onClick={() => void run("approve", item.repo, "curation.approved")}
                            >
                              {t("curation.approve")}
                            </button>
                            <button
                              type="button"
                              className="curation-item-btn"
                              disabled={busy}
                              onClick={() => setConfirm({ action: "dismiss", target: item.repo })}
                            >
                              {t("curation.dismiss")}
                            </button>
                          </div>
                        </div>
                        {(item.install || item.category || item.summary) && (
                          <div className="curation-pending-meta">
                            {item.install && (
                              <span>{t("curation.pendingInstall")} <code>{item.install}</code></span>
                            )}
                            {item.category && <span>{t("curation.pendingCategory")} {item.category}</span>}
                            {item.summary && <span>{item.summary}</span>}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="curation-hint">{t("curation.pendingHint")}</p>
              </>
            ) : (
              <>
                <div className="curation-list-head">
                  <h3 className="curation-list-title">
                    {t(isQueue ? "curation.queueList" : "curation.blockList", { n: current.length })}
                  </h3>
                  <span className="curation-list-tools">
                    {/* 批量清理只在展开时可用：收起状态看不到记录，避免一次清空全部 */}
                    {isQueue && listOpen && indexed.length > 0 && (
                      <button
                        type="button"
                        className="curation-item-btn"
                        disabled={busy}
                        onClick={() => setConfirm({ action: "prune" })}
                      >
                        {t("curation.prune", { n: indexed.length })}
                      </button>
                    )}
                    <button
                      type="button"
                      className="curation-item-btn"
                      aria-expanded={listOpen}
                      onClick={() => setListOpen((v) => !v)}
                    >
                      {listOpen ? t("curation.collapse") : t("curation.expand")}
                    </button>
                  </span>
                </div>

                {/* 空态也在展开后才出现：收起时只留标题与展开按钮，避免列表区常驻提示 */}
                {listOpen && current.length === 0 && (
                  <p className="curation-empty">{t(isQueue ? "curation.queueEmpty" : "curation.blockEmpty")}</p>
                )}
                {listOpen && current.length > 0 && (
                  <ul className="curation-list">
                    {current.map((id) => (
                      <li className={`curation-item${isCollected(id) ? " is-collected" : ""}`} key={id}>
                        <a className="curation-repo" href={`https://github.com/${id}`} target="_blank" rel="noreferrer">
                          {id}
                        </a>
                        <span className="curation-item-side">
                          {/* 状态图标：空心圆=等下次构建生效，圈内对勾=已生效 */}
                          {isQueue && collected && (
                            <StatusIcon
                              done={isCollected(id)}
                              label={t(isCollected(id) ? "curation.status.collected" : "curation.status.waiting")}
                            />
                          )}
                          {!isQueue && collected && (
                            <StatusIcon
                              done={!isCollected(id)}
                              label={t(isCollected(id) ? "curation.status.blockPending" : "curation.status.blockDone")}
                            />
                          )}
                          {/* 已收录的条目不在这里下架：收纳进归档，站点继续保留 */}
                          {(!isQueue || (collected && !isCollected(id))) && (
                            <button
                              type="button"
                              className="curation-item-btn"
                              disabled={busy}
                              onClick={() => setConfirm({ action: isQueue ? "unqueue" : "restore", target: id })}
                            >
                              {t(isQueue ? "curation.unqueue" : "curation.restore")}
                            </button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <p className="curation-hint">{t(isQueue ? "curation.queueHint" : "curation.blockHint")}</p>
              </>
            )}
          </div>
        </>
      )}

      {confirm && (
        <div
          className="curation-confirm-overlay"
          role="presentation"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setConfirm(null);
          }}
        >
          <div className="curation-confirm-card" role="alertdialog" aria-modal="true" aria-label={t("curation.confirmTitle")}>
            <p className="curation-confirm-title">{t("curation.confirmTitle")}</p>
            <p className="curation-confirm-text">{confirmMessage()}</p>
            <div className="curation-confirm-btns">
              <button type="button" className="curation-item-btn" onClick={() => setConfirm(null)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="curation-item-btn danger" disabled={busy} onClick={execConfirm}>
                {busy ? t("curation.working") : t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
