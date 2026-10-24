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

/**
 * 固定分类体系：分类不再由标签出现频率决定，而是先定分类、再把标签与文案归并进来。
 * 这样「浏览器」这类语义清晰但仓库数少的分类也能存在（如 Browser4）。
 *
 * 匹配顺序：命中任一「标签」→ 再看仓库名 → 最后看简介。
 * 名称用 [._-] 作词边界，避免 dsh-im 这类短词误撞 build / image 里的子串。
 */
interface CategoryRule {
  label: string;
  /** 命中任一标签即归入该类（小写比较） */
  tags?: string[];
  /** 标签没命中时，看仓库名（owner/repo 的 repo 段） */
  name?: RegExp;
  /** 名称也没命中时，再看简介 */
  text?: RegExp;
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    label: "核心框架",
    name: /^deepseek-harness$/i,
  },
  {
    label: "浏览器自动化",
    tags: [
      "browser", "browser-agent", "agentic-browser", "ai-browser", "browser-use",
      "browser-use-agent", "browser-infra", "browser-automation", "chrome", "chrome-browser",
      "chrome-extension", "chrome-headless", "chrome-devtools-protocol", "cdp",
      "playwright", "puppeteer", "selenium", "web-automation",
    ],
    name: /(^|[._-])(browser|chrome|playwright|puppeteer|selenium|cdp)([._-]|$)/i,
    text: /\b(browser|chrome|playwright|puppeteer|selenium|cdp)\b|浏览器/i,
  },
  {
    label: "安全审查",
    tags: [
      "security", "security-audit", "redteam", "red-team", "jailbreak", "harness-jailbreak",
      "llm-jailbreak", "prompt-injection", "llm-security", "audit", "safety", "vulnerability",
      "pentest", "penetration-test",
    ],
    name: /(^|[._-])(security|audit|jailbreak|redteam|red-team|pentest|guard)([._-]|$)/i,
    text: /安全|审计|红队|破甲|jailbreak|注入攻击|漏洞|渗透测试|pentest|security/i,
  },
  {
    label: "记忆管理",
    tags: ["memory", "agent-memory", "memory-management", "memory-manager", "long-term-memory", "rag"],
    name: /(^|[._-])(memory|memories|recall|mnemonic|context)([._-]|$)/i,
    text: /记忆|memory|长期上下文|上下文压缩|context\s*compression/i,
  },
  {
    label: "会话管理",
    tags: [
      "session", "sessions", "session-management", "session-manager", "conversation",
      "conversation-history", "context-window",
    ],
    name: /(^|[._-])(session|sessions|conversation|side-chat|chat-history)([._-]|$)/i,
    text: /会话|session\s*(manage|history|list|delete|share)|conversation/i,
  },
  {
    label: "提示词优化",
    tags: [
      "prompt", "prompts", "prompt-engineering", "system-prompt", "system-prompts",
      "prompt-template", "prompt-library", "context-engineering", "persona", "agents-md",
    ],
    name: /(^|[._-])(prompt|prompts|persona|preset|presets)([._-]|$)/i,
    text: /\b(prompt|prompts|persona|preset)\b|提示词|系统提示|预设/i,
  },
  {
    label: "内容创作",
    tags: ["writing", "content-creation", "novel", "story", "ppt", "slides", "design", "copywriting"],
    name: /(^|[._-])(writing|writer|novel|story|ppt|slides|copywriting|humanizer)([._-]|$)/i,
    text: /\b(writing|novel|story|ppt|slides)\b|写作|内容创作|文案|小说|故事|幻灯片|排版|润色/i,
  },
  {
    label: "多智能体协作",
    tags: [
      "multi-agent", "multi-agents", "agent-coordination", "agent-orchestration",
      "agent-team", "agent-teams", "agent-workflow", "swarm", "subagent", "subagents",
      "agent-client-protocol", "acp",
    ],
    name: /(^|[._-])(multi-agent|multiagent|swarm|subagent|subagents|orchestrator|coordination|agents)([._-]|$)/i,
    text: /多\s*(智能体|agent)|multi-?agent|智能体协作|智能体编排|orchestrat|swarm|子智能体|subagent/i,
  },
  {
    label: "消息通知",
    tags: [
      "notification", "notifications", "webhook", "email", "mail", "push", "im", "im-bot",
      "chatbot", "chat", "telegram", "telegram-bot", "discord", "discord-bot", "slack",
      "slack-bot", "feishu", "lark", "wechat", "weixin", "qq", "qq-bot", "qqbot", "onebot",
      "napcat", "dingtalk", "whatsapp", "bilibili",
    ],
    name: /(^|[._-])(notify|notification|notifications|webhook|email|mail|push|bot|im|telegram|discord|slack|feishu|lark|wechat|wecom|qq|onebot)([._-]|$)/i,
    text: /\bbot\b|通知|提醒|推送|消息提醒|邮件|邮箱|webhook|机器人接入|chatbot|IM\s*机器人/i,
  },
  {
    label: "搜索与检索",
    tags: ["web-search", "search", "web-fetch", "scrape", "scraper"],
    name: /(^|[._-])(search|fetch|scrape|scraper)([._-]|$)/i,
    text: /\b(search|fetch|scrape)\b|搜索|检索|抓取/i,
  },
  {
    label: "数据分析",
    tags: [
      "database", "sql", "csv", "excel", "analytics", "data-analysis", "visualization",
      "report", "report-generation", "chart", "charting", "finance",
    ],
    name: /(^|[._-])(database|sql|csv|excel|analytics|data|chart|charts|report|reports|finance|trading)([._-]|$)/i,
    text: /\b(data|chart|report|trading|finance|excel|sql)\b|数据分析|数据处理|统计|报表|可视化|图表|数据看板/i,
  },
  {
    label: "模型适配",
    tags: [
      "model", "models", "model-config", "model-provider", "provider", "configuration",
      "api-key", "openai", "openai-compatible", "ollama", "gemini", "free-models",
      "llm-gateway", "workbuddy", "opencode", "opencode-zen", "reasoning-effort",
    ],
    name: /(^|[._-])(model|models|provider|router|openai|ollama|gemini|opencode|workbuddy|llm|llms)([._-]|$)/i,
    text: /\b(model|provider|router|opencode|llm)\b|模型(配置|切换|适配|接入|提供商)|API\s*配置|推理强度/i,
  },
  {
    label: "工作流增强",
    tags: [
      "workflow", "workflows", "automation", "cron", "scheduler", "pipeline", "task-runner",
      "task-management", "taskboard", "todo", "approval",
    ],
    name: /(^|[._-])(workflow|workflows|automation|cron|scheduler|pipeline|task|tasks|taskboard|todo|approval)([._-]|$)/i,
    text: /工作流|workflow|定时任务|调度|pipeline|自动化流程|任务看板|task\s*board|审批/i,
  },
  {
    label: "主题皮肤",
    tags: [
      "theme", "themes", "skin", "skins", "css", "ui-theme", "appearance", "dark-mode",
      "wallpaper", "dsh-theme", "dsh-plugin-theme",
    ],
    name: /(^|[._-])(theme|themes|skin|skins|wallpaper|appearance|splash)([._-]|$)/i,
    text: /\b(themes?|skins?)\b|主题|皮肤|美化|换肤|外观|配色|深色模式|壁纸|启动动画|开机动画/i,
  },
  {
    label: "前端增强",
    tags: [
      "web-ui", "webui", "dsh-web", "dsh-web-ui", "ui", "frontend", "gui", "dashboard",
      "desktop", "dsh-desktop", "dsh-plugin-desktop", "sidebar", "dsh-better-sidebar",
      "panel", "floating-ball", "electron", "composer", "canvas", "pwa", "swiftui",
    ],
    name: /(^|[._-])(ui|gui|frontend|web|desktop|sidebar|panel|widget|widgets|ux|dashboard|webview|composer|tray)([._-]|$)/i,
    text: /\b(ui|gui|frontend|desktop|sidebar|webview|widgets?)\b|界面|前端|面板|侧边栏|悬浮球|桌面端|输入框/i,
  },
  {
    label: "MCP 服务",
    tags: ["mcp"],
    name: /(^|[._-])mcp([._-]|$)/i,
    text: /\bMCP\b|模型上下文协议/i,
  },
  {
    label: "命令行工具",
    tags: ["cli", "terminal", "tui", "shell", "command-line", "ink"],
    name: /(^|[._-])(cli|tui|terminal|shell|ink)([._-]|$)/i,
    text: /\b(cli|tui|terminal)\b|命令行|终端界面/i,
  },
  {
    label: "插件管理",
    tags: [
      "plugin-manager", "marketplace", "plugin-market", "dsh-plugin-market", "plugin-store",
      "plugin-hub", "registry", "plugin-registry", "installer",
    ],
    name: /(^|[._-])(market|marketplace|plugin-market|registry|installer|store|hub)([._-]|$)/i,
    text: /插件管理|插件市场|插件商店|插件中心|安装器|插件订阅|plugin\s*(market|store|hub|manager)/i,
  },
  {
    label: "Agent 技能",
    tags: [
      "skills", "agent-skills", "agent-skill", "skill", "skill-collection", "dsh-skill",
      "skill-manager", "dsh-skill-manager",
    ],
    name: /(^|[._-])(skill|skills|skillpack)([._-]|$)/i,
    text: /\bskills?\b|技能库|技能合集|技能包|技能管理|技能/i,
  },
  {
    label: "资源合集",
    tags: ["awesome", "awesome-list", "curated-list", "catalog", "directory", "collection", "archive", "bundle", "dsh-bundle", "dsh-plugin-bundle"],
    name: /(^|[._-])(awesome|plugins|bundle|bundles|collection|catalog|pack|suite)([._-]|$)/i,
    text: /精选列表|资源合集|awesome|插件合集|仓库合集|collection|plugin\s*(bundle|suite)/i,
  },
  {
    label: "文档与知识",
    tags: [
      "docs", "documentation", "knowledge", "knowledge-base", "wiki", "notes", "markdown",
      "readme", "guide", "tutorial", "education", "study", "flashcards", "learn",
    ],
    name: /(^|[._-])(docs|doc|wiki|notes|knowledge|guide|tutorial|edu|study|learn)([._-]|$)/i,
    text: /\b(docs?|wiki|notes?|knowledge)\b|文档|知识库|笔记|教程|指南|学习/i,
  },
  {
    label: "开发工具",
    tags: [
      "developer-tools", "devtools", "debug", "testing", "lint", "build", "scaffold",
      "codegen", "git", "github", "code", "review", "diff", "ci", "npm", "npm-package",
      "nodejs", "python", "rust", "kotlin", "typescript", "javascript", "react",
    ],
    name: /(^|[._-])(devtools|debug|lint|git|github|code|review|test|tests|testing|build|scaffold|codegen)([._-]|$)/i,
    text: /\b(git|github|debug|lint|codegen|code\s*review)\b|开发工具|调试|测试工具|构建工具|脚手架|代码审查|代码生成/i,
  },
  {
    label: "状态监控",
    tags: ["monitoring", "observability", "telemetry", "logging", "metrics", "performance", "profiler", "status", "health", "stats"],
    name: /(^|[._-])(monitor|monitoring|observability|telemetry|log|logs|logging|metrics|status|health|profiler|stats)([._-]|$)/i,
    text: /\b(monitor|metrics|telemetry|observability|logs?)\b|监控|性能|日志|指标|运行状态/i,
  },
  {
    label: "多模态",
    tags: [
      "vision", "voice", "audio", "video", "image", "images", "multimodal", "speech", "tts",
      "ocr", "image-generation", "text-to-image", "aigc", "3d", "blender", "media",
    ],
    name: /(^|[._-])(vision|voice|audio|video|image|images|img|multimodal|speech|tts|ocr|media|blender|3d)([._-]|$)/i,
    text: /\b(image|video|audio|voice|tts|ocr|vision|media)\b|语音|图像|视频|多模态|生图|文生图|3D|建模/i,
  },
  {
    label: "娱乐互动",
    tags: ["pet", "game", "games", "fun", "emoji", "meme", "desktop-pet", "music"],
    name: /(^|[._-])(pet|game|games|fun|emoji|meme|poker|guandan|music|bili|bilibili)([._-]|$)/i,
    text: /\b(games?|poker|guandan|pet|music)\b|桌宠|宠物|游戏|娱乐|表情包|抽卡|音乐|掼蛋|扑克/i,
  },
  {
    label: "远程与移动",
    tags: [
      "mobile", "android", "ios", "termux", "remote", "remote-control", "remote-access",
      "ssh", "lan", "tailscale", "cloudflare-tunnel", "reverse-proxy", "proxy", "tunnel",
      "vpn", "phone", "qr",
    ],
    name: /(^|[._-])(mobile|android|ios|termux|remote|ssh|lan|tailscale|proxy|tunnel|vpn|phone|qr|imessage)([._-]|$)/i,
    text: /\b(ssh|remote|mobile|android|termux|tunnel|proxy)\b|远程|手机|扫码|移动端|局域网|内网穿透|反向代理/i,
  },
  {
    label: "部署与托管",
    tags: ["self-hosted", "docker", "sandbox", "local-first", "cloudflare", "vercel", "deploy", "hosting", "server"],
    name: /(^|[._-])(docker|sandbox|selfhost|self-hosted|deploy|hosting|cloudflare|vercel|server|launcher|fnos|ops)([._-]|$)/i,
    text: /\b(docker|sandbox|self-hosted|launcher)\b|自托管|部署|容器|沙箱|托管|启动器/i,
  },
  {
    label: "成本控制",
    tags: ["cost", "cost-tracking", "usage", "token-usage", "quota", "balance", "billing", "pricing"],
    name: /(^|[._-])(cost|costs|usage|token|tokens|quota|balance|billing|pricing|bill)([._-]|$)/i,
    text: /\b(cost|quota|balance|billing)\b|成本|费用|用量|余额|计费|token\s*(?:usage|用量)/i,
  },
  {
    label: "工作区管理",
    tags: ["workspace", "workspaces", "project-management", "project"],
    name: /(^|[._-])(workspace|workspaces|workbench|project|projects)([._-]|$)/i,
    text: /\bworkspace\b|工作区|项目管理/i,
  },
  {
    label: "文件管理",
    tags: ["files", "file-manager", "sftp", "file"],
    name: /(^|[._-])(files|file|sftp)([._-]|$)/i,
    text: /\b(sftp|file-manager)\b|文件管理|文件浏览|文件预览/i,
  },
  {
    label: "快捷操作",
    tags: [
      "shortcut", "shortcuts", "hotkey", "hotkeys", "keybinding", "autocomplete", "paste",
      "quick-send", "command-palette", "snippet", "screenshot",
    ],
    name: /(^|[._-])(shortcut|shortcuts|hotkey|hotkeys|paste|autocomplete|snippet|quick|screenshot)([._-]|$)/i,
    text: /\b(shortcut|hotkey|autocomplete|paste)\b|快捷键|快捷指令|粘贴|命令面板|截图/i,
  },
  {
    label: "设置面板",
    tags: ["settings", "settings-panel", "config-ui"],
    name: /(^|[._-])(settings|config|configuration)([._-]|$)/i,
    text: /\bsettings\b|设置面板|设置页/i,
  },
  {
    label: "状态持久化",
    tags: ["persistence", "backup", "sync", "storage", "state", "restore"],
    name: /(^|[._-])(backup|backups|sync|storage|persist|persistence|restore|archive)([._-]|$)/i,
    text: /\b(backup|sync|persist|storage)\b|持久化|备份|恢复|同步|本地存储/i,
  },
  {
    label: "Windows 适配",
    tags: ["windows", "wsl"],
    name: /(^|[._-])(windows|wsl)([._-]|$)/i,
    text: /Windows|WSL/i,
  },
  {
    label: "macOS 适配",
    tags: ["macos", "mac", "menubar"],
    name: /(^|[._-])(macos|mac|menubar)([._-]|$)/i,
    text: /macOS|菜单栏应用/i,
  },
];

export interface CategoryMatch {
  /** 展示用分类名（中文，分类名不随界面语言翻译） */
  label: string;
  /** 若由某个标签命中，返回该原始标签，便于标签区不重复展示 */
  tag?: string;
}

/**
 * 卡片/详情共用的分类归并：镜像仓 → 数据里的高频分类（与筛选栏一致）→ 固定分类 → null。
 * 固定分类按「标签 → 仓库名 → 简介」三级匹配，避免简介里的「可视化」之类词
 * 抢走标签已明确的项目；镜像仓优先显示「镜像仓库」，让用户一眼看出它只是副本。
 */
export function resolveCategory(
  tags: string[],
  name: string,
  desc: string,
  knownCategories: Set<string>,
  duplicate: boolean,
): CategoryMatch | null {
  if (duplicate) return { label: "镜像仓库" };
  const legacy = tags.find((tag) => knownCategories.has(tag));
  if (legacy) return { label: categoryLabel(legacy), tag: legacy };
  const lower = tags.map((tag) => tag.toLowerCase());
  for (const rule of CATEGORY_RULES) {
    if (!rule.tags) continue;
    const index = lower.findIndex((tag) => rule.tags!.includes(tag));
    if (index >= 0) return { label: rule.label, tag: tags[index] };
  }
  // 仓库名里的驼峰（DshWebSearch）先拆成连字符，才能被 name 规则的分词边界命中
  const nameKey = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  for (const rule of CATEGORY_RULES) {
    if (rule.name?.test(nameKey)) return { label: rule.label };
  }
  for (const rule of CATEGORY_RULES) {
    if (rule.text?.test(desc)) return { label: rule.label };
  }
  return null;
}
