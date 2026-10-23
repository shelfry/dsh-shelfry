import { useEffect, useRef, useState } from "react";
import { resolvedTheme, useTheme, type ThemeMode } from "../lib/theme";
import { setLang, useT, type Lang } from "../lib/i18n";

/**
 * 头部右侧的显示设置：主题三态 + 界面语言。
 *
 * 两个控件共用一次「点外面 / ESC 关闭」的监听，菜单是自绘的浅色面板，
 * 深色主题下靠 CSS 变量跟着换，不用原生 select 的深色气泡。
 */

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];
const LANGS: Lang[] = ["zh", "en"];

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2" />
        <path d="M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M20.2 14.6A8.4 8.4 0 1 1 9.4 3.8a6.8 6.8 0 0 0 10.8 10.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HeaderSettings() {
  const [mode, setMode] = useTheme();
  const { lang, t } = useT();
  const [open, setOpen] = useState<"theme" | "lang" | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const themeLabel = mode === "light" ? t("theme.light") : mode === "dark" ? t("theme.dark") : t("theme.system");
  const dark = resolvedTheme(mode) === "dark";

  return (
    <span className="header-tools" ref={rootRef}>
      <span className="settings-wrap">
        <button
          type="button"
          className="icon-btn"
          aria-haspopup="menu"
          aria-expanded={open === "theme"}
          aria-label={t("theme.label")}
          title={`${t("theme.label")} · ${themeLabel}`}
          onClick={() => setOpen(open === "theme" ? null : "theme")}
        >
          {dark ? <MoonIcon /> : <SunIcon />}
        </button>
        {open === "theme" && (
          <span className="settings-menu" role="menu">
            <span className="settings-menu-title">{t("theme.label")}</span>
            {THEME_MODES.map((key) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={mode === key}
                key={key}
                className={`settings-item${mode === key ? " is-active" : ""}`}
                onClick={() => {
                  setMode(key);
                  setOpen(null);
                }}
              >
                <span>{t(`theme.${key}` as "theme.light" | "theme.dark" | "theme.system")}</span>
                {mode === key && <span className="settings-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </span>
        )}
      </span>

      <span className="settings-wrap">
        <button
          type="button"
          className="icon-btn icon-btn-text"
          aria-haspopup="menu"
          aria-expanded={open === "lang"}
          aria-label={t("lang.label")}
          title={t("lang.label")}
          onClick={() => setOpen(open === "lang" ? null : "lang")}
        >
          {lang === "zh" ? "中文" : "EN"}
        </button>
        {open === "lang" && (
          <span className="settings-menu" role="menu">
            <span className="settings-menu-title">{t("lang.label")}</span>
            {LANGS.map((key) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={lang === key}
                key={key}
                className={`settings-item${lang === key ? " is-active" : ""}`}
                onClick={() => {
                  setLang(key);
                  setOpen(null);
                }}
              >
                {/* 语言名用各自的本名，不随界面语言翻译 */}
                <span>{key === "zh" ? "中文" : "English"}</span>
                {lang === key && <span className="settings-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}
