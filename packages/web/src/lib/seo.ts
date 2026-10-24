import { useEffect } from "react";
import { siteConfig } from "./data";

/**
 * 每页的 title / description / canonical。
 *
 * 站点是客户端渲染，搜索引擎执行 JS 后读到的就是这里写入的内容；
 * sitemap 里的 URL 与 canonical 必须完全一致，否则会被当成重复页面。
 */
export const ORIGIN = `https://${siteConfig.domain}`;

export interface SeoInput {
  title: string;
  description: string;
  /** 站内路径，如 /、/top、/p/owner/repo */
  path: string;
  /** 收藏等个人页不进索引 */
  noindex?: boolean;
  /** 结构化数据（Schema.org），由调用方按页面类型给 */
  jsonLd?: Record<string, unknown>;
}

function meta(selector: string, attrs: Record<string, string>): void {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    document.head.appendChild(el);
  }
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
}

export function applySeo({ title, description, path, noindex, jsonLd }: SeoInput): void {
  document.title = title;
  const url = `${ORIGIN}${path}`;
  meta('meta[name="description"]', { name: "description", content: description });
  meta('meta[property="og:title"]', { property: "og:title", content: title });
  meta('meta[property="og:description"]', { property: "og:description", content: description });
  meta('meta[property="og:url"]', { property: "og:url", content: url });
  meta('meta[name="twitter:title"]', { name: "twitter:title", content: title });
  meta('meta[name="twitter:description"]', { name: "twitter:description", content: description });

  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.appendChild(canonical);
  }
  canonical.href = url;

  const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (noindex) meta('meta[name="robots"]', { name: "robots", content: "noindex,follow" });
  else robots?.remove();

  // 结构化数据：同一页面始终只保留一份，切路由时整段替换
  let ld = document.head.querySelector<HTMLScriptElement>('script[data-seo-jsonld="1"]');
  if (jsonLd) {
    if (!ld) {
      ld = document.createElement("script");
      ld.type = "application/ld+json";
      ld.dataset.seoJsonld = "1";
      document.head.appendChild(ld);
    }
    ld.textContent = JSON.stringify(jsonLd);
  } else {
    ld?.remove();
  }
}

export function useSeo(input: SeoInput): void {
  const { title, description, path, noindex, jsonLd } = input;
  // 对象每次渲染都是新引用，用序列化结果做依赖，避免无意义地反复写 DOM
  const jsonLdKey = jsonLd ? JSON.stringify(jsonLd) : "";
  useEffect(() => {
    applySeo({ title, description, path, noindex, jsonLd });
  }, [title, description, path, noindex, jsonLdKey]);
}

/** 首页 / 榜单等公共页的默认描述，详情页另用条目简介覆盖。 */
export const SEO_DEFAULT_DESCRIPTION =
  "DSH 插件集市：收录 DeepSeek Harness 插件与非 DSH 独立工具，按星标与更新活跃度排序，支持分类筛选与全文搜索，每日自动刷新。";

export const SEO_SITE_NAME = siteConfig.siteNameZh;
