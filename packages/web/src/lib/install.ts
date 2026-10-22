import { useCallback, useState } from "react";

/**
 * 安装目标 profile。
 *
 * `web` / `tui` 是 DSH 自带的 profile 模板，`dsh plugin --profile web ...`
 * 首次使用会自动初始化，所以默认值可以直接执行、不需要用户先建。
 * `desktop` 由 Electron App 独占，CLI 会直接拒绝，因此不作为选项。
 */
export const DEFAULT_PROFILE = "web";
export const PROFILE_PRESETS = ["web", "tui"] as const;

/**
 * profile 选择只属于当前这张卡片 / 这个详情页，不跨卡片、不写 localStorage。
 *
 * 之前做成全局记忆：在某张卡片选了 tui，之后打开任何卡片和详情页都会默认 tui，
 * 看起来像「所有插件都被改成了 tui」。安装命令里的 profile 应该每次从默认 web 起算。
 */
export function useProfile(): [string, (value: string) => void] {
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const update = useCallback((value: string) => setProfile(value.trim() || DEFAULT_PROFILE), []);
  return [profile, update];
}

/** 把命令里的 profile 换成用户选择；没有 --profile 的命令（上游安装器）原样返回。 */
export function applyProfile(command: string, profile: string): string {
  const value = profile.trim() || DEFAULT_PROFILE;
  return command.replace(/(--profile\s+)([^\s]+)/, `$1${value}`);
}
