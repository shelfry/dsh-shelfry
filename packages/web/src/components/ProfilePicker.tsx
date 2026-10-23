import { useEffect, useRef, useState } from "react";
import { DEFAULT_PROFILE, PROFILE_PRESETS } from "../lib/install";
import { useT } from "../lib/i18n";

/** 两个内置 profile 的用途，给下拉里的第二列用，避免用户只看到一个名字。 */
const PRESET_NOTE: Record<string, "profile.web" | "profile.tui"> = { web: "profile.web", tui: "profile.tui" };

/**
 * 「安装到哪个 profile」。
 *
 * 不用原生 datalist：它只会按当前输入过滤、浮层还是浏览器默认的深色气泡，
 * 看起来像「只有 web 一个选项」。这里用自绘的浅色下拉，明确列出内置 profile，
 * 并保留「自定义」入口给自建 profile。
 */
export function ProfilePicker({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (profile: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(value);
  const boxRef = useRef<HTMLDivElement>(null);
  const { t } = useT();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setCustom(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setCustom(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const commit = (next: string) => {
    onChange(next.trim() || DEFAULT_PROFILE);
    setOpen(false);
    setCustom(false);
  };

  const toggle = () => {
    setDraft(value);
    setCustom(false);
    setOpen((v) => !v);
  };

  return (
    <span className={`profile-pick${compact ? " is-compact" : ""}`}>
      <span className="profile-pick-k">{t("profile.into")}</span>
      <span className="profile-select" ref={boxRef}>
        <button
          type="button"
          className="profile-select-btn"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
        >
          <span className="profile-select-value">{value}</span>
          <span className="profile-caret" aria-hidden="true" />
        </button>

        {open && (
          <div className="profile-menu" role="listbox" aria-label={t("profile.aria")}>
            {PROFILE_PRESETS.map((preset) => (
              <button
                type="button"
                role="option"
                aria-selected={preset === value}
                key={preset}
                className={`profile-menu-item${preset === value ? " is-active" : ""}`}
                onClick={() => commit(preset)}
              >
                <span className="profile-menu-name">{preset}</span>
                <span className="profile-menu-note">{t(PRESET_NOTE[preset] ?? "profile.customNote")}</span>
              </button>
            ))}

            {custom ? (
              <form
                className="profile-custom"
                onSubmit={(e) => {
                  e.preventDefault();
                  commit(draft);
                }}
              >
                <input
                  className="profile-custom-input"
                  value={draft}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t("profile.placeholder")}
                  aria-label={t("profile.customAria")}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commit(draft)}
                />
                <span className="profile-menu-note">{t("profile.enterToSave")}</span>
              </form>
            ) : (
              <button
                type="button"
                className="profile-menu-item profile-menu-custom"
                onClick={() => {
                  setDraft(value);
                  setCustom(true);
                }}
              >
                <span className="profile-menu-name">{t("profile.custom")}</span>
                <span className="profile-menu-note">{t("profile.customNote")}</span>
              </button>
            )}
          </div>
        )}
      </span>

      {!compact && <span className="profile-pick-note">{t("profile.note")}</span>}
    </span>
  );
}
