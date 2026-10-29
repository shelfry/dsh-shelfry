import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * 按需渲染 README。
 *
 * 不在构建期把 1.3 万条 README 都抓下来（体积会有几百 MB），
 * 而是打开详情页时直接从 raw.githubusercontent 拉当前默认分支的 README。
 * 渲染后的 HTML 一律过 DOMPurify：README 是第三方内容，不能直接塞进 innerHTML。
 */

const CANDIDATES = ["README.md", "readme.md", "Readme.md", "README.MD", "README.markdown"];
const RAW = "https://raw.githubusercontent.com";
const BLOB = "https://github.com";
// 3s：国内直连 raw.githubusercontent 常被墙，等满 9s 才报错对用户来说等于卡死
const TIMEOUT_MS = 3000;

/** 仓库名里的 # 之类会影响 URL，逐段编码。 */
const encodeRepo = (fullName: string) => fullName.split("/").map(encodeURIComponent).join("/");

/**
 * 依次探测常见 README 文件名。
 *
 * 五个候选名并行发请求：串行最坏要 5 × 超时才判定「没有 README」，
 * 并行后最坏只有一次超时；结果按 CANDIDATES 顺序取第一个非空，优先级不变。
 * 全部请求都抛错（超时/断网）时抛出网络错误，与「仓库确实没有 README」区分开。
 */
async function fetchReadme(fullName: string): Promise<string | null> {
  let replied = 0;
  const texts = await Promise.all(
    CANDIDATES.map(async (name) => {
      try {
        const res = await fetch(`${RAW}/${encodeRepo(fullName)}/HEAD/${name}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // 有响应就说明网络是通的，哪怕 404 也只表示这个文件名不存在
        replied++;
        if (!res.ok) return null;
        const text = await res.text();
        return text.trim() ? text : null;
      } catch {
        return null;
      }
    }),
  );
  if (replied === 0) throw new Error("readme: network unreachable");
  return texts.find((t) => t) ?? null;
}

/** 把 README 里的相对图片/链接改成绝对地址，否则在站点上全是裂图。 */
function absolutize(html: string, fullName: string): string {
  const rawBase = `${RAW}/${encodeRepo(fullName)}/HEAD/`;
  const blobBase = `${BLOB}/${fullName}/blob/HEAD/`;
  const doc = new DOMParser().parseFromString(html, "text/html");

  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    // 以 / 开头的路径在 GitHub 上表示仓库根，直接和域名拼会拼到 raw 的站点根，必须剥掉前导斜杠
    if (src && !/^(https?:|data:)/i.test(src)) {
      img.setAttribute("src", src.startsWith("/") ? rawBase + src.slice(1) : new URL(src, rawBase).href);
    }
    img.setAttribute("loading", "lazy");
    img.setAttribute("referrerpolicy", "no-referrer");
  }
  for (const a of doc.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (href && !/^(https?:|mailto:|#)/i.test(href)) {
      a.setAttribute("href", href.startsWith("/") ? blobBase + href.slice(1) : new URL(href, blobBase).href);
    }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noreferrer noopener");
  }
  // 站内不需要 README 里的 <h1>：标题已经在页面头部展示过了，重复一遍很吵
  doc.querySelector("h1")?.remove();
  return doc.body.innerHTML;
}

export interface ReadmeResult {
  html: string;
  /** 命中时用于「在 GitHub 查看原文」的链接。 */
  url: string;
}

export async function loadReadme(fullName: string): Promise<ReadmeResult | null> {
  const md = await fetchReadme(fullName);
  if (!md) return null;
  // 仓库里嵌 HTML 的 README 很常见，统一走 sanitize（禁脚本/样式/内联框架）
  const raw = marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
  const clean = DOMPurify.sanitize(raw, {
    FORBID_TAGS: ["script", "style", "iframe", "form", "input"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "style"],
  });
  return { html: absolutize(clean, fullName), url: `https://github.com/${fullName}#readme` };
}
