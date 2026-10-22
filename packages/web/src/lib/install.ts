import { useState } from "react";

/**
 * 安装目标 profile。
 *
 * `web` / `tui` 是 DSH 自带的 profile 模板，`dsh plugin --profile web ...`
 * 首次使用会自动初始化，所以默认值可以直接执行、不需要用户先建。
 * `desktop` 由 Electron App 独占，CLI 会直接拒绝，因此不作为选项。
 */
export const DEFAULT_PROFILE = "web";
export const PROFILE_PRESETS = ["web", "tui"] as const;

const STORAGE_KEY = "dsh-shelfry-profile";

export function readProfile(): string {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() || DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function saveProfile(raw: string): string {
  const value = raw.trim() || DEFAULT_PROFILE;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 隐私模式写不了 storage：本次会话仍然生效，不打断安装
  }
  return value;
}

/** 组件间共享同一份选择：换一张卡片或进详情页都沿用上次的 profile。 */
export function useProfile(): [string, (value: string) => void] {
  const [profile, setProfile] = useState(readProfile);
  const update = (value: string) => setProfile(saveProfile(value));
  return [profile, update];
}

/** 把命令里的 profile 换成用户选择；没有 --profile 的命令（上游安装器）原样返回。 */
export function applyProfile(command: string, profile: string): string {
  const value = profile.trim() || DEFAULT_PROFILE;
  return command.replace(/(--profile\s+)([^\s]+)/, `$1${value}`);
}
