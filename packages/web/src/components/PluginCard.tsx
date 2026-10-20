import type { LiteEntry } from "@dsh-shelfry/schema";
import { Link } from "react-router-dom";
import { detailPath } from "../lib/data";

/** 「今天/3 天前/5 个月前」——比裸日期更容易判断插件还活不活。 */
export function relativeTime(iso: string | null): string {
  if (!iso) return "无提交记录";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return "无提交记录";
  if (days <= 0) return "今天有提交";
  if (days < 30) return `${days} 天前更新`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前更新`;
  return `${Math.floor(days / 365)} 年前更新`;
}

/** 头像占位：取作者名首字母，避免为了头像再多拉一次网络请求。 */
function Avatar({ id }: { id: string }) {
  const owner = id.split("/")[0] ?? "?";
  return <span className="avatar" aria-hidden="true">{owner.slice(0, 1).toUpperCase()}</span>;
}

export function PluginCard({ item }: { item: LiteEntry }) {
  return (
    <Link className="card" to={detailPath(item.i)}>
      <div className="card-head">
        <div className="card-title">
          <span className="card-name">{item.n}</span>
          {item.t === "skill" && <span className="pill pill-type">skill</span>}
          {item.c === 1 && <span className="pill pill-curated">精选</span>}
        </div>
        <span className="card-stars" title={`${item.s} 个 star`}>★ {item.s}</span>
      </div>

      <div className="card-author">
        <Avatar id={item.i} />
        <span className="author-name">{item.i.split("/")[0]}</span>
        <span className="dot">·</span>
        <span>{relativeTime(item.p)}</span>
      </div>

      <p className="card-desc">{item.d || "（上游未提供简介）"}</p>

      <div className="card-foot">
        <div className="tags">
          {item.tg.slice(0, 3).map((t) => <span className="tag" key={t}>{t}</span>)}
          {item.tg.length > 3 && <span className="tag tag-more">+{item.tg.length - 3}</span>}
        </div>
        {item.g && <span className="pill pill-compat" title={`上游声明的 dsh 兼容范围：${item.g}`}>dsh {item.g}</span>}
      </div>
    </Link>
  );
}
