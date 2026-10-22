import { DEFAULT_PROFILE } from "../lib/install";

/**
 * 「安装到哪个 profile」。
 *
 * 用 input + datalist：默认 `web` 可直接执行，点开能选 `tui`，也允许直接手填
 * 自建 profile 名 —— 下拉与自定义不用做成两套交互。
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
  return (
    <label className={`profile-pick${compact ? " is-compact" : ""}`}>
      <span className="profile-pick-k">安装到</span>
      <input
        className="profile-pick-input"
        list="dsh-profile-options"
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-label="安装到哪个 profile"
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          if (!e.target.value.trim()) onChange(DEFAULT_PROFILE);
        }}
      />
      <datalist id="dsh-profile-options">
        <option value="web" />
        <option value="tui" />
      </datalist>
      {!compact && <span className="profile-pick-note">web / tui 首次使用会自动创建</span>}
    </label>
  );
}
