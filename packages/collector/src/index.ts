import type { ArtifactIndex } from "@dsh-shelfry/schema";
import { SCHEMA_VERSION, type PluginEntry } from "@dsh-shelfry/schema";
import { loadCatalog, mergeEntries, saveCatalog, catalogPath } from "./store.ts";
import {
  buildMeta,
  syncToWebPublic,
  writeArtifactIndex,
  writeCategories,
  writeDetailShards,
  writeIdMap,
  writeIndexShards,
  writeLite,
  writeMeta,
} from "./emit.ts";
import { normalizeRecord, type RawRecord } from "./normalize.ts";
import { fetchMirrorRecords } from "./sources/mirror.ts";
import { fetchGithubRecords, fetchReposByNames } from "./sources/github.ts";
import { fetchCatalogIndex, mergeCatalog } from "./sources/catalog.ts";
import { resolveVersions } from "./versions.ts";
import { resolveDownloads } from "./downloads.ts";
import { clearBorrowedPackageInfo } from "./identity.ts";
import { isPlaceholderSpec, resolveEvidence, writeDroppedList } from "./evidence.ts";
import { isAuthError } from "./token-guard.ts";
import { isManualPick } from "./manual-pick.ts";
import { resolveInstallCommands } from "./install-probe.ts";
import { resolveReadmeSummaries } from "./readme.ts";
import { resolveEmptyReadme } from "./readme-gate.ts";
import { loadCuration } from "./curation.ts";

/**
 * 收录管道 CLI。
 *
 *   npm run collect -- --source mirror --limit 200
 *   npm run collect -- --source github --limit 500        # 需 GITHUB_TOKEN
 *   npm run collect -- --source auto                      # 有 token 走 GitHub，否则镜像兜底
 *   npm run collect -- --source mirror --build            # 顺带把产物同步到 web/public/data
 */

interface Args {
  source: "mirror" | "github" | "auto";
  limit: number;
  queries: string[] | null;
  sync: boolean;
  silent: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { source: "auto", limit: 20000, queries: null, sync: false, silent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--source": {
        const v = next();
        if (v === "mirror" || v === "github" || v === "auto") args.source = v;
        break;
      }
      case "--limit": args.limit = Number(next()) || args.limit; break;
      case "--queries": args.queries = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--build": args.sync = true; break;
      case "--silent": args.silent = true; break;
      default: break;
    }
  }
  return args;
}

const log = (silent: boolean, ...m: unknown[]) => { if (!silent) console.log(...m); };

/**
 * 桌面客户端不是插件：Electron/Tauri 壳、Windows 桌面版这类仓库没有
 * `dsh plugin add` 规格，装不进 profile，留在插件列表里只会误导。
 *
 * 判定要保守 —— 大量真插件名字里也带 desktop（dsh-desktop-statusbar、
 * dsh-desktop-restart-button…），所以三条同时满足才算客户端：
 * 1. 仓库名本身就以 desktop 结尾（dsh-desktop、deepseek-harness-desktop）；
 * 2. 简介明说是客户端/桌面版/封装版，或带 desktop-app 这类话题；
 * 3. 没有安装命令；名字里带 widget/theme/statusbar 这类增强词、或自述
 *    「…桌面端插件」的，一律当插件保留。
 */
const DESKTOP_CLIENT_TEXT = /desktop\s+(client|app(?:lication)?|wrapper|build|workspace)\b|\bGUI for\b|桌面(客户端|应用|版|封装版|封装|工作台|端)/i;
const DESKTOP_TOPIC = /desktop-app|electron-app|tauri-app|desktop-client|desktop-application|windows-desktop|desktop-workspace/i;
/** 给桌面端做增强的插件常用词：出现在仓库名里就不当客户端处理。 */
const PLUGIN_ENHANCER = /widget|pet|theme|skin|statusbar|status|extension|vscode|restart|notice|glass|context|shell/i;

function looksLikeDesktopClient(e: PluginEntry): boolean {
  // DSH 插件有安装命令就说明能装进 profile；独立工具即使有安装命令，
  // 只要它本身是桌面客户端（名字以 desktop 结尾 + 客户端口径）也要剔除。
  if (e.install.command && e.ecosystem !== "external") return false;
  const repo = e.id.split("/")[1] ?? e.id;
  if (!/(^|[-_])desktop$/i.test(repo)) return false;
  if (PLUGIN_ENHANCER.test(repo)) return false;
  if (/插件$/i.test((e.description ?? "").trim())) return false;
  const text = `${e.name} ${e.description ?? ""}`;
  return DESKTOP_CLIENT_TEXT.test(text) || e.tags.some((t) => DESKTOP_TOPIC.test(t));
}

/**
 * 教程、清单、dotfiles、模板这类仓库的 README 也常带一条 curl 安装脚本
 * （例如 learn-harness-engineering 的 audit 脚本），但它们本身不是可分发的工具。
 * 只对独立工具做这层过滤 —— 插件不受影响。
 */
const NON_TOOL_REPO = /(^|[-_/])(dotfiles|awesome|tutorials?|courses?|curriculum|roadmap|cheatsheets?|books?|docs?|documentation|website|blog|templates?|boilerplate|starter|examples?|demos?|playground|sandbox|learn)([-_/]|$)/i;

function looksLikeNonTool(e: PluginEntry): boolean {
  if (e.ecosystem !== "external") return false;
  // 只看仓库名：简介里出现 docs / examples 的合法工具不少，按简介筛会误伤。
  const repo = e.id.split("/")[1] ?? e.id;
  return NON_TOOL_REPO.test(repo);
}

/**
 * 工具质量门槛：独立工具没有 DSH 生态的天然筛选，检索会捞到大量刚建的个人自用脚本。
 * 星标低于 3 的不进列表；人工精选和用户通过 Issue 主动提交的除外 ——
 * 后者是有人点名要的，不该被星标一刀切掉。
 */
const MIN_TOOL_STARS = 3;

function belowToolBar(e: PluginEntry): boolean {
  if (e.ecosystem !== "external") return false;
  // 站长在站内点名要收录的（队列）与用户主动提交的一样，不该被星标一刀切
  if (e.curated || e.sources.includes("issue-submission") || e.sources.includes("curation")) return false;
  return e.stars < MIN_TOOL_STARS;
}

interface LoadedRecords {
  records: RawRecord[];
  sourceLabel: string;
  /** 走了兜底时的原因，写进 meta.json 让站上能显示出来。 */
  reason?: string;
}

async function loadRawRecords(args: Args): Promise<LoadedRecords> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  if (token) {
    // 只打形状（长度/前缀/是否含空白），值一律不落日志 —— 用来排查 Secret 粘贴脏了的情况
    console.log(`[collector] token 形状：长度 ${token.length}，前缀 ${token.slice(0, 4)}，含空白 ${/\s/.test(token)}`);
  }
  const fromMirror = async (reason?: string): Promise<LoadedRecords> => {
    if (reason) console.warn(`[collector] ${reason}，降级到镜像种子源。`);
    return { records: await fetchMirrorRecords(args.limit), sourceLabel: "mirror", ...(reason ? { reason } : {}) };
  };

  if (args.source === "mirror") return fromMirror();
  if (!token) return fromMirror("未检测到 GITHUB_TOKEN");
  if (args.source === "github") {
    // 显式指定主源时不兜底：让故障直接暴露出来，便于排查。
    const records = await fetchGithubRecords({
      token,
      perQueryLimit: args.limit,
      ...(args.queries ? { queries: args.queries } : {}),
    });
    return { records, sourceLabel: "github" };
  }

  // auto：优先自建主源，失败则降级。
  // 数据源（尤其 CI 内置 token 调不动 Search API）抖一下就整站部署失败是不可接受的，
  // 种子源足够让站点保持可用，缺失的部分靠下一次成功抓取补齐。
  try {
    const records = await fetchGithubRecords({
      token,
      perQueryLimit: args.limit,
      ...(args.queries ? { queries: args.queries } : {}),
    });
    return { records, sourceLabel: "github" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // 令牌失效或权限不足属于配置问题，降级到镜像只会让数据静默停更：
    // 直接抛出让构建失败，GitHub 的失败通知才会把问题推给站长。
    if (isAuthError(detail)) {
      throw new Error(`GitHub 令牌无效或权限不足，请更新 CI 的 GH_SEARCH_TOKEN —— ${detail}`);
    }
    return fromMirror(`GitHub 检索失败（${detail}）`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();

  const prev = loadCatalog();
  log(args.silent, `[collector] 已有条目 ${prev.entries.length} 条`);

  const { records, sourceLabel } = await loadRawRecords(args);
  log(args.silent, `[collector] 来源=${sourceLabel}，抓到原始记录 ${records.length} 条`);

  // 一次性补录：CI 用 workflow_dispatch 的 rescue 输入传入仓库全名，逐条取详情后并入本轮。
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const curation = loadCuration();

  // 第三方目录源（awesome-dsh-plugin）：只补我们还没有的仓库。目录不决定是否入库 ——
  // 已删除的仓库由 GitHub API 天然挡掉，星标/标签/质量门槛仍走后面的统一规则。
  // 必须排在补录与收录队列之前：同 id 时后写入者生效，队列的 curation 标记不能被冲掉。
  if (!token) {
    log(args.silent, "[collector] 未配置 GITHUB_TOKEN，跳过目录源");
  } else {
    const catalog = await fetchCatalogIndex();
    if (catalog) {
      const known = new Set(prev.entries.map((e) => e.id.toLowerCase()));
      const taken = new Set(records.map((r) => String(r.id ?? r.fullName ?? "").toLowerCase()));
      const manual = new Set([...curation.queue, ...curation.curated, ...curation.blocklist, ...curation.purge]);
      const candidates = catalog.items.filter((it) => !known.has(it.key) && !taken.has(it.key) && !manual.has(it.key));
      const fetched = candidates.length > 0 ? await fetchReposByNames(candidates.map((it) => it.id), token) : [];
      const fromCatalog = mergeCatalog(fetched, candidates);
      records.push(...fromCatalog);
      log(
        args.silent,
        `[collector] 目录源：索引 ${catalog.total} 条 / 去重后 ${catalog.items.length} 条（重复 ${catalog.duplicates} / 缺字段 ${catalog.skipped}）/ 候选 ${candidates.length} 条 / GitHub 取回 ${fetched.length} 条 / 并入 ${fromCatalog.length} 条`,
      );
    }
  }

  const rescueNames = (process.env.RESCUE_REPOS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (rescueNames.length > 0) {
    const rescued = token ? await fetchReposByNames(rescueNames, token) : [];
    log(args.silent, `[collector] 补录 ${rescueNames.length} 个仓库，成功取回 ${rescued.length} 条`);
    // 补录名单来自 Issue 提交：打上标记，低星工具据此绕过质量门槛
    records.push(
      ...rescued.map((r) => {
        const prevSources = Array.isArray(r.sources) ? r.sources.map(String) : [];
        return { ...r, sources: [...new Set([...prevSources, "issue-submission"])] };
      }),
    );
  }

  // 外部目录筛选出的候选种子：只负责让管道看见这些仓库，不豁免任何门槛 ——
  // 生态判定、星级门槛、桌面客户端剥离与命令补全都按自动规则走，达标才进站。
  if (curation.seeds.length > 0) {
    const seeded = token ? await fetchReposByNames(curation.seeds, token) : [];
    log(args.silent, `[collector] 候选种子 ${curation.seeds.length} 个，成功取回 ${seeded.length} 条`);
    records.push(
      ...seeded.map((r) => {
        const prevSources = Array.isArray(r.sources) ? r.sources.map(String) : [];
        return { ...r, sources: [...new Set([...prevSources, "seed"])] };
      }),
    );
  }

  // 站内「收录」弹框写入的队列 + 已收录归档：跳过检索发现层，直接按全名拉取。
  // 归档是「清理已收录」后的去向，仍然要强制收录，否则下次构建可能掉出站点。
  // 人工指定只负责「进候选」，类型判定与分类仍走后面的自动规则。
  const manual = [...new Set([...curation.queue, ...curation.curated])];
  if (manual.length > 0) {
    if (token) {
      const queued = await fetchReposByNames(manual, token);
      log(args.silent, `[collector] 收录队列 ${curation.queue.length} 个 + 归档 ${curation.curated.length} 个，成功取回 ${queued.length} 条`);
      records.push(
        ...queued.map((r) => {
          const prevSources = Array.isArray(r.sources) ? r.sources.map(String) : [];
          return { ...r, sources: [...new Set([...prevSources, "curation"])] };
        }),
      );
    } else {
      // 没有 token 就没法按全名取详情，名单原样保留，等下次 CI 跑
      console.warn(`[collector] 未配置 GITHUB_TOKEN，跳过收录队列（${manual.length} 个仓库）`);
    }
  }

  const prevById = new Map(prev.entries.map((e) => [e.id, e]));
  const incoming = [];
  let rejected = 0;
  for (const raw of records) {
    const id = String(raw.id ?? raw.fullName ?? "");
    const entry = normalizeRecord(raw, now, prevById.get(id));
    if (!entry) { rejected++; continue; }
    incoming.push(entry);
  }
  if (rejected > 0) log(args.silent, `[collector] 规整后丢弃 ${rejected} 条（缺 id）`);

  const merged = mergeEntries(prev, incoming);
  let entries = merged.catalog.entries;

  // 站长永久剔除的仓库 + 规则批量清退的仓库。队列优先：同一仓库同时出现在两边时
  // 按「要收录」处理，恢复收录只需把它加回队列，不必关心两份名单里是否还留着旧记录。
  const queued = new Set(manual);
  const manualBlocked = new Set(curation.blocklist.filter((id) => !queued.has(id)));
  const rulePurged = new Set(curation.purge.filter((id) => !queued.has(id)));
  const blocked = new Set([...manualBlocked, ...rulePurged]);
  if (blocked.size > 0) {
    const removed = entries.filter((e) => blocked.has(e.id.toLowerCase()));
    if (removed.length > 0) {
      entries = entries.filter((e) => !blocked.has(e.id.toLowerCase()));
      merged.catalog.entries = entries;
      const names = removed.slice(0, 8).map((e) => e.id).join("、");
      log(
        args.silent,
        `[collector] 名单剔除 ${removed.length} 条（手动 ${manualBlocked.size} 个 / 规则清退 ${rulePurged.size} 个）：${names}${removed.length > 8 ? " 等" : ""}`,
      );
    }
  }

  // 生态归属实证：名字/简介里看不出 DSH 的条目逐条取证据，三层全空才剔除。
  // 放在版本号与下载量之前，避免给注定要删的条目白花几百次请求。
  const verdict = await resolveEvidence(entries);
  log(
    args.silent,
    `[collector] 生态判定：名称自带 ${verdict.result.named} 条 / 缓存命中 ${verdict.result.cached} 条 / 实测 ${verdict.result.probed} 条（保留 ${verdict.result.kept} 条，其中独立工具 ${verdict.result.external} 条，判无关 ${verdict.result.dropped} 条）`,
  );
  const dropIds = new Set(verdict.dropped.map((e) => e.id));
  let active = dropIds.size > 0 ? entries.filter((e) => !dropIds.has(e.id)) : entries;
  // 历史数据里可能残留「dsh skill add」——这条命令并不存在，一律清掉
  let bogus = 0;
  for (const e of active) {
    if (e.install.command && /^dsh\s+skill\s+add/i.test(e.install.command)) {
      e.install.command = null;
      bogus++;
    }
  }
  if (bogus > 0) log(args.silent, `[collector] 清除 ${bogus} 条不存在的 skill 安装命令`);
  // 历史命令里的 <profile> 占位符换成可直接执行的 web（web/tui 都是 DSH 自带模板，
  // 首次使用自动初始化）；站点另提供 profile 选择，不用用户再手改命令。
  let placeholders = 0;
  for (const e of active) {
    if (e.install.command?.includes("<profile>")) {
      e.install.command = e.install.command.replace(/<profile>/g, "web");
      placeholders++;
    }
  }
  if (placeholders > 0) log(args.silent, `[collector] 把 ${placeholders} 条命令的 profile 占位符换成 web`);
  // README 模板里的占位规格（github:owner/repo）不是真地址，清掉别让用户去装
  let placeholderCmd = 0;
  for (const e of active) {
    const spec = e.install.command?.match(/\badd\s+(\S+)/)?.[1] ?? "";
    if (spec && isPlaceholderSpec(spec)) {
      e.install.command = null;
      e.install.packageName = null;
      placeholderCmd++;
    }
  }
  if (placeholderCmd > 0) log(args.silent, `[collector] 清除 ${placeholderCmd} 条占位安装命令`);

  if (dropIds.size > 0) {
    entries = active;
    merged.catalog.entries = active;
    const droppedFile = writeDroppedList(verdict.dropped);
    log(args.silent, `[collector] 剔除 ${dropIds.size} 条非 DSH 条目，清单：${droppedFile}`);
  }

  // 安装命令补全：缺命令的条目再读一次 README，收上游写明的 dsh plugin add
  // 与自带安装器（npx/bunx/pnpm dlx）。必须在版本号/下载量之前跑 —— 包名可能被修正。
  const probe = await resolveInstallCommands(active, { now: now.getTime() });
  log(
    args.silent,
    `[collector] 安装命令补全：探测 ${probe.probed} 条 / 缓存命中 ${probe.cached} 条 / 补出 DSH 命令 ${probe.dsh} 条 / 上游安装器 ${probe.native} 条`,
  );

  // 早期写入的历史命令没有 --profile（该参数在 dsh 里必填），站点上的 profile 选择
  // 替换不到目标，等于形同虚设。命令里还能取出规格的补回默认 web；只剩 flag 的
  // （如 `dsh plugin add -w`）没有可执行规格，直接清空。
  // 同时把「标成 pnpm-profile 却没有任何命令」的条目归位，避免详情页宣称 pnpm 安装。
  let repairedCmd = 0;
  let clearedCmd = 0;
  let fixedMethod = 0;
  for (const e of active) {
    const install = e.install;
    const cmd = install.command;
    if (install.method !== "pnpm-profile") continue;
    if (!cmd) {
      install.method = "unknown";
      fixedMethod++;
      continue;
    }
    if (!/\bdsh\s+plugin\b/.test(cmd) || /--profile(\s+|=)/.test(cmd)) continue;
    const tokens = cmd.trim().split(/\s+/);
    const at = Math.max(tokens.lastIndexOf("add"), tokens.lastIndexOf("install"));
    let spec: string | null = null;
    if (at >= 0) {
      let j = at + 1;
      while (j < tokens.length && tokens[j]?.startsWith("-")) j++;
      const token = tokens[j];
      const pkg = install.packageName;
      spec = pkg && !pkg.startsWith("-") ? pkg : token && !token.startsWith("-") ? token : null;
    }
    if (!spec) {
      install.command = null;
      install.packageName = null;
      install.method = "unknown";
      clearedCmd++;
      continue;
    }
    install.command = `dsh plugin --profile web add ${spec}`;
    install.packageName = spec;
    repairedCmd++;
  }
  if (repairedCmd > 0) log(args.silent, `[collector] 为 ${repairedCmd} 条历史安装命令补回 --profile web`);
  if (clearedCmd > 0) log(args.silent, `[collector] 清除 ${clearedCmd} 条没有可执行规格的历史命令`);
  if (fixedMethod > 0) log(args.silent, `[collector] 归位 ${fixedMethod} 条 pnpm-profile 但无命令的安装方式`);

  // 桌面客户端与教程/清单类仓库都不该出现在列表里：前者不是插件，后者不是工具。
  // 放在补全之后，避免把「README 里其实写了 dsh plugin add」的插件误删。
  // 站长点名收录的不受此限：手动加进来就是明确要的。
  const apps = active.filter((e) => !isManualPick(e) && (looksLikeDesktopClient(e) || looksLikeNonTool(e)));
  if (apps.length > 0) {
    const appIds = new Set(apps.map((e) => e.id));
    active = active.filter((e) => !appIds.has(e.id));
    entries = active;
    merged.catalog.entries = active;
    const names = apps.slice(0, 8).map((e) => e.id).join("、");
    log(args.silent, `[collector] 剔除 ${apps.length} 个桌面客户端/非工具仓库：${names}${apps.length > 8 ? " 等" : ""}`);
  }

  // 工具质量门槛：0-2 星的仓库多半是刚建的个人自用脚本，跟插件混在一起会稀释列表。
  const weakTools = active.filter(belowToolBar);
  if (weakTools.length > 0) {
    const weakIds = new Set(weakTools.map((e) => e.id));
    active = active.filter((e) => !weakIds.has(e.id));
    entries = active;
    merged.catalog.entries = active;
    const names = weakTools.slice(0, 8).map((e) => e.id).join("、");
    log(
      args.silent,
      `[collector] 工具质量门槛（<${MIN_TOOL_STARS} 星）剔除 ${weakTools.length} 条：${names}${weakTools.length > 8 ? " 等" : ""}`,
    );
  }

  // README 摘要：上游没写简介的条目取首段文字，前端分类规则拿它兜底。
  // 放在质量门槛之后 —— 已剔除的条目不再白读 README。
  const readme = await resolveReadmeSummaries(active);
  log(
    args.silent,
    `[collector] README 摘要：探测 ${readme.probed} 条 / 缓存命中 ${readme.cached} 条 / 补出 ${readme.filled} 条`,
  );

  // 空 README 门槛：0 星且 README 读不出正文的条目按权重先剔除（安装命令不作豁免）；
  // README 有正文的即使 0 星也保留 —— 新插件天然 0 星，正文与安装命令才是可用信号。
  // 结论走 .data 缓存，日常构建只探测新增与有新提交的仓库；unknown 本轮保留。
  const gate = await resolveEmptyReadme(active);
  if (gate.empty.length > 0) {
    const emptyIds = new Set(gate.empty.map((e) => e.id));
    active = active.filter((e) => !emptyIds.has(e.id));
    entries = active;
    merged.catalog.entries = active;
    const names = gate.empty.slice(0, 8).map((e) => e.id).join("、");
    log(
      args.silent,
      `[collector] 空 README 门槛剔除 ${gate.empty.length} 条（缺失 ${gate.missing} / 无正文 ${gate.blank}）：${names}${gate.empty.length > 8 ? " 等" : ""}`,
    );
  }
  log(
    args.silent,
    `[collector] 空 README 探测：探测 ${gate.probed} 条 / 缓存命中 ${gate.cached} 条 / 无法判定保留 ${gate.unknown} 条`,
  );

  // 版本号补齐必须发生在写产物之前 —— lite 切片要带 vr 字段。
  const versionHits = await resolveVersions(active);
  log(args.silent, `[collector] 版本号命中 ${versionHits} 条`);

  // 下载量同样要在写产物之前补全 —— lite 切片要带 dl 字段。
  const downloads = await resolveDownloads(active);
  log(
    args.silent,
    `[collector] npm 周下载量命中 ${downloads.hits} 条（缓存回填 ${downloads.cached} 个包 / 实际查询 ${downloads.queried} 个包）`,
  );

  // 清洗「借来的包名」：同一个包被多个仓库认领时，只给名字对得上的那条留版本/下载量
  const borrowed = clearBorrowedPackageInfo(active);
  if (borrowed > 0) log(args.silent, `[collector] 清除 ${borrowed} 条借用的版本号/下载量`);

  const saved = saveCatalog(merged.catalog);
  log(args.silent, `[collector] 合并完成：新增 ${merged.added} / 覆盖 ${merged.updated} / 合计 ${active.length} 条`);
  log(args.silent, `[collector] store 已写入 ${saved}`);

  const meta = buildMeta(active);
  log(
    args.silent,
    `[collector] 条目 ${meta.total} 条（插件 ${meta.total - (meta.external ?? 0)} / 工具 ${meta.external ?? 0}），类型分布 ${JSON.stringify(meta.types)}`,
  );

  const { pages, lite } = writeLite(active);
  const shards = writeDetailShards(active);
  const index = writeIndexShards(active);
  const artifacts: ArtifactIndex = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: meta.generatedAt,
    shards,
    index,
    pages,
    intents: null,
  };
  const artifactFile = writeArtifactIndex(artifacts);
  const metaFile = writeMeta(meta);
  const categoryFiles = writeCategories(entries);
  const idMapFile = writeIdMap(entries);
  log(args.silent, `[collector] 产物：lite=${lite.length} 条 / 分页 ${pages.count} 页 / 明细 ${shards.length} 片 / 索引 ${index.shards.length} 片`);
  log(args.silent, `[collector] 清单：${artifactFile}  元信息：${metaFile}`);
  log(args.silent, `[collector] 分类：${categoryFiles.join(" / ")}  反查表：${idMapFile}`);
  log(args.silent, `[collector] store 路径：${catalogPath()}`);

  if (args.sync) {
    syncToWebPublic();
    log(args.silent, `[collector] 已同步产物到 packages/web/public/data`);
  }
}

main().catch((err) => {
  console.error(`[collector] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
