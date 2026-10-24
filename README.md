# DSH 插件集市

DeepSeek Harness（DSH）插件与工具目录，线上地址 <https://dsh.shelfry.app>。

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

顶部「收录」菜单是站长专用的弹框（写操作需密码），名单以文件形式存在仓库里，提交进 git，永久留存、可 diff 追溯：

| 文件 | 作用 |
| --- | --- |
| `curation/queue.json` | 待收录队列：跳过检索发现层，按仓库全名强制拉取；类型与分类仍走自动判定，不手填卡片 |
| `curation/blocklist.json` | 永久剔除名单：合并后过滤，下次构建起从站点消失 |

优先级 **队列 > 黑名单**：同一仓库两边都有时按收录处理，所以「恢复收录」只需把它放回队列，黑名单里的旧记录也会一并清掉。

读写接口是 Cloudflare Pages Function [curation.ts](file:///Users/yanglinlin/Documents/Trae-CN/temp_20261020_01/functions/api/curation.ts)：`GET` 返回两份名单，`POST` 校验密码后通过 GitHub Contents API 提交，不依赖数据库。需要给 Pages 项目配两个环境变量：

- `CURATION_PASS`：管理密码的 PBKDF2-SHA256 哈希，格式 `pbkdf2$<轮数>$<saltHex>$<hashHex>`，明文不入库；
- `CURATION_GH_TOKEN`：细粒度 PAT，仅本仓库 `Contents: Read and write`。

改密码时先生成新哈希，再更新环境变量：

```bash
node -e 'const c=require("crypto");const n=210000,s=c.randomBytes(16);console.log(`pbkdf2$${n}$${s.toString("hex")}$${c.pbkdf2Sync(process.argv[1],s,n,32,"sha256").toString("hex")}`)' '新密码'
printf '%s' '<hash>' | npx wrangler pages secret put CURATION_PASS --project-name dsh-shelfry
```

## 部署

`.github/workflows/deploy.yml` 每天 UTC 18:17（北京 02:17）跑一次，也支持 push 与手动触发：

1. `npm ci` → 类型检查 → 跑收录管道（`.data/` 命中 Actions 缓存，未过期的版本号与下载量不重查）
2. `npm run build` 构建静态站
3. `wrangler pages deploy` 推到 Cloudflare Pages 项目 `dsh-shelfry`

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
