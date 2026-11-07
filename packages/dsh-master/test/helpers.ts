import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import type { DeliverInput, DeliveryPort } from '../src/delivery.ts'
import type { SessionPort, LiveStatus } from '../src/core.ts'

export function tmpdir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dshm-${name}-`))
}
export function tmpStore(name = 'store'): Store {
  return new Store(path.join(tmpdir(name), 'master.db'))
}
/** 可控时钟：2026-11-03 07:00 BJT 起。 */
export function fakeClock(start = Date.UTC(2026, 10, 2, 23, 0, 0)) {
  let now = start
  const clock = () => now
  return Object.assign(clock, { advance(ms: number) { now += ms }, set(ms: number) { now = ms } })
}
export class FakeDeliveryPort implements DeliveryPort {
  calls: DeliverInput[] = []
  /** 目标会话里已有的消息 ID（模拟 DSH 持久历史）。 */
  history = new Map<string, string[]>()
  failNext = 0
  async deliver(input: DeliverInput): Promise<'delivered' | 'already'> {
    this.calls.push(input)
    if (this.failNext > 0) { this.failNext--; throw new Error('boom') }
    const h = this.history.get(input.to) ?? []
    if (h.includes(input.messageId)) return 'already'
    h.push(input.messageId); this.history.set(input.to, h)
    return 'delivered'
  }
  received(to: string): string[] { return this.history.get(to) ?? [] }
}
export class FakeSessionPort implements SessionPort {
  ensured: string[] = []
  live = new Map<string, LiveStatus>()
  lastText = new Map<string, string>()
  async ensureSession(input: { id: string }): Promise<void> { this.ensured.push(input.id); if (!this.live.has(input.id)) this.live.set(input.id, 'idle') }
  status(id: string): LiveStatus { return this.live.get(id) ?? 'cold' }
  async lastAssistantText(id: string) { return this.lastText.get(id) }
}
