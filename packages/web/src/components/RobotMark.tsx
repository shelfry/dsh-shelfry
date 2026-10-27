/**
 * 空状态机器人：终端窗口造型，眼睛是两组 `>_` 光标。
 *
 * 入参 size：宽度（px），整只机器人按比例缩放。
 * 入参 tone：`accent` 用强调色眼睛（404 页，表示「在线在找」）；
 *            `muted` 用弱灰眼睛（详情页未收录，表示「没查到」）。
 *
 * 纯内联 SVG，不依赖图片资源；深浅色由 CSS 变量自动适配；
 * 浮动/眨眼/天线呼吸三组动画写在样式里，并尊重系统的「减少动态效果」设置。
 */
interface RobotMarkProps {
  size?: number;
  tone?: "accent" | "muted";
}

export function RobotMark({ size = 132, tone = "accent" }: RobotMarkProps) {
  return (
    <div className={`robot-mark robot-mark--${tone}`} style={{ width: size }} aria-hidden="true">
      <svg viewBox="0 0 160 146" fill="none">
        <circle className="robot-mark__tip" cx="80" cy="6" r="4" fill="var(--accent)" />
        <path d="M80 10V16" stroke="var(--border-strong)" strokeWidth="3" strokeLinecap="round" />
        {/* 头部即一块终端窗口：三颗窗口点 + 标题栏分隔线 */}
        <rect x="24" y="16" width="112" height="74" rx="10" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="2" />
        <path d="M24 36H136" stroke="var(--border-strong)" strokeWidth="2" />
        <circle cx="36" cy="26" r="3" fill="var(--border-strong)" />
        <circle cx="48" cy="26" r="3" fill="var(--border-strong)" />
        <circle cx="60" cy="26" r="3" fill="var(--border-strong)" />
        {/* 眼睛是两个等待输入的提示符 */}
        <g className="robot-mark__eye" fontFamily="var(--mono)" fontSize="22" fontWeight="700">
          <text x="50" y="73">&gt;</text>
          <text x="72" y="73">_</text>
          <text x="88" y="73">&gt;</text>
          <text x="110" y="73">_</text>
        </g>
        <path d="M80 90V98" stroke="var(--border-strong)" strokeWidth="2" />
        <rect x="52" y="98" width="56" height="26" rx="8" fill="var(--surface-2)" stroke="var(--border-strong)" strokeWidth="2" />
        <path d="M52 110H38" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" />
        <path d="M108 110H122" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export default RobotMark;
