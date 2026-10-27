import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/** 站点名 / 域名集中一处配置：site.config.json 是唯一真相源，构建期注入前端。 */
const site = JSON.parse(readFileSync(resolve(here, "../../site.config.json"), "utf8")) as Record<string, unknown>;

const ORIGIN = `https://${String(site.domain)}`;

/**
 * 构建版本号：取 git 提交总数拼成 v1.0.<n>，只在有新提交时增长。
 * 统计时排除 curation 目录 —— CI 每轮都会自动提交名单同步，把它算进来会让
 * 版本号在没有任何代码改动时也上涨。用 execFileSync 传参，避免 shell 解析
 * `:(exclude)` 里的括号。CI 里必须配合 fetch-depth: 0，否则浅克隆计数恒为 1。
 */
function buildVersion(): string {
  if (process.env.BUILD_VERSION) return process.env.BUILD_VERSION;
  try {
    const count = Number.parseInt(
      execFileSync("git", ["rev-list", "--count", "HEAD", "--", ".", ":(exclude)curation"], {
        // 必须以仓库根目录为基准，否则 "." 只匹配到 packages/web，计数会偏小
        cwd: resolve(here, "../.."),
        encoding: "utf8",
      }).trim(),
      10,
    );
    return Number.isFinite(count) && count > 0 ? `v1.0.${count}` : "v1.0.0";
  } catch {
    return "v1.0.0";
  }
}

/** sitemap 只收质量靠前的条目：两万条薄页面全塞进去会稀释整站权重。 */
const SITEMAP_LIMIT = 3000;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 构建收尾：生成 sitemap.xml 与 GitHub Pages 的 404 兜底页。
 *
 * 传到 Cloudflare Pages 时由 _redirects 接管深链，404.html 不会被用到；
 * 在切过去之前仍部署在 GitHub Pages，404.html 让详情页直达/刷新不会白屏。
 */
function seoArtifacts(): Plugin {
  return {
    name: "seo-artifacts",
    apply: "build",
    closeBundle() {
      const outDir = resolve(here, "dist");
      const publicData = resolve(here, "public/data");
      const lite = JSON.parse(readFileSync(resolve(publicData, "lite.json"), "utf8")) as Array<{ i: string; sc: number }>;
      const meta = JSON.parse(readFileSync(resolve(publicData, "meta.json"), "utf8")) as { generatedAt?: string };
      const lastmod = meta.generatedAt?.slice(0, 10);
      const urls: string[] = [];

      const head = (loc: string, priority: string, changefreq: string) => {
        urls.push(
          `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`,
        );
      };

      head(`${ORIGIN}/`, "1.0", "daily");
      head(`${ORIGIN}/top`, "0.8", "daily");

      for (const entry of [...lite].sort((a, b) => b.sc - a.sc).slice(0, SITEMAP_LIMIT)) {
        const path = entry.i.split("/").map((part) => encodeURIComponent(part)).join("/");
        head(`${ORIGIN}/p/${path}`, "0.6", "weekly");
      }

      writeFileSync(
        resolve(outDir, "sitemap.xml"),
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
      );
      copyFileSync(resolve(outDir, "index.html"), resolve(outDir, "404.html"));
    },
  };
}

/**
 * 构建收尾：把首屏 JS/CSS 写进 _headers 的 Link 头，配合 Zone 的 Early Hints。
 *
 * 资源名带构建哈希，静态 _headers 里写死会失效，所以只能构建后动态追加。
 * 浏览器收到 103 Early Hints 就能在 HTML 到达前开始下载，白屏时间更短；
 * 即便没走 103，200 响应里的 Link 头也会被预加载扫描器识别。
 */
function earlyHintsHeaders(): Plugin {
  return {
    name: "early-hints-headers",
    apply: "build",
    closeBundle() {
      const outDir = resolve(here, "dist");
      const html = readFileSync(resolve(outDir, "index.html"), "utf8");
      const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
      const css = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
      if (!js && !css) return;

      const links = [
        js ? `  Link: <${js}>; rel=preload; as=script` : "",
        css ? `  Link: <${css}>; rel=preload; as=style` : "",
      ].filter(Boolean);

      const headersPath = resolve(outDir, "_headers");
      const existing = existsSync(headersPath) ? readFileSync(headersPath, "utf8") : "";
      // 结束时补齐换行，避免与已有规则粘在同一行
      const prefix = existing.endsWith("\n") || !existing ? existing : `${existing}\n`;
      writeFileSync(
        headersPath,
        `${prefix}\n# 首屏资源提前预加载：文件名带构建哈希，只能构建后生成\n/\n${links.join("\n")}\n`,
      );
    },
  };
}

export default defineConfig({
  // 深链是真实路径（/p/owner/repo），资源必须走根路径绝对地址，否则会被解析到 /p/owner/ 下。
  base: "/",
  plugins: [react(), seoArtifacts(), earlyHintsHeaders()],
  define: {
    __SITE__: JSON.stringify(site),
    // 页脚展示的构建版本号，由 git 提交数生成
    __BUILD_VERSION__: JSON.stringify(buildVersion()),
  },
  build: {
    outDir: "dist",
    // 产物不内联成单文件，保持可缓存的分片结构。
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
  },
});
