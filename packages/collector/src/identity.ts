import type { PluginEntry } from "@dsh-shelfry/schema";

/**
 * 「借来的包名」清洗。
 *
 * 上游有不少仓库把别人的包写进自己的安装规格（清单仓库、参考实现、搬运仓库），
 * 结果 `awesome-dsh-plugin` 会显示 `dsh-market` 的版本号和下载量 —— 数字没错，但张冠李戴。
 *
 * 判定方式：同一个 npm 包被多个仓库认领时，只在「包名和仓库名对得上」的那条上保留元信息，
 * 其余条目把 version / downloads 置空。包只被一个仓库认领时不处理 —— 可能是私有包或改名，
 * 宁可不显示，也不要误删。
 */

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** 安装规格是不是 npm 包名（github:/git+/https/本地路径都不算）。 */
const isNpmSpec = (spec: string | null): spec is string =>
  !!spec && !/^(github:|git\+|https?:|link:|file:|\.|\/)/.test(spec);

/** 包名去掉版本号与 scope，只留主体。 */
function packageName(spec: string): { name: string; scope: string } {
  const scoped = spec.startsWith("@");
  const scope = scoped ? spec.slice(1, spec.indexOf("/")) : "";
  const at = spec.indexOf("@", scoped ? 1 : 0);
  const body = at > 0 ? spec.slice(0, at) : spec;
  const name = scoped ? body.slice(body.indexOf("/") + 1) : body;
  return { name, scope };
}

/** 包名与 owner/repo 是否说得上是同一个东西。 */
export function packageBelongsTo(spec: string, fullName: string): boolean {
  const slash = fullName.indexOf("/");
  const owner = normalize(fullName.slice(0, slash));
  const repo = normalize(fullName.slice(slash + 1));
  const { name, scope } = packageName(spec);
  // scoped 包的 scope 往往就是作者的账号名，这条最可靠
  if (scope && normalize(scope) === owner) return true;
  const n = normalize(name);
  if (n.length < 3 || repo.length < 3) return false;
  // 常见变体：dsh-xxx / xxx / xxx-plugin，互相包含即可认定
  return repo.includes(n) || n.includes(repo);
}

/**
 * 就地清洗借来的元信息。返回被清空条数，供日志使用。
 */
export function clearBorrowedPackageInfo(entries: PluginEntry[]): number {
  const byPkg = new Map<string, PluginEntry[]>();
  for (const e of entries) {
    const spec = e.install.packageName;
    if (!isNpmSpec(spec)) continue;
    const { name, scope } = packageName(spec);
    // 按「包名主体」分组即可：同一主体的不同版本写法属于同一个包
    const key = scope ? `@${scope}/${name}` : name;
    const list = byPkg.get(key);
    if (list) list.push(e);
    else byPkg.set(key, [e]);
  }

  let cleared = 0;
  for (const [pkg, list] of byPkg) {
    if (list.length < 2) continue;
    const owners = list.filter((e) => packageBelongsTo(pkg, e.fullName));
    if (owners.length === 0) continue;
    for (const e of list) {
      if (owners.includes(e)) continue;
      if (e.version === null && e.downloads === null) continue;
      e.version = null;
      e.downloads = null;
      cleared++;
    }
  }
  return cleared;
}
