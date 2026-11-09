import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stateDir, statePath, STATE_DIR_NAME } from '../src/state.ts'

const profiles: string[] = []

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crate-state-'))
  profiles.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of profiles.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('stateDir', () => {
  it('没有旧目录时直接返回新目录，不创建任何东西', () => {
    const dir = profile()
    expect(stateDir(dir)).toBe(join(dir, STATE_DIR_NAME))
    expect(existsSync(join(dir, STATE_DIR_NAME))).toBe(false)
  })

  it('旧目录存在时就地改名，原有文件跟着搬过去', () => {
    const dir = profile()
    mkdirSync(join(dir, '.dsh-shelfry'), { recursive: true })
    writeFileSync(join(dir, '.dsh-shelfry', 'presets.json'), '{"presets":[]}')
    const next = stateDir(dir)
    expect(next).toBe(join(dir, STATE_DIR_NAME))
    expect(readFileSync(join(next, 'presets.json'), 'utf8')).toBe('{"presets":[]}')
    expect(existsSync(join(dir, '.dsh-shelfry'))).toBe(false)
  })

  it('新旧目录同时存在时保留新目录，旧目录不动', () => {
    const dir = profile()
    mkdirSync(join(dir, STATE_DIR_NAME), { recursive: true })
    mkdirSync(join(dir, '.dsh-shelfry'), { recursive: true })
    writeFileSync(join(dir, STATE_DIR_NAME, 'state.json'), '{"new":true}')
    writeFileSync(join(dir, '.dsh-shelfry', 'state.json'), '{"old":true}')
    const next = stateDir(dir)
    expect(next).toBe(join(dir, STATE_DIR_NAME))
    expect(readFileSync(join(next, 'state.json'), 'utf8')).toBe('{"new":true}')
    expect(readFileSync(join(dir, '.dsh-shelfry', 'state.json'), 'utf8')).toBe('{"old":true}')
  })

  // Windows 的 chmod 只切只读位，挡不住 rename，无法构造这个失败场景
  it.skipIf(process.platform === 'win32')('改名失败时回退到旧目录，数据仍可读写', () => {
    const dir = profile()
    mkdirSync(join(dir, '.dsh-shelfry'), { recursive: true })
    writeFileSync(join(dir, '.dsh-shelfry', 'state.json'), '{"old":true}')
    // 父目录只读，rename 会失败；测试结束后 afterEach 恢复权限再清理
    chmodSync(dir, 0o500)
    const next = stateDir(dir)
    expect(next).toBe(join(dir, '.dsh-shelfry'))
    expect(readFileSync(join(next, 'state.json'), 'utf8')).toBe('{"old":true}')
  })
})

describe('statePath', () => {
  it('先完成迁移再拼出目标文件路径', () => {
    const dir = profile()
    mkdirSync(join(dir, '.dsh-shelfry'), { recursive: true })
    writeFileSync(join(dir, '.dsh-shelfry', 'presets.json'), '{}')
    expect(statePath(dir, 'presets.json')).toBe(join(dir, STATE_DIR_NAME, 'presets.json'))
    expect(existsSync(join(dir, STATE_DIR_NAME, 'presets.json'))).toBe(true)
  })

  it('支持多段相对路径', () => {
    const dir = profile()
    expect(statePath(dir, 'snapshots', 's1.json')).toBe(join(dir, STATE_DIR_NAME, 'snapshots', 's1.json'))
  })
})
