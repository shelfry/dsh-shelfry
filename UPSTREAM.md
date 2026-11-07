# 上游同步规则

上游仓库：`dsh-market/dsh-market`
本地仓库：`shelfry/dsh-shelfry`（远端 `origin`）

原则：**不整包 merge，不照抄版本号，只按提交搬需要的东西。**

触发同步的三种情况，除此之外不动：

1. 宿主 `dsh` 升级导致 API 不兼容
2. 上游修了我们需要的 bug（安装、滚动、吸顶、图标、升级链路等）
3. 上游发布安全修复

## 固定动作

```bash
# 1. 拉取上游标签
git fetch upstream --tags

# 2. 看两个版本之间改了什么
git log --oneline --no-merges v1.73.14..v1.73.15
git diff --stat v1.73.14..v1.73.15

# 3. 判断单个提交的改动面
git show --stat <sha>

# 4. 只搬需要的提交（冲突时手工合并，禁止 --theirs 整段覆盖）
git cherry-pick <sha>

# 5. 三道门
npm test
npm run typecheck
npm run build:client
```

`npm test` 会跑 `tests/brand-guard.spec.ts`，品牌、数据源、三语文案、视觉几何共 23 项断言，任何一项红都说明同步把本地定制覆盖了。

## 分类与处理

| 上游改动类型 | 处理方式 |
|---|---|
| 宿主 API 兼容、启动崩溃、安装/升级逻辑 | 必须跟，优先 cherry-pick |
| 插件页 / 设置页 bugfix | 跟，但落到本地定制 UI 上手动适配 |
| 纯品牌、文案、发布脚本、版本号、README | 跳过 |
| 大范围重命名 / 重构（包名、namespace 批量替换） | 不整段照抄，只提取功能点重写 |

## 文件边界

| 路径 | 策略 |
|---|---|
| `src/`（`src/client/` 除外） | 可以直接搬 |
| `src/client/` | 本地定制 UI，**不整体覆盖**；只手工移植单个修复 |
| `src/client/locales.ts` | 三语文案与品牌措辞，任何覆盖都要人工核对 |
| `client/client.js` | 构建产物，搬完源码后跑 `npm run build:client` 重建 |
| `locale/*.json` | 插件元信息，保留本地描述 |
| `package.json` | 保留 `name: dsh-shelfry`、`version: 0.4.x`、`icon`、`repository`、`files` |

## 保护机制

目的：上游同步时，凡本地定制一律不自动覆盖；被覆盖时测试立即变红，不靠肉眼检查。

### 保护清单 `sync/protected.json`

列出禁止整文件覆盖的路径，字段为 `path` / `why` / `merge`。同步脚本读取该文件；命中的文件只输出 diff，不写盘，由人工逐块合并。

覆盖范围：数据源地址、插件身份与自识别集合、三语文案、插件端界面、滚动与吸顶样式、导航图标、构建产物、插件元信息、包身份、logo。

### 防护断言

`tests/brand-guard.spec.ts` 共 32 项，随 `npm test` 运行：

| 组 | 覆盖内容 | 数量 |
|---|---|---|
| A | 身份与升级 | 9 |
| B | 数据源 | 1 |
| C | 品牌文案 | 9 |
| D | 视觉与几何 | 4 |
| E | 布局与滚动（底部留白、设置页吸顶与背景色、无内层滚动、插件页整页滚动、全屏、吸顶变量） | 6 |
| F | 导航图标（行选择器、尺寸与掩膜、标记与清除） | 3 |

上游同步后若 E/F 变红，说明滚动态、底部留白、导航背景色或图标定制被覆盖，按清单恢复后再提交。

## 已知坑

- 上游和本地都改过的文件（`locales.ts`、`MarketSection.tsx`、`client.js`）cherry-pick 必冲突，必须逐块手工合并
- 上游版本号是 `1.73.x`，本地是 `0.4.x`；不要引入上游版本号、tag、包名
- 上游的品牌字符串（`dsh-market`、`Plugin Market`、`插件市场`）不能进入 `src/client` 与 `locale`
- 上游的 registry / catalog 源地址不能覆盖 `src/regions.ts` 里的 `CATALOG_OFFICIAL`

## 同步记录

| 日期 | 上游范围 | 采纳提交 | 本地提交 | 跳过项与原因 |
|---|---|---|---|---|
| 2026-11-07 | v1.73.7 → v1.73.14 | 服务端与界面层整批（`cd92fa0`、`d6a4680`） | `ff4d0e7`、`fb490bd`、`f31dcd2` | 上游品牌与版本号，未采纳 |
| 2026-11-07 | 同步后修复 | — | `d9eb738`、`004e363`、`0a6101f` | 文案被覆盖，补 e2e 断言与品牌防护 |

新的同步完成后，在表里追加一行：上游版本范围、采纳的 commit、对应的本地 commit、跳过项及原因。
