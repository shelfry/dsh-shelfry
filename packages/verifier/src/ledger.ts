import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginEntry, Verification } from "@dsh-shelfry/schema";
import { DATA_DIR } from "@dsh-shelfry/collector/config";

/**
 * 验证结论账本。
 *
 * 为什么需要它：catalog.json 每次 CI 都从零生成（收录数据不进 git），而验证一条要
 * 十几秒到几分钟，全量 13k 条不可能每天重跑。所以把「验证证据」单独存成小文件：
 * - 本地：`.data/verification-ledger.json`，跨天增量累积；
 * - CI：只缓存这一个文件（几十 KB），验证结论因此能跨构建复用。
 *
 * 账本按「安装规格」绑定证据：spec 变了（上游改包名/改安装方式），旧证据自动失效，
 * 避免把按旧规格得出的结论套到新规格上。
 */
const LEDGER_FILE = resolve(DATA_DIR, "verification-ledger.json");

interface LedgerItem {
  /** 验证时的安装规格，用于判定证据是否过期。 */
  spec: string;
  verification: Verification;
}

interface LedgerFile {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, LedgerItem>;
}

export class Ledger {
  private items: Map<string, LedgerItem>;

  constructor(items: Map<string, LedgerItem>) {
    this.items = items;
  }

  static load(): Ledger {
    if (!existsSync(LEDGER_FILE)) return new Ledger(new Map());
    try {
      const parsed = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Partial<LedgerFile>;
      const items = new Map<string, LedgerItem>();
      for (const [id, item] of Object.entries(parsed.items ?? {})) {
        if (item && typeof item.spec === "string" && item.verification) items.set(id, item);
      }
      return new Ledger(items);
    } catch {
      return new Ledger(new Map());
    }
  }

  get size(): number {
    return this.items.size;
  }

  /** 用 store 里已有的验证证据补账本（账本缺失/损坏时的自愈）。 */
  seedFrom(entries: PluginEntry[]): number {
    let n = 0;
    for (const e of entries) {
      if (e.verification.status === "pending" || !e.verification.checkedAt || !e.install.packageName) continue;
      if (!this.items.has(e.id)) {
        this.items.set(e.id, { spec: e.install.packageName, verification: e.verification });
        n++;
      }
    }
    return n;
  }

  /** 把账本里仍然有效的证据写回条目（spec 不一致的自动跳过）。 */
  applyTo(entries: PluginEntry[]): number {
    let applied = 0;
    for (const e of entries) {
      const item = this.items.get(e.id);
      if (!item || !e.install.packageName || item.spec !== e.install.packageName) continue;
      e.verification = item.verification;
      applied++;
    }
    return applied;
  }

  record(entry: PluginEntry, verification: Verification): void {
    if (!entry.install.packageName) return;
    this.items.set(entry.id, { spec: entry.install.packageName, verification });
  }

  save(): string {
    mkdirSync(DATA_DIR, { recursive: true });
    const payload: LedgerFile = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      items: Object.fromEntries([...this.items.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    writeFileSync(LEDGER_FILE, JSON.stringify(payload), "utf8");
    return LEDGER_FILE;
  }
}

export function ledgerPath(): string {
  return LEDGER_FILE;
}
