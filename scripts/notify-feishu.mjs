/**
 * 飞书群机器人通知：把上游同步体检报告发到群里。
 *
 * 只负责「组装消息 + 发送」，报告由 sync-upstream.mjs 产出后写入文件。
 * Webhook 与签名密钥只从环境变量读取，不写进仓库；签名密钥可留空，
 * 使用「关键词」或「免校验」的机器人无需签名。
 *
 * 用法：
 *   node scripts/notify-feishu.mjs --file report.txt --title "上游有新版本" --link <运行地址>
 *   node scripts/notify-feishu.mjs --text "测试消息"
 */

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** 正文上限：飞书文本消息体有大小限制，手机端过长也不便阅读。 */
const MAX_BODY_CHARS = 2000

/** 默认重试次数与基础间隔（毫秒）。 */
const DEFAULT_RETRIES = 3
const RETRY_DELAY_MS = 2000

/** 只接受飞书官方 webhook 地址，避免把消息发到未知域名。 */
const WEBHOOK_PATTERN = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[0-9a-z-]+$/u

/** 帮助文本。 */
const HELP = `飞书通知（只发消息，不改仓库）

用法：
  node scripts/notify-feishu.mjs --file report.txt --title "上游有新版本"
  node scripts/notify-feishu.mjs --text "测试消息"

参数：
  --file <path>   报告文件路径，读取全文作为正文
  --text <text>   直接指定正文，与 --file 二选一
  --title <text>  消息标题，会显示为【标题】
  --link <url>    附加在正文末尾的完整报告链接
  -h, --help      显示本说明

环境变量：
  FEISHU_WEBHOOK  必填，飞书群机器人 webhook 地址
  FEISHU_SECRET   选填，机器人启用签名校验时填写`

/**
 * 解析命令行参数。
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @returns {{ file: string, text: string, title: string, link: string, help: boolean, error?: string }}
 */
export function parseArgs(argv) {
  const result = { file: '', text: '', title: '', link: '', help: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      result.help = true
      continue
    }
    if (arg === '--file' || arg === '--text' || arg === '--title' || arg === '--link') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ...result, error: `${arg} 缺少值` }
      }
      if (arg === '--file') result.file = value
      else if (arg === '--text') result.text = value
      else if (arg === '--title') result.title = value
      else result.link = value
      index += 1
      continue
    }
    return { ...result, error: `未知参数：${arg}` }
  }

  if (result.file !== '' && result.text !== '') {
    return { ...result, error: '--file 与 --text 只能二选一' }
  }

  return result
}

/**
 * 计算飞书签名：以「时间戳 + 换行 + 密钥」为密钥，对空串做 HMAC-SHA256。
 * @param {number|string} timestamp 秒级时间戳
 * @param {string} secret 机器人签名密钥
 * @returns {string} Base64 编码的签名
 */
export function signFeishu(timestamp, secret) {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

/**
 * 组装消息正文：标题 + 正文 + 完整报告链接。
 * @param {string} title 标题，空串表示不加标题
 * @param {string} body 正文
 * @param {string} link 完整报告链接，空串表示不加
 * @returns {string} 最终正文
 */
export function buildMessage(title, body, link = '') {
  const head = title === '' ? '' : `【${title}】\n\n`
  const tail = link === '' ? '' : `\n\n完整报告：${link}`
  return `${head}${body}${tail}`
}

/**
 * 截断过长的正文，保留开头并标注已截断。
 * @param {string} body 原始正文
 * @param {number} maxChars 最大字符数
 * @returns {string} 截断后的正文
 */
export function truncateBody(body, maxChars = MAX_BODY_CHARS) {
  if (body.length <= maxChars) return body
  return `${body.slice(0, maxChars)}…\n（报告过长，已截断）`
}

/**
 * 组装飞书文本消息体；有密钥时附带时间戳与签名。
 * @param {string} text 消息正文
 * @param {{ timestamp?: number, secret?: string }} options 可选的时间戳与签名密钥
 * @returns {Record<string, unknown>} 可直接序列化的消息体
 */
export function buildPayload(text, options = {}) {
  const { timestamp = 0, secret = '' } = options
  const payload = { msg_type: 'text', content: { text } }

  if (secret !== '') {
    payload.timestamp = String(timestamp)
    payload.sign = signFeishu(timestamp, secret)
  }

  return payload
}

/**
 * 从环境变量读取并校验 webhook。
 * @param {Record<string, string | undefined>} env 环境变量
 * @returns {string} 合法的 webhook 地址
 */
export function resolveWebhook(env) {
  const webhook = (env.FEISHU_WEBHOOK ?? '').trim()
  if (webhook === '') throw new Error('缺少 FEISHU_WEBHOOK：请把飞书机器人地址存进仓库 Secret')
  if (!WEBHOOK_PATTERN.test(webhook)) throw new Error('FEISHU_WEBHOOK 不合法：只接受飞书官方 webhook 地址')
  return webhook
}

/**
 * 默认延时，供重试使用。
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 延时完成
 */
function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 发送消息，失败按次数重试；飞书返回非 0 code 也视为失败。
 * @param {{ webhook: string, payload: object, fetchImpl?: Function, retries?: number, sleep?: Function }} options 发送参数
 * @returns {Promise<object>} 飞书返回的响应体
 */
export async function postToFeishu(options) {
  const {
    webhook,
    payload,
    fetchImpl = globalThis.fetch,
    retries = DEFAULT_RETRIES,
    sleep = defaultSleep,
  } = options
  let lastError = null

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const data = await response.json()
      if (data.code !== 0) throw new Error(`飞书返回错误：${data.code} ${data.msg ?? ''}`)
      return data
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(RETRY_DELAY_MS * attempt)
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`飞书通知发送失败（已重试 ${retries} 次）：${reason}`)
}

/** 主流程：读参数与环境变量、组装消息、发送。 */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.error !== undefined) {
    console.error(`[notify-feishu] ${args.error}`)
    process.exitCode = 2
    return
  }
  if (args.help) {
    console.log(HELP)
    return
  }

  let body = args.text
  if (args.file !== '') {
    try {
      body = readFileSync(args.file, 'utf8').trim()
    } catch (error) {
      console.error(`[notify-feishu] 读取报告失败：${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 2
      return
    }
  }
  if (body === '') {
    console.error('[notify-feishu] 正文为空：请用 --file 或 --text 指定内容')
    process.exitCode = 2
    return
  }

  let webhook = ''
  try {
    webhook = resolveWebhook(process.env)
  } catch (error) {
    console.error(`[notify-feishu] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }

  const secret = (process.env.FEISHU_SECRET ?? '').trim()
  const payload = buildPayload(buildMessage(args.title, truncateBody(body), args.link), {
    timestamp: Math.floor(Date.now() / 1000),
    secret,
  })

  try {
    await postToFeishu({ webhook, payload })
    console.log('[notify-feishu] 已发送')
  } catch (error) {
    console.error(`[notify-feishu] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

// 仅在被直接执行时跑主流程，供测试导入纯函数。
if (process.argv[1] !== undefined && /notify-feishu\.mjs$/u.test(process.argv[1])) await main()
