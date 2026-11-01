<p align="center">
  <img src="assets/logo.svg" width="96" alt="dsh-shelfry logo">
</p>

# dsh-shelfry

[English](README.md) | 中文

装在 DeepSeek Harness 里的插件市场。它基于
[dsh-market](https://github.com/dsh-market/dsh-market) 改造，目录数据换成
**shelfry**。dsh 0.2.1 起它是 **插件** 页上紧挨着 **已安装** 的一个页签；
更早的宿主从设置 → **Shelfry 市场** 进入。逛一逛，点一下，装好。

本包**没有发布到 npm**，从仓库安装。

## 安装

```sh
dsh plugin --profile web add github:shelfry/dsh-shelfry
```

装完重启 `dsh web`。profile 不是 `web` 的话换个名字：

```sh
dsh plugin --profile <profile> add github:shelfry/dsh-shelfry
```

从 git 源安装时，pnpm 会先问是否允许运行构建脚本。`client/client.js` 已经
随仓库提交，所以市场本身不需要构建；也可以把预构建的 tarball 挂到 release
上走那条路。

装了 DSH 桌面端的机器上，`dsh plugin --profile web` 装进的是
`profiles/web`，**不是**桌面端在用的那个 profile。这种情况请用应用里的
**设置 → 插件** 安装。

## 目录数据

插件列表实时取自 shelfry：

```
https://shelfry.app/data/market-top.json
```

这份文件有自己的结构（`entries[]`，字段 `i`、`n`、`d`、`s`、`sc`、`t`、
`vr`、`g`、`cmd`），由 [`src/shelfry-catalog.ts`](src/shelfry-catalog.ts)
映射成市场内部的 `Registry`。两个下载地区读同一个地址——shelfry 只公开这一份
JSON，没有镜像可以退，市场也不做「换一个镜像」的假动作。

想指到别处，在 dsh 运行的环境里设 `DSHM_REGISTRY_URL`。这个覆盖是**替换**
来源列表，而不是加在队首。

## 配置

所有设置都在 profile 的 `cordis.patch.yml` 的 `config:` 下面——加载器只把
这个子对象传给插件，写在顶层的键会被静默忽略：

```yaml
- id: dsh-shelfry
  name: 'dsh-shelfry'
  config:
    allowRestart: false   # 隐藏重启按钮（systemd / pm2 / launchd）
    buildEnv:
      CC: /usr/bin/gcc-11
      CXX: /usr/bin/g++-11
```

- `allowRestart` —— 本进程是 systemd 的服务主进程时，重启按钮会自动隐藏；
  pm2 和 launchd 检测不到，这些部署要手动设这一项。
- `buildEnv` —— 市场拉起的每个进程（安装、编译、git）的环境变量。`PATH` 和
  `CI` 由市场自己管理，不能覆盖。
- `DSHM_GITHUB_PROXY` —— 运营方持有的 GitHub 加速前缀；设了它，界面里的对应
  输入框会变成只读。

其余大部分在界面里改：下载地区、GitHub 加速、更新通道、入口（侧栏 / 设置 /
插件页签）、构建环境、收藏、分组，以及每个插件的一行备注。

## 它有什么

浏览和搜索整个 shelfry 目录，带分类筛选、星标数和跟随界面语言的简介；每张卡片
有截图和讨论区；收藏；可以整体开关的分组；装完即生效的主题；一键安装与实时
进度；备份与恢复（本地 JSON、WebDAV、私有 GitHub Gist）；逐插件检查更新并附
「更新内容」；中国大陆地区的 GitHub 线路降级；卸载；通过 `cordis.patch.yml`
热启用/停用；不能热加载时的一键重启；启动失败后的「调整插件」恢复页；脱敏的
日志导出；管理市场自身的设置卡片；以及查看加载顺序与冲突的诊断页。

安装顺序：仓库校验过的 npm 包优先，其次是作者预构建的 GitHub Release
tarball，最后才是整仓库源码。构建脚本默认被拦住（pnpm ≥10），放行需要你针对
单个包明确同意。

## 开发

```sh
npm install
npm run typecheck   # 宿主、客户端、测试三份
npm test            # vitest，3000+ 用例
npm run build       # lib/ 与 client/client.js
```

`client/client.js` 是提交进仓库的产物：改了源码要重新构建并一起提交。
`scripts/preflight.mjs`（由 `prepack` 触发）会检查这个文件里的 loader id 与
`package.json` 一致、`cordis.patch.yml` 按同一个名字插入，以及声明的图标有没有
打进去。

浏览器产物以 `window.__ModuleLoader__.load({ id })` 注册自己，id 必须等于包名
——不一致就一个界面都加载不出来。

代码规范见 [TESTING.md](TESTING.md)，安全边界见 [SECURITY.md](SECURITY.md)。

## 许可

MIT。本项目是 dsh-market 的衍生修改版，原始版权声明保留在
[LICENSE](LICENSE)。
