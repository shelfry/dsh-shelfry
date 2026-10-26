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
