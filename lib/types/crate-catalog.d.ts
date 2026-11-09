import type { Registry, RegistryPlugin } from './registry.ts';
/**
 * 判断一份 JSON 是否为 crate 目录。
 *
 * 只用结构特征，不依赖某个版本号：带 `entries` 数组且没有 `plugins` 数组的
 * 就是 crate 形态，旧目录照常走 `asRegistry`，两套夹具互不干扰。
 */
export declare function isCrateCatalog(value: unknown): boolean;
/**
 * 把 crate 目录映射成市场内部的 Registry。
 *
 * @param value - 已经 `JSON.parse` 过的载荷。
 * @returns 条目已校验、分类已归一化的目录。
 * @throws 载荷不是对象、缺少 entries、或没有一条可用条目时抛出。
 */
export declare function asCrateRegistry(value: unknown): Registry;
/**
 * 单条 crate 条目转成 RegistryPlugin。
 *
 * @param entry - entries 数组里的一项，来源不可信，逐字段校验。
 * @returns 映射结果；缺少仓库路径或展示名时返回 null，由调用方跳过。
 */
export declare function asCratePlugin(entry: unknown): RegistryPlugin | null;
/**
 * 条目类型转分类 id。
 *
 * @param type - crate 的 `t` 字段，可能是任何类型。
 */
export declare function categoryOf(type: unknown): string;
/**
 * 从安装命令里取出 npm 包名。
 *
 * 命令形如 `dsh plugin --profile web add @scope/name@1.2.3`；版本号与 tag 都要
 * 去掉，带变量的地址（`github:...#${DSH_PLUGIN_REF}`）和本地绝对路径都不是
 * npm 包名，返回 null 让安装回落到 GitHub 源。
 *
 * @param command - crate 的 `cmd` 字段，可能是任何类型。
 * @returns 合法 npm 包名，或 null。
 */
export declare function npmFromCommand(command: unknown): string | null;
/**
 * 去掉安装源末尾的 `@版本` 或 `@tag`。
 *
 * 从下标 1 开始查找，避免把作用域包名开头的 `@` 当成版本分隔符。
 *
 * @param spec - 安装源，例如 `@scope/name@1.2.3`。
 */
export declare function stripSpecVersion(spec: string): string;
