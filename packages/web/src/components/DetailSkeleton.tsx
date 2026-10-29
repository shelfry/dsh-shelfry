import { Fragment } from "react";

/**
 * 详情页主体骨架：与真实详情页同结构、同尺寸。
 *
 * 详情页要先拉 idmap + 明细分片，再去抓 README；这段时间原来只有一行「加载中」，
 * 内容到达后整页从一句话突然撑开，是一次大幅跳版。
 * 这里直接复用详情页已有的真实 class（.detail-head / .panel / .about-grid / .install-row / .kv），
 * 只把文字换成灰条，所以各面板的位置与高度和加载完成后基本一致。
 * 纯展示组件，无状态；对读屏器隐藏，加载提示由页面上的 .sr-only 文本承担。
 */
export function DetailSkeleton() {
  return (
    <div className="detail-skeleton" aria-hidden="true">
      <span className="sk sk-detail-back" />
      <HeadSkeleton />
      <AboutSkeleton />
      <InstallSkeleton />
      <section className="panel">
        <span className="sk sk-panel-title" />
        <ReadmeSkeleton />
        <div className="sk-readme-actions">
          <span className="sk sk-readme-btn" />
          <span className="sk sk-readme-link" />
        </div>
      </section>
    </div>
  );
}

/**
 * README 区加载骨架：按正文行距铺灰条。
 *
 * 详情页里的 README 是异步抓取的（最多串行试 5 个文件名），
 * 这里按常见正文行数铺满，内容到达后整块替换；仓库没有 README 时回落到页面提示。
 * 单独导出是因为主页面已经渲染出来后，README 往往还在加载。
 */
export function ReadmeSkeleton() {
  return (
    <div className="sk-readme" aria-hidden="true">
      {Array.from({ length: 14 }, (_, i) => <span className="sk" key={i} />)}
    </div>
  );
}

/** 标题区：标题行、两个胶囊、星标按钮与作者信息行。 */
function HeadSkeleton() {
  return (
    <header className="detail-head">
      {/* 标题行盒 42px（27px × 1.55），灰条只占中间 20px */}
      <div className="detail-title sk-detail-title-row">
        <span className="sk sk-detail-name" />
        <span className="sk sk-detail-pill" />
        <span className="sk sk-detail-star" />
      </div>
      <div className="detail-sub">
        <span className="sk sk-detail-avatar" />
        <span className="sk sk-detail-sub-bar sk-detail-handle" />
        <span className="sk sk-detail-sub-bar sk-detail-ver" />
        <span className="sk sk-detail-sub-bar sk-detail-stat" />
      </div>
    </header>
  );
}

/** 简介面板：简介两行、四条事实徽标、两行标签，右侧评分卡、底部来源行。 */
function AboutSkeleton() {
  return (
    <section className="panel">
      <span className="sk sk-panel-title" />
      <div className="about-grid">
        <div className="about-main">
          <div className="sk-detail-desc">
            <span className="sk" />
            <span className="sk" />
            <span className="sk" />
          </div>
          <div className="about-facts">
            {[0, 1, 2, 3].map((i) => (
              <span className="fact" key={i}>
                <span className="sk sk-fact-k" />
                <span className="sk sk-fact-v" />
              </span>
            ))}
          </div>
          {/* 复用 is-capped：容器固定两行高 48px，标签数量变化也不会撑高面板 */}
          <div className="about-tags is-capped">
            <div className="tags detail-tags">
              {[0, 1, 2, 3, 4, 5].map((i) => <span className="sk sk-detail-tag" key={i} />)}
            </div>
          </div>
        </div>
        <ScoreSkeleton />
      </div>
      <div className="about-meta">
        <span className="about-meta-item">
          <span className="sk sk-meta-k" />
          <span className="sk sk-meta-v" />
        </span>
        <span className="about-meta-item">
          <span className="sk sk-meta-k sk-meta-k-sm" />
          <span className="sk sk-meta-v sk-meta-v-sm" />
        </span>
      </div>
    </section>
  );
}

/** 四条维度条的占位宽度：只求像横条，不表达任何真实分值。 */
const SCORE_BAR_WIDTHS = ["72%", "86%", "62%", "78%"];

/** 评分卡：标题行 + 四条维度条 + 两行说明。 */
function ScoreSkeleton() {
  return (
    <aside className="about-score">
      <div className="about-score-head">
        <span className="sk sk-score-title" />
        <span className="sk sk-score-total" />
      </div>
      <div className="bars">
        {SCORE_BAR_WIDTHS.map((width, i) => (
          <div className="bar-row" key={i}>
            <span className="sk sk-bar-label" />
            <span className="bar-track">
              <span className="sk sk-bar-fill" style={{ width }} />
            </span>
          </div>
        ))}
      </div>
      <div className="sk-score-note">
        <span className="sk" />
        <span className="sk" />
      </div>
    </aside>
  );
}

/** 安装面板：命令行行、桌面版说明行、四条键值对。 */
function InstallSkeleton() {
  return (
    <section className="panel">
      <span className="sk sk-panel-title" />
      <div className="install-rows">
        <div className="install-row">
          <div className="install-row-head">
            <span className="sk sk-install-k" />
          </div>
          {/* 复用 .code：内边距与虚线边框照旧，只把命令文字换成灰条 */}
          <div className="code">
            <span className="sk sk-code-line" />
          </div>
        </div>
        <div className="install-row">
          <div className="install-row-head">
            <span className="sk sk-install-k sk-install-k-sm" />
          </div>
          <span className="sk sk-install-note" />
        </div>
      </div>
      <dl className="kv">
        {[0, 1, 2, 3].map((i) => (
          <Fragment key={i}>
            <dt><span className="sk sk-kv-k" /></dt>
            <dd><span className="sk sk-kv-v" /></dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}
