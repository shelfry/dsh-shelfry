import { useEffect, useState } from "react";
import { normalizeGitHubRepo } from "@dsh-shelfry/schema";
import { useT } from "../lib/i18n";

/**
 * 收录管理弹框：站长专用。
 *
 * 两个 Tab 共用一份密码输入：提交收录与剔除管理都要先过服务端校验，
 * 密码不会存进浏览器以外的任何地方；名单读写走 /api/curation（Pages Function）。
 * 写成功后直接用响应里的新名单刷新，不重新拉取，避免 GitHub raw/CDN 的缓存延迟。
 */

type Tab = "queue" | "block";
type Action = "queue" | "block" | "unqueue";
type OkKey = "curation.queued" | "curation.blocked" | "curation.unqueued" | "curation.restored";

interface Lists {
  queue: string[];
  blocklist: string[];
}

interface ApiError {
  message?: string;
}

const API = "/api/curation";

export function CurationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>("queue");
  const [repo, setRepo] = useState("");
  const [password, setPassword] = useState("");
  const [lists, setLists] = useState<Lists | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 打开时拉名单；关闭时清掉密码与提示，别把凭据留在页面上
  useEffect(() => {
    if (!open) {
      setPassword("");
      setNotice(null);
      setRepo("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    setNotice(null);
    (async () => {
      try {
        const res = await fetch(API, { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as (Partial<Lists> & ApiError) | null;
        if (!res.ok || !data) throw new Error(data?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setLists({ queue: data.queue ?? [], blocklist: data.blocklist ?? [] });
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const run = async (action: Action, target: string, okKey: OkKey) => {
    const repoId = normalizeGitHubRepo(target);
    if (!repoId) {
      setNotice({ kind: "error", text: t("curation.badRepo") });
      return;
    }
    if (!password) {
      setNotice({ kind: "error", text: t("curation.needPassword") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, repo: repoId, password }),
      });
      const data = (await res.json().catch(() => null)) as (Partial<Lists> & ApiError) | null;
      if (!res.ok || !data) {
        setNotice({
          kind: "error",
          text: res.status === 401
            ? t("curation.wrongPassword")
            : t("curation.failed", { msg: data?.message ?? `HTTP ${res.status}` }),
        });
        return;
      }
      setLists({ queue: data.queue ?? [], blocklist: data.blocklist ?? [] });
      setNotice({ kind: "ok", text: t(okKey) });
      if (action !== "unqueue") setRepo("");
    } catch (err) {
      setNotice({ kind: "error", text: t("curation.failed", { msg: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const isQueue = tab === "queue";
  const current = lists ? (isQueue ? lists.queue : lists.blocklist) : [];

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal curation-modal" role="dialog" aria-modal="true" aria-labelledby="curation-title">
        <div className="modal-head">
          <strong id="curation-title">{t("curation.title")}</strong>
          <button className="modal-close" onClick={onClose} aria-label={t("common.close")}>×</button>
        </div>

        <div className="curation-tabs" role="tablist" aria-label={t("curation.title")}>
          {(["queue", "block"] as Tab[]).map((key) => (
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
              {t(key === "queue" ? "curation.tab.queue" : "curation.tab.block")}
            </button>
          ))}
        </div>

        <div className="modal-body curation-body">
          <p className="curation-note">{t(isQueue ? "curation.queueNote" : "curation.blockNote")}</p>

          <div className="field">
            <label htmlFor="curation-repo">{t("curation.repo")}</label>
            <input
              id="curation-repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="https://github.com/owner/repo 或 owner/repo"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="curation-actions">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("curation.passwordPlaceholder")}
              aria-label={t("curation.password")}
              autoComplete="current-password"
            />
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !repo.trim()}
              onClick={() => void run(isQueue ? "queue" : "block", repo, isQueue ? "curation.queued" : "curation.blocked")}
            >
              {busy ? t("curation.working") : t(isQueue ? "curation.submit" : "curation.block")}
            </button>
          </div>

          {notice && <p className={`curation-status ${notice.kind}`}>{notice.text}</p>}

          <h3 className="curation-list-title">
            {t(isQueue ? "curation.queueList" : "curation.blockList", { n: current.length })}
          </h3>

          {loading ? (
            <p className="curation-empty">{t("curation.loading")}</p>
          ) : loadError ? (
            <p className="curation-status error">{t("curation.loadFailed", { msg: loadError })}</p>
          ) : current.length === 0 ? (
            <p className="curation-empty">{t(isQueue ? "curation.queueEmpty" : "curation.blockEmpty")}</p>
          ) : (
            <ul className="curation-list">
              {current.map((id) => (
                <li className="curation-item" key={id}>
                  <a className="curation-repo" href={`https://github.com/${id}`} target="_blank" rel="noreferrer">
                    {id}
                  </a>
                  <button
                    type="button"
                    className="curation-item-btn"
                    disabled={busy}
                    onClick={() => void run(isQueue ? "unqueue" : "queue", id, isQueue ? "curation.unqueued" : "curation.restored")}
                  >
                    {t(isQueue ? "curation.unqueue" : "curation.restore")}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="curation-hint">{t("curation.hint")}</p>
        </div>
      </div>
    </div>
  );
}
