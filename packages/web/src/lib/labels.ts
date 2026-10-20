/**
 * 分类标签的中文展示名。
 *
 * 上游 tags 里混着英文（mcp / windows / codex …），只做展示层映射，
 * 筛选逻辑仍用原始 tag，避免改数据口径。
 */
const CAT_LABEL: Record<string, string> = {
  mcp: "MCP 服务",
  windows: "Windows 适配",
  codex: "Codex 集成",
  "developer-tools": "开发工具",
  "agent-skills": "Agent 技能",
  "claude-code": "Claude Code",
  theme: "主题皮肤",
  memory: "记忆管理",
  "web-ui": "网页界面",
  "dsh-skill": "DSH 技能",
  skills: "技能合集",
  "dsh-plugin-desktop": "桌面插件",
};

export const categoryLabel = (tag: string): string => CAT_LABEL[tag] ?? tag;

/**
 * 卡片上没信息量的通用标签，占位置还挤掉有意义的标签。
 * 卡片与详情页共用这份过滤口径，否则两处标签数量对不上。
 */
const NOISE_TAGS = new Set([
  "cordis-plugin",
  "deepseek-harness",
  "deepseek-harness-plugin",
  "deepseek-harness-plugins",
  "dsh-plugin",
  "dsh-plugins",
  "dsh",
  "plugin",
  "plugins",
]);

export const meaningfulTags = (tags: string[]): string[] =>
  tags.filter((t) => !NOISE_TAGS.has(t.toLowerCase()));
