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
type Action = "queue" | "block" | "unqueue" | "approve" | "dismiss" | "prune";
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
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
      return;
    }
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

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
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return parse(await res.json().catch(() => null), res.status);
  };

  const unlock = async () => {
    if (!password) {
      setNotice({ kind: "error", text: t("curation.needPassword") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const [next, ids] = await Promise.all([
        post({ action: "auth", password }),
        // 名单状态是锦上添花：拉不到也不影响解锁和写操作
        loadCollectedIds().catch(() => null),
      ]);
      setLists(next);
      setCollected(ids);
      setAuthed(true);
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
      if (action !== "unqueue") setRepo("");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** 只清理「确实已经在站点里」的队列条目，未收录的保持不动 */
  const prune = async () => {
    const targets = (lists?.queue ?? []).filter((id) => collected?.has(id));
    if (targets.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = await post({ action: "prune", repos: targets, password });
      setLists(next);
      setNotice({ kind: "ok", text: t("curation.pruned", { n: targets.length }) });
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
  const indexed = isQueue && collected ? current.filter((id) => collected.has(id)) : [];

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
                    onChange={(e) => setRepo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && repo.trim()) {
                        void run(isQueue ? "queue" : "block", repo, isQueue ? "curation.queued" : "curation.blocked");
                      }
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
                    onClick={() =>
                      void run(isQueue ? "queue" : "block", repo, isQueue ? "curation.queued" : "curation.blocked")
                    }
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
                              onClick={() => void run("dismiss", item.repo, "curation.dismissed")}
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
                  {isQueue && indexed.length > 0 && (
                    <button type="button" className="curation-item-btn" disabled={busy} onClick={() => void prune()}>
                      {t("curation.prune", { n: indexed.length })}
                    </button>
                  )}
                </div>

                {current.length === 0 ? (
                  <p className="curation-empty">{t(isQueue ? "curation.queueEmpty" : "curation.blockEmpty")}</p>
                ) : (
                  <ul className="curation-list">
                    {current.map((id) => (
                      <li className={`curation-item${collected?.has(id) ? " is-collected" : ""}`} key={id}>
                        <a className="curation-repo" href={`https://github.com/${id}`} target="_blank" rel="noreferrer">
                          {id}
                        </a>
                        <span className="curation-item-side">
                          {isQueue && collected && (
                            <span className={`curation-badge${collected.has(id) ? " ok" : ""}`}>
                              {t(collected.has(id) ? "curation.status.collected" : "curation.status.waiting")}
                            </span>
                          )}
                          <button
                            type="button"
                            className="curation-item-btn"
                            disabled={busy}
                            onClick={() =>
                              void run(isQueue ? "unqueue" : "queue", id, isQueue ? "curation.unqueued" : "curation.restored")
                            }
                          >
                            {t(isQueue ? "curation.unqueue" : "curation.restore")}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <p className="curation-hint">{t("curation.hint")}</p>
              </>
            )}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
