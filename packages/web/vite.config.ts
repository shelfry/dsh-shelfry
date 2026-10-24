import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/** 站点名 / 域名集中一处配置：site.config.json 是唯一真相源，构建期注入前端。 */
const site = JSON.parse(readFileSync(resolve(here, "../../site.config.json"), "utf8")) as Record<string, unknown>;

const ORIGIN = `https://${String(site.domain)}`;

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

export default defineConfig({
  // 深链是真实路径（/p/owner/repo），资源必须走根路径绝对地址，否则会被解析到 /p/owner/ 下。
  base: "/",
  plugins: [react(), seoArtifacts()],
  define: {
    __SITE__: JSON.stringify(site),
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
