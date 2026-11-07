/**
 * 飞书通知脚本的单元测试。
 *
 * 脚本对外只做一件事：把报告发出去。风险集中在签名算错、把密钥漏进消息体、
 * 发送失败静默吞掉，这里分别覆盖；网络本身不真实请求，全部用假 fetch 注入。
 */

import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- 纯 .mjs 脚本，无类型声明
import {
  buildMessage,
  buildPayload,
  parseArgs,
  postToFeishu,
  resolveWebhook,
  signFeishu,
  truncateBody,
} from '../scripts/notify-feishu.mjs'

/** 假响应：可返回成功、失败状态或抛错。 */
interface FakeResult {
  ok?: boolean
  status?: number
  data?: { code: number; msg?: string }
}

/**
 * 构造假 fetch 与调用记录。
 * @param results 依次返回的结果，用完后重复最后一个
 * @returns fetch 实现与调用记录
 */
function fakeFetch(results: Array<FakeResult | Error>) {
  const calls: Array<{ url: string; init: { body: string } }> = []
  let index = 0

  const fetchImpl = async (url: string, init: { body: string }) => {
    calls.push({ url, init })
    const item = results[Math.min(index, results.length - 1)]
    index += 1
    if (item instanceof Error) throw item
    return {
      ok: item.ok ?? true,
      status: item.status ?? 200,
      json: async () => item.data ?? { code: 0 },
    }
  }

  return { fetchImpl, calls }
}

describe('signFeishu', () => {
  it('按飞书规则算出固定签名', () => {
    expect(signFeishu(1700000000, 'test-secret')).toBe('mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84=')
  })

  it('时间戳不同则签名不同', () => {
    expect(signFeishu(1700000001, 'test-secret')).not.toBe(signFeishu(1700000000, 'test-secret'))
  })
})

describe('buildPayload', () => {
  it('无密钥时只发文本消息', () => {
    expect(buildPayload('验收通过')).toEqual({
      msg_type: 'text',
      content: { text: '验收通过' },
    })
  })

  it('有密钥时附带时间戳与签名', () => {
    const payload = buildPayload('验收通过', { timestamp: 1700000000, secret: 'test-secret' })
    expect(payload.timestamp).toBe('1700000000')
    expect(payload.sign).toBe(signFeishu(1700000000, 'test-secret'))
    expect(payload.content).toEqual({ text: '验收通过' })
  })

  it('密钥不会被写进消息正文', () => {
    const payload = buildPayload('验收通过', { timestamp: 1700000000, secret: 'test-secret' })
    expect(JSON.stringify(payload)).not.toContain('test-secret')
  })
})

describe('buildMessage', () => {
  it('拼出标题、正文与链接', () => {
    expect(buildMessage('上游有新版本', '报告正文', 'https://example.com/run')).toBe(
      '【上游有新版本】\n\n报告正文\n\n完整报告：https://example.com/run',
    )
  })

  it('标题与链接为空时只保留正文', () => {
    expect(buildMessage('', '报告正文')).toBe('报告正文')
  })
})

describe('truncateBody', () => {
  it('未超限时原样返回', () => {
    expect(truncateBody('短报告', 10)).toBe('短报告')
  })

  it('超限时截断并标注', () => {
    const body = '行'.repeat(2500)
    const result = truncateBody(body)
    expect(result).toContain('报告过长，已截断')
    expect(result.length).toBeLessThanOrEqual(2030)
    expect(result.startsWith('行'.repeat(2000))).toBe(true)
  })

  it('按自定义上限截断', () => {
    expect(truncateBody('abcdef', 3)).toContain('abc…')
  })
})

describe('parseArgs', () => {
  it('无参数时全部取默认值', () => {
    expect(parseArgs([])).toEqual({ file: '', text: '', title: '', link: '', help: false })
  })

  it('解析 file / title / link', () => {
    expect(parseArgs(['--file', 'report.txt', '--title', '上游有新版本', '--link', 'https://example.com'])).toEqual({
      file: 'report.txt',
      text: '',
      title: '上游有新版本',
      link: 'https://example.com',
      help: false,
    })
  })

  it('拒绝未知参数', () => {
    expect(parseArgs(['--unknown']).error).toBe('未知参数：--unknown')
  })

  it('拒绝缺少值的参数', () => {
    expect(parseArgs(['--file']).error).toBe('--file 缺少值')
  })

  it('拒绝同时指定 file 与 text', () => {
    expect(parseArgs(['--file', 'a.txt', '--text', '内容']).error).toBe('--file 与 --text 只能二选一')
  })
})

describe('resolveWebhook', () => {
  it('接受飞书官方地址', () => {
    const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/9eb1b7b0-8e81-47ca-9f78-7b1fcf24f04e'
    expect(resolveWebhook({ FEISHU_WEBHOOK: webhook })).toBe(webhook)
  })

  it('缺少变量时抛出明确错误', () => {
    expect(() => resolveWebhook({})).toThrow('缺少 FEISHU_WEBHOOK')
  })

  it('拒绝非官方域名与非 https 地址', () => {
    expect(() => resolveWebhook({ FEISHU_WEBHOOK: 'https://example.com/hook/abc' })).toThrow('不合法')
    expect(() => resolveWebhook({ FEISHU_WEBHOOK: 'http://open.feishu.cn/open-apis/bot/v2/hook/abc' })).toThrow(
      '不合法',
    )
  })
})

describe('postToFeishu', () => {
  const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/9eb1b7b0-8e81-47ca-9f78-7b1fcf24f04e'
  const payload = { msg_type: 'text', content: { text: '验收通过' } }

  it('首次成功即返回，不重试', async () => {
    const { fetchImpl, calls } = fakeFetch([{ data: { code: 0 } }])
    const sleep = vi.fn(async () => {})

    const data = await postToFeishu({ webhook, payload, fetchImpl, sleep })
    expect(data.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('飞书返回非 0 code 时重试，最终报错', async () => {
    const { fetchImpl, calls } = fakeFetch([{ data: { code: 19021, msg: 'sign match fail' } }])
    const sleep = vi.fn(async () => {})

    await expect(postToFeishu({ webhook, payload, fetchImpl, sleep })).rejects.toThrow('19021')
    expect(calls).toHaveLength(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('网络错误后重试成功', async () => {
    const { fetchImpl, calls } = fakeFetch([new Error('ECONNRESET'), { data: { code: 0 } }])
    const sleep = vi.fn(async () => {})

    await postToFeishu({ webhook, payload, fetchImpl, sleep })
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('HTTP 非 2xx 也视为失败', async () => {
    const { fetchImpl, calls } = fakeFetch([{ ok: false, status: 500 }])
    const sleep = vi.fn(async () => {})

    await expect(postToFeishu({ webhook, payload, fetchImpl, sleep })).rejects.toThrow('HTTP 500')
    expect(calls).toHaveLength(3)
  })

  it('全部失败时报错包含重试次数', async () => {
    const { fetchImpl } = fakeFetch([new Error('timeout')])
    const sleep = vi.fn(async () => {})

    await expect(postToFeishu({ webhook, payload, fetchImpl, sleep })).rejects.toThrow('已重试 3 次')
  })
})
