import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * 按需渲染 README。
 *
 * 不在构建期把 1.3 万条 README 都抓下来（体积会有几百 MB），
 * 而是打开详情页时直接从 raw.githubusercontent 拉当前默认分支的 README。
 * 渲染后的 HTML 一律过 DOMPurify：README 是第三方内容，不能直接塞进 innerHTML。
 */

const PRIMARY = "README.md";
const FALLBACKS = ["readme.md", "Readme.md", "README.MD", "README.markdown"];
const RAW = "https://raw.githubusercontent.com";
const BLOB = "https://github.com";
// 3s：国内直连 raw.githubusercontent 常被墙，等满 9s 才报错对用户来说等于卡死
const TIMEOUT_MS = 3000;

/** 仓库名里的 # 之类会影响 URL，逐段编码。 */
const encodeRepo = (fullName: string) => fullName.split("/").map(encodeURIComponent).join("/");

/** 单个候选文件名的探测结果；replied 用来区分「文件不存在」和「网络不可达」。 */
interface Probe {
  text: string | null;
  replied: boolean;
}

async function probe(fullName: string, name: string): Promise<Probe> {
  try {
    const res = await fetch(`${RAW}/${encodeRepo(fullName)}/HEAD/${name}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 有响应就说明网络是通的，哪怕 404 也只表示这个文件名不存在
    if (!res.ok) return { text: null, replied: true };
    const text = await res.text();
    return { text: text.trim() ? text : null, replied: true };
  } catch {
    return { text: null, replied: false };
  }
}

/**
 * 先试最常见文件名，命中即止。
 *
 * 绝大多数仓库的 README 就叫 README.md；五个候选并行会让另外四个必然 404，
 * 控制台刷红字、还白打四个请求。命中即止后常路径只剩 1 个请求；
 * 少见命名（readme.md 小写等）才回退到并行探测，最坏耗时仍是两轮。
 * 首选名网络层失败时直接抛错，不再为一轮注定失败的候选再等一次超时。
 */
async function fetchReadme(fullName: string): Promise<string | null> {
  const primary = await probe(fullName, PRIMARY);
  if (primary.text) return primary.text;
  if (!primary.replied) throw new Error("readme: network unreachable");
  const rest = await Promise.all(FALLBACKS.map((name) => probe(fullName, name)));
  return rest.find((r) => r.text)?.text ?? null;
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
