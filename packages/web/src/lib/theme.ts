import { useSyncExternalStore } from "react";

/**
 * 主题：浅色 / 深色 / 跟随系统。
 *
 * 默认跟随系统；判断结果落在 <html data-theme> 上，CSS 只认这个属性，
 * 不做媒体查询分支 —— 这样用户手动选的颜色不会和系统偏好打架。
 * 首屏的初始值由 index.html 里的内联脚本先落一次，避免深色用户看到白闪。
 */

export type ThemeMode = "light" | "dark" | "system";

const KEY = "dsh:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

const systemDark = (): boolean => window.matchMedia(DARK_QUERY).matches;

function readMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    /* 隐私模式读不到存储就按系统 */
  }
  return "system";
}

let mode: ThemeMode = readMode();

export function resolvedTheme(next: ThemeMode = mode): "light" | "dark" {
  return next === "dark" || (next === "system" && systemDark()) ? "dark" : "light";
}

export function applyTheme(): void {
  const theme = resolvedTheme();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#121212" : "#f7f7f5");
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* 存不下也不影响本次生效 */
  }
  applyTheme();
  listeners.forEach((fn) => fn());
}

// 「跟随系统」时系统换肤要实时反映，选定了浅/深则不受影响
window.matchMedia(DARK_QUERY).addEventListener("change", () => {
  if (mode !== "system") return;
  applyTheme();
  listeners.forEach((fn) => fn());
});

export function useTheme(): [ThemeMode, (next: ThemeMode) => void] {
  const current = useSyncExternalStore(subscribe, () => mode, () => mode);
  return [current, setThemeMode];
}
