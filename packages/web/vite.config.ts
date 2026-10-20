import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/** 站点名 / 域名集中一处配置：site.config.json 是唯一真相源，构建期注入前端。 */
const site = JSON.parse(readFileSync(resolve(here, "../../site.config.json"), "utf8")) as Record<string, unknown>;

export default defineConfig({
  // base './' ⇒ 全程相对路径，换域名 / 换子路径部署都不需要改代码。
  base: "./",
  plugins: [react()],
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
