/**
 * 列表加载中的骨架卡片。
 *
 * 尺寸与真实卡片对齐（同一套 .card / .card-head / .card-foot 结构与固定高度），
 * 数据到达后直接把灰块换成真卡片，不会出现整块列表高度跳动。
 * 纯展示组件，无状态、无副作用；对读屏器隐藏，避免念一串空元素。
 */
export function CardSkeleton({ count = 6 }: { count?: number }) {
  // 数量只用于铺首屏，非法入参直接按默认值处理
  const rows = Array.from({ length: Math.max(1, Math.min(24, count)) }, (_, i) => i);

  return (
    <div className="grid" aria-hidden="true">
      {rows.map((i) => (
        <div className="card sk-card" key={i}>
          <div className="card-head">
            <span className="sk sk-avatar" />
            <span className="sk sk-title" />
          </div>
          <span className="sk sk-meta" />
          <span className="sk sk-path" />
          <div className="sk-desc">
            <span className="sk" />
            <span className="sk" />
            <span className="sk" />
          </div>
          <div className="card-foot">
            <span className="sk sk-tag" />
            <span className="sk sk-tag sk-tag-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 榜单页（/top）的加载骨架。
 *
 * 该页是「序号 + 名称 + 指标」的行式列表，不是卡片网格，所以单独按 .rank-row
 * 的结构排布，行高与真实行一致，数据到达时不会由卡片突变成列表。
 * 入参 count：渲染几行，默认 10 行。
 */
export function RankSkeleton({ count = 10 }: { count?: number }) {
  const rows = Array.from({ length: Math.max(1, Math.min(50, count)) }, (_, i) => i);

  return (
    <ol className="rank-list" aria-hidden="true">
      {rows.map((i) => (
        <li className="rank-row sk-card" key={i}>
          <span className="sk sk-rank-no" />
          <div className="rank-main">
            <span className="sk sk-rank-name" />
            <div className="rank-meta">
              <span className="sk sk-rank-avatar" />
              <span className="sk sk-rank-id" />
            </div>
            <div className="sk-rank-desc">
              <span className="sk" />
              <span className="sk" />
            </div>
          </div>
          <div className="rank-nums">
            <span className="sk sk-num" />
            <span className="sk sk-num" />
            <span className="sk sk-num sk-num-sm" />
          </div>
        </li>
      ))}
    </ol>
  );
}
