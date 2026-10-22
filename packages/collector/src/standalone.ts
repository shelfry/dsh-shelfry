import { packageBelongsTo } from "./identity.ts";

/**
 * 非 DSH 独立工具的安装命令抽取。
 *
 * 口径（与站点「工具」入口一致）：只认 README 里写明的、能一条命令装上的安装方式 ——
 * curl/wget/irm 脚本、brew、go install、cargo install、npm/pnpm/yarn/bun 全局安装、
 * pip/pipx、winget/scoop/choco。
 *
 * 关键约束：命令必须属于这个仓库。清单仓库（awesome-*）和教程仓库的 README 会写
 * 别人的安装命令，照抄就会张冠李戴 —— 包名走 packageBelongsTo，脚本 URL 必须
 * 命中 owner/repo 或仓库自己的域名，否则一律不采。
 */

export interface StandaloneHit {
  /** README 里的原始安装命令 */
  command: string;
  /** 只有 npm 全局安装才带包名（供版本/下载量补全），其余为 null */
  pkg: string | null;
}

interface Candidate extends StandaloneHit {
  rank: number;
  at: number;
}

const MAX_COMMAND_LEN = 240;

/** 下载脚本并执行：`curl … | bash`、`wget … -O x.sh && bash x.sh`、`irm … | iex`。 */
const URL_INSTALL =
  /\b(curl|wget|irm|iwr)\b[^\n]*?(https?:\/\/[^\s"'`<>|)]+)[^\n]*?(\|\s*(?:sudo\s+)?(?:ba|z|k|c|da)?sh\b|\|\s*(?:iex|Invoke-Expression)\b|[&;]\s*(?:sudo\s+)?(?:ba|z)?sh\s+\S+\.sh\b)/i;

/** `bash <(curl -fsSL url)` 这种反向写法。 */
const PROC_SUB_INSTALL = /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\s+[^)]*?(https?:\/\/[^\s"'`<>|)]+)\s*\)/i;

/** `sh -c "$(curl -fsSL url)"`：ohmyzsh 这类安装脚本的标准写法。 */
const SH_C_INSTALL = /\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b[^\n]*?(https?:\/\/[^\s"'`<>|)]+)/i;

/** 包管理器安装：捕获组 1 是包名/公式名，匹配文本本身就是要展示的命令。 */
const PKG_INSTALLS: Array<{ re: RegExp; rank: number }> = [
  { re: /\bbrew\s+(?:install|reinstall)\s+(?:--cask\s+|--formula\s+)?([^\s;&|]+)/i, rank: 7 },
  { re: /\bgo\s+install\s+([^\s;&|]+)/i, rank: 6 },
  { re: /\bcargo\s+install\s+([^\s;&|]+)/i, rank: 6 },
  { re: /\bnpm\s+(?:install|i)\s+(?:-g|--global)\s+([^\s;&|]+)/i, rank: 5 },
  { re: /\bpnpm\s+(?:add|install)\s+(?:-g|--global)\s+([^\s;&|]+)/i, rank: 5 },
  { re: /\byarn\s+global\s+add\s+([^\s;&|]+)/i, rank: 5 },
  { re: /\bbun\s+(?:add|install)\s+(?:-g|--global)\s+([^\s;&|]+)/i, rank: 5 },
  { re: /\b(?:pip|pip3|pipx|uv\s+tool)\s+install\s+([^\s;&|]+)/i, rank: 4 },
  { re: /\bwinget\s+install\s+(?:--id\s+(?:--exact\s+)?)?([^\s;&|]+)/i, rank: 3 },
  { re: /\bscoop\s+install\s+([^\s;&|]+)/i, rank: 3 },
  { re: /\bchoco\s+install\s+([^\s;&|]+)/i, rank: 3 },
];

const NPM_CMD = /\b(?:npm\s+(?:install|i)|pnpm\s+(?:add|install)|yarn\s+global\s+add|bun\s+(?:add|install))\b/;

const trimPunct = (s: string): string => s.replace(/[.,;:!?\])}"'`]+$/, "");

/** 去掉版本段：`@scope/pkg@1.2.3` → `@scope/pkg`，`foo@latest` → `foo`。 */
function stripVersion(spec: string): string {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * 安装目标是否属于这个仓库。
 * go 模块路径直接比对 owner/repo；其余取公式/包名主体走 packageBelongsTo
 * （brew 的 `owner/tap/formula` 取最后一段）。
 */
function packageBelongs(pkgish: string, fullName: string): boolean {
  const spec = trimPunct(pkgish);
  if (!spec) return false;
  const gh = /^github\.com\/([^/]+)\/([^/@]+)/i.exec(spec);
  if (gh) return `${gh[1]}/${gh[2]}`.toLowerCase() === fullName.toLowerCase();
  const parts = spec.split("/");
  return packageBelongsTo(stripVersion(parts[parts.length - 1]!), fullName);
}

/** 安装脚本 URL 是否由这个仓库自己提供（GitHub 原始地址 / 仓库自己的域名）。 */
function urlBelongsTo(url: string, fullName: string): boolean {
  const [owner, repo] = fullName.toLowerCase().split("/");
  if (!owner || !repo) return false;
  const u = url.toLowerCase();
  if (u.includes(`github.com/${owner}/${repo}`) || u.includes(`raw.githubusercontent.com/${owner}/${repo}`)) return true;

  const rx = repo.replace(/[^a-z0-9]/g, "");
  try {
    const parsed = new URL(url);
    const hostLabels = parsed.hostname.toLowerCase().split(".");
    // 域名标签精确匹配（phi.dev、get.foo.io），避免以 install.sh 这类通用词误命中
    if (rx.length >= 2 && hostLabels.some((l) => l === rx || l === `get-${rx}` || l === `get${rx}`)) return true;
    const compactPath = `${parsed.hostname}${parsed.pathname}`.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (rx.length >= 5 && compactPath.includes(rx)) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * 从 README 正文里找一条最合适的安装命令。
 * 排序：包管理器（brew > go/cargo > npm > pip > winget）优先，其次脚本安装；
 * 同级取文档里靠前的那条 —— README 的快速开始通常把推荐方式放在最前面。
 */
export function findStandaloneCommand(body: string, fullName: string): StandaloneHit | null {
  const candidates: Candidate[] = [];
  const lines = body.split("\n");

  lines.forEach((raw, at) => {
    const line = raw.trim().replace(/^\$\s+/, "");
    if (!line || line.length > 400) return;

    const script = URL_INSTALL.exec(line) ?? null;
    const procSub = script ? null : PROC_SUB_INSTALL.exec(line);
    const shC = script || procSub ? null : SH_C_INSTALL.exec(line);
    const url = script?.[2] ?? procSub?.[1] ?? shC?.[2] ?? null;
    if (url && urlBelongsTo(url, fullName)) {
      const command = trimPunct((script?.[0] ?? procSub?.[0] ?? shC?.[0] ?? "").replace(/\s+/g, " ").trim());
      if (command && command.length <= MAX_COMMAND_LEN) {
        candidates.push({ command, pkg: null, rank: 5, at });
      }
    }

    for (const { re, rank } of PKG_INSTALLS) {
      const m = re.exec(line);
      if (!m?.[1]) continue;
      if (!packageBelongs(m[1], fullName)) continue;
      const command = trimPunct(m[0].replace(/\s+/g, " ").trim());
      if (!command || command.length > MAX_COMMAND_LEN) break;
      const pkg = NPM_CMD.test(command) ? stripVersion(trimPunct(m[1])) : null;
      candidates.push({ command, pkg, rank, at });
      break;
    }
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.rank - a.rank || a.at - b.at);
  const best = candidates[0]!;
  return { command: best.command, pkg: best.pkg };
}
