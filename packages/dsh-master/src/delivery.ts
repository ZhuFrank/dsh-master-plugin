/**
 * 跨会话投递：先落库（messages 只追加 + deliveries 待投），再由 pump() 投给 DSH Agent。
 * - 业务键去重：同一个 key 只会有一条 message、一次投递。
 * - 限频：同一对会话每分钟最多 N 条；单条正文（含抬头）不超过 maxBytes。
 * - 持久重试：投递失败按指数退避重试，连败 maxAttempts 次标 error；DSH 重启后从库里接着投。
 * - 崩溃窗口：DSH 侧已收到但库里还没标 delivered 时，重试由 port 按消息 ID 查历史，不会重复插入。
 */
import type { Store, DeliveryMode, DeliveryRow } from './store.ts'
import { bjtIso, bjtStamp, type Clock } from './time.ts'

export const SOURCE_KIND = 'dsh-master'

export interface DeliverInput { to: string; messageId: string; text: string; mode: DeliveryMode; summary: string }
/** DSH 那一侧：成功返回 'delivered'；目标里已经有这条消息返回 'already'；失败抛错。 */
export interface DeliveryPort { deliver(input: DeliverInput): Promise<'delivered' | 'already'> }

export interface DeliveryOptions { ratePerMinute: number; maxBytes: number; maxAttempts: number; backoffMs: number }
export const DEFAULT_DELIVERY_OPTIONS: DeliveryOptions = { ratePerMinute: 6, maxBytes: 16 * 1024, maxAttempts: 3, backoffMs: 2000 }

export class DeliveryError extends Error {
  constructor(readonly code: 'too_large' | 'rate_limited' | 'empty', message: string) { super(message) }
}

export interface EnqueueInput { key: string; from: string; to: string; task?: string | null; mode: DeliveryMode; text: string; summary?: string; label?: string }
export type EnqueueResult = { status: 'queued'; key: string } | { status: 'duplicate'; key: string }

export const messageIdOf = (key: string) => `${SOURCE_KIND}:${key}`

/** 模型看不到 message.source，所以「谁发的」必须写进正文第一行。 */
export function headerOf(input: { from: string; to: string; task?: string | null; label?: string; key: string }, ms: number): string {
  const parts = [`dsh-master 消息`, `来自 ${input.from}`, `发给 ${input.to}`]
  if (input.task) parts.push(input.task)
  if (input.label) parts.push(input.label)
  parts.push(bjtStamp(ms))
  return `[${parts.join(' · ')}]（消息键 ${input.key}）`
}

export class Delivery {
  private pumping: Promise<void> | undefined
  private again = false
  readonly opts: DeliveryOptions
  constructor(private readonly store: Store, private readonly port: DeliveryPort, private readonly clock: Clock, opts: Partial<DeliveryOptions> = {}) {
    this.opts = { ...DEFAULT_DELIVERY_OPTIONS, ...opts }
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    if (!input.text.trim()) throw new DeliveryError('empty', '消息正文为空')
    const now = this.clock()
    const full = `${headerOf(input, now)}\n${input.text}`
    const bytes = Buffer.byteLength(full, 'utf8')
    if (bytes > this.opts.maxBytes) throw new DeliveryError('too_large', `消息 ${bytes} 字节，超过上限 ${this.opts.maxBytes}；长内容写进文件，消息里只放路径`)
    return this.store.tx(() => {
      if (this.store.getMessage(input.key)) return { status: 'duplicate' as const, key: input.key }
      const recent = this.store.countMessages(input.from, input.to, now - 60_000)
      if (recent >= this.opts.ratePerMinute) {
        throw new DeliveryError('rate_limited', `${input.from} → ${input.to} 一分钟内已发 ${recent} 条，达到上限 ${this.opts.ratePerMinute}；稍后再发或合并成一条`)
      }
      const at = bjtIso(now)
      this.store.insertMessage({ at, at_ms: now, key: input.key, from_id: input.from, to_id: input.to, task: input.task ?? null, mode: input.mode, text: full })
      this.store.insertDelivery({ key: input.key, to_id: input.to, from_id: input.from, mode: input.mode, text: full, summary: input.summary ?? firstLine(input.text),
        state: 'pending', attempts: 0, next_at_ms: now, last_error: null, created_at: at, updated_at: at })
      this.store.addEvent({ at, task: input.task ?? null, session: input.to, type: 'message/queued', data: { key: input.key, from: input.from, to: input.to, mode: input.mode } })
      return { status: 'queued' as const, key: input.key }
    })
  }

  /** 投递所有到期的待投消息；重入时合并成再跑一遍。 */
  pump(): Promise<void> {
    if (this.pumping) { this.again = true; return this.pumping }
    this.pumping = (async () => {
      try {
        do { this.again = false; await this.pumpOnce() } while (this.again)
      } finally { this.pumping = undefined }
    })()
    return this.pumping
  }

  private async pumpOnce(): Promise<void> {
    for (const d of this.store.dueDeliveries(this.clock())) await this.attempt(d)
  }

  private async attempt(d: DeliveryRow): Promise<void> {
    const attempts = d.attempts + 1
    try {
      const result = await this.port.deliver({ to: d.to_id, messageId: messageIdOf(d.key), text: d.text, mode: d.mode, summary: d.summary })
      const now = this.clock(); const at = bjtIso(now)
      this.store.tx(() => {
        this.store.markDelivery(d.key, { state: 'delivered', attempts, next_at_ms: now, last_error: null }, at)
        this.store.addEvent({ at, session: d.to_id, type: 'message/delivered', data: { key: d.key, attempts, already: result === 'already' } })
      })
    } catch (error) {
      const now = this.clock(); const at = bjtIso(now)
      const message = error instanceof Error ? error.message : String(error)
      const failed = attempts >= this.opts.maxAttempts
      this.store.tx(() => {
        this.store.markDelivery(d.key, { state: failed ? 'error' : 'pending', attempts, next_at_ms: now + this.opts.backoffMs * 2 ** (attempts - 1), last_error: message }, at)
        this.store.addEvent({ at, session: d.to_id, type: failed ? 'message/error' : 'message/retry', data: { key: d.key, attempts, error: message } })
      })
    }
  }
}

function firstLine(text: string): string {
  return (text.split('\n').find(l => l.trim()) ?? '').slice(0, 80)
}
