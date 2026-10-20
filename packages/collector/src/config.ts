import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（packages/collector/src → ../../../）。 */
export const REPO_ROOT = resolve(here, "../../..");

export interface SiteConfig {
  siteName: string;
  siteNameZh: string;
  tagline: string;
  taglineZh: string;
  domain: string;
  basePath: string;
  repoUrl: string;
  dataBaseUrl: string;
  license: string;
}

/** 站点名 / 域名集中一处配置：换域名只改 site.config.json，全站引用相对路径。 */
export function loadSiteConfig(): SiteConfig {
  const raw = readFileSync(resolve(REPO_ROOT, "site.config.json"), "utf8");
  return JSON.parse(raw) as SiteConfig;
}

/** 数据产物目录（不进 git）：仓库根 .data/。 */
export const DATA_DIR = resolve(REPO_ROOT, ".data");
export const WEB_PUBLIC_DATA_DIR = resolve(REPO_ROOT, "packages/web/public/data");

/** 上游冷启动镜像源（按需镜像对手数据，不作为长期主源）。 */
export const MIRROR_LITE_URL = "https://dsh.market/plugins-lite.json";
