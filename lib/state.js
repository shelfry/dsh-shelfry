import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
/**
 * 每个 profile 的状态目录名。
 * 0.5 起由 `.dsh-shelfry` 改为 `.dsh-crate`，旧目录在首次访问时就地改名。
 */
export const STATE_DIR_NAME = '.dsh-crate';
/** 0.4.x 使用的旧目录名，只用于迁移，不再写入。 */
const LEGACY_STATE_DIR_NAME = '.dsh-shelfry';
/**
 * 返回可用的状态目录。
 *
 * 入参：profileDir —— profile 根目录的绝对路径。
 * 返回：新目录路径；旧目录存在且新目录不存在时，先把旧目录改名再返回。
 * 改名失败时回退到旧目录，保证数据仍可读写，不影响启动。
 */
export function stateDir(profileDir) {
    const current = join(profileDir, STATE_DIR_NAME);
    const legacy = join(profileDir, LEGACY_STATE_DIR_NAME);
    if (existsSync(current) || !existsSync(legacy))
        return current;
    try {
        renameSync(legacy, current);
        return current;
    }
    catch {
        return legacy;
    }
}
/**
 * 拼出状态目录下的文件路径。
 *
 * 入参：profileDir —— profile 根目录；parts —— 目录内的相对路径片段。
 * 返回：完成迁移后的绝对路径。
 */
export function statePath(profileDir, ...parts) {
    return join(stateDir(profileDir), ...parts);
}
