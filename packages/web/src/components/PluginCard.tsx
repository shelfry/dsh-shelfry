import type { LiteEntry } from "@dsh-shelfry/schema";

export const STATUS_LABEL: Record<0 | 1 | 2, string> = {
  0: "已验证",
  1: "待验证",
  2: "安装失败",
};

/** 状态字符串（详情页用的是 verification.status 字符串，不是 0/1/2 编码）。 */
export const STATUS_TEXT: Record<"verified" | "pending" | "failed", string> = {
  verified: "已验证",
  pending: "待验证",
  failed: "安装失败",
};

export const STATUS_CODE: Record<"verified" | "pending" | "failed", 0 | 1 | 2> = {
  verified: 0,
  pending: 1,
  failed: 2,
};

export const STATUS_TITLE: Record<0 | 1 | 2, string> = {
  0: "已在本机隔离环境实测：能装上且能加载",
  1: "尚未实测安装，仅有收录信息",
  2: "实测安装失败，通常是不兼容当前 dsh 版本",
};

export function StatusBadge({ v }: { v: 0 | 1 | 2 }) {
  return (
    <span className={`badge v${v}`} title={STATUS_TITLE[v]}>
      {STATUS_LABEL[v]}
    </span>
  );
}

function relativeDays(iso: string | null): string {
  if (!iso) return "无提交记录";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "今天有提交";
  if (days < 30) return `${days} 天前提交`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前提交`;
  return `${Math.floor(days / 365)} 年前提交`;
}

export function PluginCard({ item, onOpen }: { item: LiteEntry; onOpen: () => void }) {
  return (
    <article className="card" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <div className="card-top">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-name">{item.n}</div>
          <div className="card-full">{item.i}</div>
        </div>
        <StatusBadge v={item.v} />
      </div>
      <p className="card-desc">{item.d || "（无简介）"}</p>
      {item.tg.length > 0 && (
        <div className="tags">
          {item.tg.slice(0, 4).map((t) => <span className="tag" key={t}>{t}</span>)}
          {item.tg.length > 4 && <span className="tag">+{item.tg.length - 4}</span>}
        </div>
      )}
      <div className="card-foot">
        <span>★ {item.s}</span>
        <span>·</span>
        <span>评分 {item.sc}</span>
        <span>·</span>
        <span>{relativeDays(item.p)}</span>
        {item.t === "skill" && <><span>·</span><span className="badge tone-mute">skill</span></>}
      </div>
    </article>
  );
}
