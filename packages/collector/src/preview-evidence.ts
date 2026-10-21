import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./config.ts";
import { probeRepo, readEvidenceCache, type Evidence } from "./evidence.ts";

/**
 * 生态归属预演：只跑判定，不动 catalog，也不写产物。
 *
 *   npm run preview:evidence                 # 拉线上 lite.json 做样本
 *   npm run preview:evidence -- --lite .data/lite.json
 *
 * 输出：
 *   .data/evidence-preview.json  —— 每条模糊条目的判定与证据
 * 终端打印「判无关」的清单（按星标降序），供人工抽查后再决定是否接入收录管道。
 */

const DEFAULT_LITE = "https://dsh.shelfry.app/data/lite.json";
// 与 evidence.ts 保持同一口径：单独的 dsh 词也要算（dsh_workflow、omdsh-dev 里的 dsh）
const LOOSE = /(^|[^a-z0-9])dsh([^a-z0-9]|$)|dsh[-_]plugin|dsh[-_]market|deepseek[-_ ]?harness|cordis/i;
const CONCURRENCY = 10;

interface Lite {
  i: string;
  n: string;
  s: number;
  t: string;
  tg?: string[];
  d?: string | null;
}

async function loadLite(src: string): Promise<Lite[]> {
  if (/^https?:/.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`lite 拉取失败: HTTP ${res.status}`);
    return (await res.json()) as Lite[];
  }
  return JSON.parse(readFileSync(resolve(src), "utf8")) as Lite[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--lite");
  const src = at >= 0 ? argv[at + 1]! : DEFAULT_LITE;

  const lite = await loadLite(src);
  const cache = readEvidenceCache();
  const ambiguous = lite.filter((e) => !LOOSE.test(`${e.i} ${e.d ?? ""}`));

  console.log(`[preview] 样本 ${lite.length} 条，名字/简介含 DSH 字样 ${lite.length - ambiguous.length} 条，待判定 ${ambiguous.length} 条`);

  const queue = [...ambiguous];
  const verdicts = new Map<string, Evidence>();
  let done = 0;
  const startedAt = Date.now();
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const e = queue.shift();
      if (!e) return;
      const slash = e.i.indexOf("/");
      const hit = cache[e.i];
      const evidence = await probeRepo(e.i.slice(0, slash), e.i.slice(slash + 1));
      verdicts.set(e.i, evidence);
      done++;
      if (done % 50 === 0) {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[preview] 进度 ${done}/${ambiguous.length}（${secs}s），当前 ${e.i} → ${evidence.v} ${evidence.e.join(",")}`);
      }
    }
  });
  await Promise.all(workers);

  const kept = [...verdicts.entries()].filter(([, v]) => v.v === "keep");
  const dropped = [...verdicts.entries()].filter(([, v]) => v.v === "drop");

  const starOf = new Map(lite.map((e) => [e.i, e.s]));
  const tagOf = new Map(lite.map((e) => [e.i, e.tg ?? []]));
  const typeOf = new Map(lite.map((e) => [e.i, e.t]));

  const rows = [...verdicts.entries()].map(([id, v]) => ({
    id,
    stars: starOf.get(id) ?? 0,
    type: typeOf.get(id) ?? null,
    tags: tagOf.get(id) ?? [],
    ...v,
  }));

  mkdirSync(DATA_DIR, { recursive: true });
  const out = resolve(DATA_DIR, "evidence-preview.json");
  writeFileSync(out, JSON.stringify(rows, null, 0), "utf8");

  const kinds = {
    skill: kept.filter(([, v]) => v.kind === "skill").length,
    plugin: kept.filter(([, v]) => v.kind === "plugin").length,
    unknown: kept.filter(([, v]) => v.kind === null).length,
  };

  console.log("");
  console.log(`[preview] 判定完成：保留 ${kept.length} 条（skill ${kinds.skill} / plugin ${kinds.plugin} / 类型待定 ${kinds.unknown}），判无关 ${dropped.length} 条`);
  console.log(`[preview] 明细已写入 ${out}`);
  console.log("");
  console.log(`[preview] 判无关按星标降序（前 30）：`);
  const sorted = dropped.map(([id, v]) => ({ id, stars: starOf.get(id) ?? 0, tags: tagOf.get(id) ?? [], e: v.e })).sort((a, b) => b.stars - a.stars);
  for (const r of sorted.slice(0, 30)) {
    console.log(`  ${String(r.stars).padStart(6)}  ${r.id}  tags=${r.tags.slice(0, 4).join(",")}`);
  }
  const tagCount = new Map<string, number>();
  for (const r of sorted) for (const t of r.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  console.log("");
  console.log(`[preview] 判无关条目的话题分布（前 10）：${[...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => `${t}:${n}`).join("  ")}`);
}

main().catch((err) => {
  console.error(`[preview] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
