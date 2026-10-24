# DSH 插件集市

DeepSeek Harness（DSH）插件与工具目录，线上地址 <https://shelfry.app>。

每天自动从 GitHub 收录插件，按「可装性、维护活跃、实用度、生态热度」综合评分排序，提供全文搜索、分类筛选、榜单、收藏与安装命令。

## 结构

单仓多包，npm workspaces：

| 包 | 职责 |
| --- | --- |
| `packages/schema` | 共享类型、评分字段、切片与短键定义 |
| `packages/collector` | 收录管道：拉取 → 过滤 → 评分 → 生成静态产物 |
| `packages/web` | Vite + React 站点（BrowserRouter、Fuse.js 检索） |

数据产物不进 git：收录结果写进仓库根 `.data/`，构建时同步到 `packages/web/public/data/`，最终随站点一起部署。

## 常用命令

```bash
npm install            # 安装依赖
npm run dev            # 本地起站点（http://localhost:5173）
npm run build:data     # 只跑收录管道并生成 .data/
npm run build          # 构建站点到 packages/web/dist
npm run build:site     # 收录 + 构建，一条命令出完整产物
npm run typecheck      # 全仓类型检查
```

收录需要 GitHub API。未配置 token 时会自动降级到镜像种子源，只适合本地试跑：

```bash
GITHUB_TOKEN=ghp_xxx npm run collect -- --source auto --limit 20000 --build
```

## 收录管道

1. **检索**：GitHub Search API 按关键词分片拉取（DSH 相关 topic、仓库名、描述），需要认证 token，未鉴权会被限流。
2. **过滤**：只保留上游明确写出 `dsh add` / `dsh install` 安装规格的条目；全局安装命令与无效规格排除。
3. **评分**：可装性权重最高，叠加维护活跃、实用度、生态热度、便捷度、信号质量。
4. **补摘要**：上游没写简介的条目读一次 README，取首段有效文字存成 `readmeSummary`，前端分类规则在仓库名/简介都判不出来时用它兜底（单轮上限 `README_SUMMARY_LIMIT`，默认 2000）。
5. **标镜像**：同名仓库 ≥3 个或描述自称镜像/克隆时，产物里打 `dp: 1`，前端显示「镜像仓库」并在综合排序中沉底。
6. **产出**：`lite.json`（全量浏览切片）、`pages/NNNN.json`（每页 60 条）、`catalog/NNNN.json`（明细分片）、`idmap.json`、`artifacts.json`、`meta.json`、`categories.json`。

### 站内收录管理

顶部「收录」按钮点开后是导航下方展开的面板，进入需要管理密码；名单以 Cloudflare KV 为写入缓冲，每次 CI 构建前同步回仓库文件并提交进 git，永久留存、可 diff 追溯：

| 位置 | 作用 |
| --- | --- |
| `curation/queue.json` | 待收录队列：跳过检索发现层，按仓库全名强制拉取；类型与分类仍走自动判定，不手填卡片 |
| `curation/blocklist.json` | 永久剔除名单：合并后过滤，下次构建起从站点消失 |
| KV 键 `queue` / `blocklist` | 站内弹框直接写入这里，CI 每轮同步覆盖上面的两个文件 |
| KV 键 `pending` | 访客在「提交插件」页发来的待确认申请，只对输密码的管理员可见，不进产物 |

优先级 **队列 > 黑名单**：同一仓库两边都有时按收录处理，所以「恢复收录」只需把它放回队列，黑名单里的旧记录也会一并清掉。

访客提交走同一个 Function 的 `submit` 动作：不需要密码，只写 `pending`（按 IP 每小时限 10 次、按仓库去重）；管理员在面板「待确认收录」里点「收录」移入队列、点「忽略」仅移出待确认。提交页同时保留 GitHub Issue 链接，作为 GitHub Pages 静态兜底的备用通道。

GitHub Issue 通道由 [submission-sync.yml](file:///Users/yanglinlin/Documents/Trae-CN/temp_20261020_01/.github/workflows/submission-sync.yml) 自动同步：带 `plugin-submission` 标签（或标题以 `[插件提交]` 开头）的 Issue 创建或打标签时，工作流解析正文里的仓库、安装规格、分类与说明，调用 `submit` 写入待确认，并在 Issue 下回一条状态评论（已带 `<!-- curation-sync -->` 标记的会跳过，避免重复）。仓库里没有 `plugin-submission` 标签时工作流会自动创建并补打到 Issue 上。手动跑该工作流会扫描所有未关闭、带标签或标题符合模板的 Issue，用于补同步历史工单。同步只进待确认，审核仍在收录面板。

读写接口是 Cloudflare Pages Function [curation.ts](file:///Users/yanglinlin/Documents/Trae-CN/temp_20261020_01/functions/api/curation.ts)：`GET` 返回两份公开名单；`POST` 的 `submit` 动作公开写入待确认，其余动作校验密码后写 KV。全流程不需要 GitHub 令牌：KV 绑定写在 [wrangler.toml](file:///Users/yanglinlin/Documents/Trae-CN/temp_20261020_01/wrangler.toml)，CI 用 Actions 自带的 `GITHUB_TOKEN` 提交同步结果，因此工作流权限是 `contents: write`。

只配一个环境变量：

- `CURATION_PASS`：管理密码的 PBKDF2-SHA256 哈希，格式 `pbkdf2$<轮数>$<saltHex>$<hashHex>`，明文不入库。

注意 Workers 运行时的 PBKDF2 迭代上限是 **100000**，超过会直接抛错，生成哈希时别用默认的更大值：

```bash
node -e 'const c=require("crypto");const n=100000,s=c.randomBytes(16);console.log(`pbkdf2$${n}$${s.toString("hex")}$${c.pbkdf2Sync(process.argv[1],s,n,32,"sha256").toString("hex")}`)' '新密码'
printf '%s' '<hash>' | npx wrangler pages secret put CURATION_PASS --project-name dsh-shelfry
```

## 部署

`.github/workflows/deploy.yml` 每天 UTC 18:17（北京 02:17）跑一次，也支持 push 与手动触发：

1. 同步收录名单（站内 KV → `curation/*.json`，有变化就提交；接口不可用时保留仓库版本）
2. `npm ci` → 类型检查 → 跑收录管道（`.data/` 命中 Actions 缓存，未过期的版本号与下载量不重查）
3. `npm run build` 构建静态站
4. `wrangler pages deploy` 推到 Cloudflare Pages 项目 `dsh-shelfry`

需要仓库 secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`GH_SEARCH_TOKEN`。

部署失败会自动开 Issue 告警（标签 `ci-failure`），已有未关闭的告警就追加评论，不重复刷。

**回滚**：Cloudflare Pages 控制台可把任意历史部署设为生产版本。GitHub Pages 仍在同步部署，作为第二重回滚路径。

## 站点实现要点

- **深链**：真实路径 `/p/owner/repo`，由 `public/_redirects` 的 `/* /index.html 200` 交给单页应用，避免 404。
- **首屏**：只拉第 0 页（60 条）；搜索、筛选、非默认排序时才加载全量 `lite.json`。
- **分类**：`src/lib/labels.ts` 维护固定分类规则，依次匹配「已知高频分类 → 标签规则 → 名称/简介文案规则 → 镜像兜底」。
- **SEO**：每页 `useSeo` 写 title/description/canonical/JSON-LD；sitemap 由 `vite.config.ts` 按评分取前 `SITEMAP_LIMIT`（3000）条生成。
- **缓存**：`public/_headers` 给带 hash 的 `/assets/*` 长缓存，`/data/*` 短缓存加 `stale-while-revalidate`。

## 注意

- **`robots.txt` 不能屏蔽 `/data/`**：站点是客户端渲染，屏蔽数据目录会导致 Google 渲染出空页，被判软 404。
- 不存在的仓库详情页会输出 `noindex,follow`，避免空页被收录。
- 收录数据会随上游删库而失效，详情页有缺失兜底但不会自动下架链接。
- 数据产物只存在于构建产物与 CI 缓存，本地 `.data/` 可随时删除重建。
