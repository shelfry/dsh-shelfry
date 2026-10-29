/// <reference types="vite/client" />

/** 由 vite.config.ts 在构建期从 git 提交数注入，形如 v1.0.342。 */
declare const __BUILD_VERSION__: string;

/** 由 vite.config.ts 在构建期从 site.config.json 注入（唯一真相源）。 */
declare const __SITE__: {
  siteName: string;
  siteNameZh: string;
  tagline: string;
  taglineZh: string;
  domain: string;
  basePath: string;
  repoUrl: string;
  dataBaseUrl: string;
  license: string;
};

/** 构建期从 public/data 内联的首屏筛选数据；数据文件缺失时为 null。 */
declare const __CATALOG_BOOTSTRAP__: import("./lib/bootstrap").CatalogBootstrap | null;
