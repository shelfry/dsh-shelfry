/**
 * Download regions: which route the market's own network requests take.
 *
 * Almost every external request the market makes lands on npm's registry or
 * on GitHub — the plugin catalog, update checks, package downloads, author
 * avatars, README screenshots. From mainland China several of those can be
 * slow, which is why this is ONE setting rather than a
 * row of them: "npm mirror", "GitHub proxy" and "image proxy" are three
 * spellings of a single question the user is actually being asked, which is
 * where they are.
 *
 * The routing table is the single source of truth. Every consumer asks it
 * rather than reaching for a hardcoded host, so adding a region is a table
 * entry instead of a search across six modules.
 *
 * Each route has an environment escape hatch, following `DSHM_REGISTRY_URL`
 * (src/registry.ts). The China route has service-specific public-proxy
 * fallbacks; those come and go, and a user whose routes have died needs a way
 * out that is not "wait for the next release".
 */
/** Every region a user may pick. */
export const REGIONS = ['global', 'china'];
/** Narrow an untrusted value to a Region, or null. */
export function asRegion(value) {
    return value === 'global' || value === 'china' ? value : null;
}
/**
 * The npm registry the market and pnpm read, no trailing slash.
 *
 * Exported because callers need to tell "this region uses the default" from
 * "this region names a mirror" — the difference between leaving a spawned
 * pnpm's registry alone and setting it.
 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
/**
 * Default npm registry for the China download region, no trailing slash.
 *
 * Exported so failure classifiers can recognize this host in pnpm's output
 * (#926) without duplicating the URL.
 */
export const CHINA_NPM_REGISTRY = 'https://mirrors.cloud.tencent.com/npm';
const NPM_CHINA = CHINA_NPM_REGISTRY;
/**
 * Second China npm mirror, used only as a catalog fallback (#1051), no
 * trailing slash.
 *
 * The catalog list named the Tencent mirror and the origin and nothing else,
 * so a network that blocks or outranks one of them lost both: a corporate
 * egress proxy refusing that host (measured: HTTP 522/525) left GitHub Pages
 * as the only way to the catalog, and on the China line that host is the one
 * that has to be reachable. The catalog package is published to npm proper,
 * and this mirror carries it, so naming it costs one request only when the
 * first mirror has already failed.
 */
const CHINA_NPM_FALLBACK = 'https://registry.npmmirror.com';
/**
 * First public prefix used for unauthenticated GitHub reads, no trailing slash.
 * Authenticated API calls and canonical codeload tarballs never use it.
 *
 * What this proxy accepts is a list of GitHub SERVICES, not a hostname test.
 * The previous note here said it "refuses anything that is not a github.com
 * hostname", which #460 by @Homplex measured as wrong in both directions —
 * re-measured 2026-09-01:
 *
 *   https://raw.githubusercontent.com/…   200   ← not a github.com hostname
 *   https://github.com/owner/repo         403   ← is one
 *   https://example.com/                  403
 *
 * So a plain repository page is refused while raw content is served. Do not
 * reason about this proxy from the hostname; check the specific service, and
 * re-measure rather than infer, because the policy is the operator's and can
 * change under us. That fragility is the substance of #460's actual request
 * (a mirror list and a visible setting), which is tracked separately.
 */
const GITHUB_PROXY_CHINA = 'https://gh-proxy.com';
const GITHUB_PROXY_CHINA_FALLBACK = 'https://ghfast.top';
/**
 * 目录的唯一公开地址：crate 的 dsh-crate.json（插件专用全量数据包）。
 *
 * 这份 JSON 由 crate 每次构建时随站点一起生成（与网页端同源数据），条目字段
 * 与内部 Registry 不同，映射放在 src/crate-catalog.ts；这里只负责把它放在
 * 哪个地区的哪个地址上。
 * 它带 ETag 与 cache-control，所以 registry.ts 的 304 复用照常生效。
 */
const CATALOG_OFFICIAL = 'https://dshcrate.com/data/dsh-crate.json';
const ROUTES = {
    global: {
        npmRegistry: DEFAULT_NPM_REGISTRY,
        githubProxy: null,
        githubRoutes: { git: [null], raw: [null], avatar: [null] },
        catalog: [{ kind: 'url', url: CATALOG_OFFICIAL }],
    },
    china: {
        npmRegistry: NPM_CHINA,
        githubProxy: GITHUB_PROXY_CHINA,
        // Filtering is service-shaped, not GitHub-shaped. Raw content commonly
        // needs help while git advertisements and avatars remain reachable, so
        // putting one global order on all three only trades one outage for
        // needless proxy traffic on the paths that still work.
        githubRoutes: {
            raw: [GITHUB_PROXY_CHINA, GITHUB_PROXY_CHINA_FALLBACK, null],
            git: [null, GITHUB_PROXY_CHINA, GITHUB_PROXY_CHINA_FALLBACK],
            avatar: [null, GITHUB_PROXY_CHINA, GITHUB_PROXY_CHINA_FALLBACK],
        },
        // crate 没有把目录另发成 npm 包，所以两个地区都只有这一个地址：
        // 网络到不了它，就是真的拿不到目录，不做「换一个镜像」的假动作。
        catalog: [{ kind: 'url', url: CATALOG_OFFICIAL }],
    },
};
/**
 * 一个地区要尝试的所有目录地址。
 *
 * crate 只有一份公开 JSON，没有可以退到的 npm 镜像包，所以这里的候选列表
 * 就是该地区自己声明的顺序；保留这个函数是为了让「列表怎么来的」只在一个
 * 地方回答，调用方不必知道地区表的结构。
 */
export function catalogSourcesFor(region) {
    return routesFor(region).catalog.map(source => ({ ...source }));
}
/** Read an environment override, treating blank as unset. */
function override(env, name) {
    const raw = env[name];
    return raw !== undefined && raw.trim() !== '' ? raw.trim().replace(/\/+$/, '') : null;
}
/**
 * Normalize a user-maintained prefix, or reject it.
 *
 * Public mirrors receive the complete destination URL in their path. Only
 * HTTPS prefixes without embedded credentials or query fragments are safe to
 * persist and show again in the settings UI.
 */
export function normalizeGithubProxy(value) {
    if (typeof value !== 'string')
        return null;
    const raw = value.trim();
    if (raw === '' || raw.includes('\\'))
        return null;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '')
            return null;
        if (parsed.search !== '' || parsed.hash !== '')
            return null;
        const path = parsed.pathname.replace(/\/+$/u, '');
        return `${parsed.origin}${path}`;
    }
    catch {
        return null;
    }
}
let customGithubProxy = null;
const preferredGithubRoutes = new Map();
/** Apply (or clear) the persisted UI escape route. */
export function setCustomGithubProxy(proxy) {
    const next = proxy === null ? null : normalizeGithubProxy(proxy);
    if (next === customGithubProxy)
        return;
    customGithubProxy = next;
    resetGithubRoutePreferences();
}
/** Whether the operator-owned environment variable disables UI changes. */
export function githubProxyManaged(env = process.env) {
    return override(env, 'DSHM_GITHUB_PROXY') !== null;
}
/** Remember one verified route without changing other GitHub services. */
export function rememberGithubRoute(service, route) {
    preferredGithubRoutes.set(service, route);
}
/** Forget learned winners after the configured candidates change. */
export function resetGithubRoutePreferences() {
    preferredGithubRoutes.clear();
}
/**
 * Put a user's own prefix in front, and keep the region's other routes (#850).
 *
 * Heading rather than replacing, because a public proxy dying is the whole
 * reason the setting exists — the reporter's was one of these mirrors, and it
 * took the rest of the chain with it: `gh-proxy.com` stopped serving on
 * 2026-10-13, and every GitHub-sourced update then failed on a timeout rather
 * than trying the next candidate. Replacing the list buys one attempt per
 * mirror outage; heading it buys one, and then the chain that was already
 * measured to work.
 *
 * The proxy is also dropped from the tail if it is already there, so a user
 * who accepted the value the settings UI pre-suggests gets exactly the
 * region's own table back rather than the same prefix twice.
 *
 * The direct escape is never dropped: `githubRoutes` promises every list ends
 * in one, and dropping it would turn a dead mirror into an outage instead of
 * a slow request.
 */
function withCustomProxy(proxy, base) {
    return [proxy, ...base.filter(route => route !== proxy)];
}
/**
 * The routes for a region, with environment overrides applied.
 *
 * Overrides win over the table because they are the user's statement about
 * their own network, and they are the way out when a public proxy dies.
 *
 * `DSHM_REGISTRY_URL` keeps its existing meaning — the catalog URL — and
 * when set it REPLACES the source list rather than heading it: someone
 * pointing the market at their own catalog does not want it quietly
 * reverting to ours.
 */
export function routesFor(region, env = process.env) {
    const base = ROUTES[region];
    const npmMirror = override(env, 'DSHM_NPM_MIRROR');
    const githubProxy = override(env, 'DSHM_GITHUB_PROXY') ?? customGithubProxy;
    const catalog = override(env, 'DSHM_REGISTRY_URL');
    const registry = npmMirror ?? base.npmRegistry;
    const githubRoutes = githubProxy === null
        ? {
            git: [...base.githubRoutes.git],
            raw: [...base.githubRoutes.raw],
            avatar: [...base.githubRoutes.avatar],
        }
        : {
            git: withCustomProxy(githubProxy, base.githubRoutes.git),
            raw: withCustomProxy(githubProxy, base.githubRoutes.raw),
            avatar: withCustomProxy(githubProxy, base.githubRoutes.avatar),
        };
    return {
        npmRegistry: registry,
        githubProxy: githubProxy ?? base.githubProxy,
        githubRoutes,
        // A named catalog REPLACES the list rather than joining it. Someone
        // pointing the market at their own catalog does not want it quietly
        // reverting to ours when theirs is briefly unreachable — that is how a
        // fixture-backed test ends up asserting against the live registry.
        catalog: catalog !== null
            ? [{ kind: 'url', url: catalog }]
            // Rebuilt against the resolved registry, so an npm override moves the
            // catalog to the same mirror it moved everything else to.
            : base.catalog.map(source => (source.kind === 'npm' ? { ...source, registry } : source)),
    };
}
/** Ordered candidates with this process's last verified winner first. */
export function githubRoutesFor(service, region = activeRegion(), env = process.env) {
    const routes = routesFor(region, env).githubRoutes[service];
    if (!preferredGithubRoutes.has(service))
        return routes;
    const preferred = preferredGithubRoutes.get(service);
    const index = routes.findIndex(route => route === preferred);
    if (index <= 0)
        return routes;
    return [routes[index], ...routes.slice(0, index), ...routes.slice(index + 1)];
}
/**
 * The region this process is running under.
 *
 * One piece of module state rather than a parameter threaded through the
 * catalog, the theme manager, update checks and every pnpm spawn: the region
 * is a property of the running market, not of any single question asked of
 * it, and the call graphs that need it are several frames deep.
 *
 * Consumers that must react to a CHANGE (dropping a cache gathered from the
 * other registry) keep their own setter beside this one; this holds the
 * answer for everyone who only needs to read it.
 */
let active = 'global';
/** The region in force. */
export function activeRegion() {
    return active;
}
/** Set the region in force. Callers are responsible for their own caches. */
export function setActiveRegion(region) {
    active = region;
}
/**
 * Wrap a github.com-family URL in a prefix proxy.
 *
 * The proxy takes the full absolute URL as its path (`{proxy}/{url}`) rather
 * than a rewritten hostname, so the same joining rule works for every
 * GitHub service a caller has explicitly allowed through public routes.
 *
 * @param proxy - the prefix, or null to go direct.
 * @param url - an absolute https URL on a github.com-family host.
 * @returns the proxied URL, or `url` unchanged when there is no proxy.
 */
export function throughProxy(proxy, url) {
    return proxy === null ? url : `${proxy}/${url}`;
}
