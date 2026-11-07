import { describe, it, expect } from 'vitest'
import { Store } from '../src/store.ts'
import { Delivery, DeliveryError, messageIdOf } from '../src/delivery.ts'
import { tmpStore, fakeClock, FakeDeliveryPort } from './helpers.ts'

const base = { from: 'master', to: 'exec-a', mode: 'followup' as const }

describe('Delivery', () => {
  it('入队即落库，pump 后投出，正文第一行是抬头（含来自谁、消息键、北京时间）', async () => {
    const s = tmpStore(); const port = new FakeDeliveryPort(); const clock = fakeClock()
    const d = new Delivery(s, port, clock)
    expect(d.enqueue({ ...base, key: 'k1', task: 'T001', text: '派活：做 X' })).toEqual({ status: 'queued', key: 'k1' })
    expect(s.getDelivery('k1')?.state).toBe('pending')
    await d.pump()
    expect(s.getDelivery('k1')?.state).toBe('delivered')
    expect(port.calls).toHaveLength(1)
    expect(port.calls[0]!.messageId).toBe(messageIdOf('k1'))
    expect(port.calls[0]!.text.split('\n')[0]).toBe('[dsh-master 消息 · 来自 master · 发给 exec-a · T001 · 2026-11-03 0700]（消息键 k1）')
  })

  it('去重：同一业务键第二次入队返回 duplicate，只有一条消息、只投一次', async () => {
    const s = tmpStore(); const port = new FakeDeliveryPort(); const d = new Delivery(s, port, fakeClock())
    d.enqueue({ ...base, key: 'dup', text: 'a' })
    expect(d.enqueue({ ...base, key: 'dup', text: 'a（重复）' })).toEqual({ status: 'duplicate', key: 'dup' })
    await d.pump(); await d.pump()
    expect(s.recentMessages()).toHaveLength(1)
    expect(port.calls).toHaveLength(1)
  })

  it('限频：同一对会话一分钟内第 7 条被拒，过一分钟恢复；别的会话对不受影响', () => {
    const s = tmpStore(); const clock = fakeClock(); const d = new Delivery(s, new FakeDeliveryPort(), clock)
    for (let i = 0; i < 6; i++) { d.enqueue({ ...base, key: `r${i}`, text: `m${i}` }); clock.advance(1000) }
    expect(() => d.enqueue({ ...base, key: 'r6', text: 'm6' })).toThrow(DeliveryError)
    expect(() => d.enqueue({ ...base, key: 'r6', text: 'm6' })).toThrow(/上限 6/)
    d.enqueue({ ...base, to: 'exec-b', key: 'other', text: 'x' })
    clock.advance(60_000)
    expect(d.enqueue({ ...base, key: 'r6', text: 'm6' }).status).toBe('queued')
  })

  it('单条超过 16KB（含抬头）被拒，且不落库', () => {
    const s = tmpStore(); const d = new Delivery(s, new FakeDeliveryPort(), fakeClock())
    expect(() => d.enqueue({ ...base, key: 'big', text: '汉'.repeat(6000) })).toThrow(/超过上限 16384/)
    expect(s.getMessage('big')).toBeUndefined()
    expect(d.enqueue({ ...base, key: 'ok', text: '汉'.repeat(5000) }).status).toBe('queued')
  })

  it('失败按指数退避重试，连败 3 次标 error', async () => {
    const s = tmpStore(); const port = new FakeDeliveryPort(); port.failNext = 99
    const clock = fakeClock(); const d = new Delivery(s, port, clock, { backoffMs: 1000 })
    d.enqueue({ ...base, key: 'f', text: 'x' })
    await d.pump()
    expect(s.getDelivery('f')).toMatchObject({ state: 'pending', attempts: 1 })
    await d.pump(); expect(port.calls).toHaveLength(1) // 还没到下次时间
    clock.advance(1000); await d.pump()
    expect(s.getDelivery('f')).toMatchObject({ state: 'pending', attempts: 2 })
    clock.advance(1999); await d.pump(); expect(port.calls).toHaveLength(2)
    clock.advance(1); await d.pump()
    expect(s.getDelivery('f')).toMatchObject({ state: 'error', attempts: 3, last_error: 'boom' })
    expect(s.events({ type: 'message/error' })).toHaveLength(1)
  })

  it('重启后重试：失败留在库里的待投消息，新进程（新 Store + 新 Delivery）接着投出', async () => {
    const s1 = tmpStore(); const port1 = new FakeDeliveryPort(); port1.failNext = 1
    const clock = fakeClock()
    new Delivery(s1, port1, clock, { backoffMs: 1000 }).enqueue({ ...base, key: 'persist', text: 'x' })
    await new Delivery(s1, port1, clock, { backoffMs: 1000 }).pump()
    expect(s1.getDelivery('persist')?.state).toBe('pending')
    s1.close()
    const s2 = new Store(s1.file); const port2 = new FakeDeliveryPort()
    clock.advance(1000)
    await new Delivery(s2, port2, clock, { backoffMs: 1000 }).pump()
    expect(s2.getDelivery('persist')?.state).toBe('delivered')
    expect(port2.received('exec-a')).toEqual([messageIdOf('persist')])
  })

  it('崩溃窗口：DSH 已收到但库里没标 delivered，重投时 port 报 already，不重复插入', async () => {
    const s = tmpStore(); const port = new FakeDeliveryPort(); const d = new Delivery(s, port, fakeClock())
    d.enqueue({ ...base, key: 'w', text: 'x' })
    port.history.set('exec-a', [messageIdOf('w')]) // 模拟上次投出后进程崩了
    await d.pump()
    expect(s.getDelivery('w')?.state).toBe('delivered')
    expect(port.received('exec-a')).toEqual([messageIdOf('w')])
    expect(JSON.parse(s.events({ type: 'message/delivered' })[0]!.data).already).toBe(true)
  })

  it('同一目标的多条待投按入队顺序投', async () => {
    const s = tmpStore(); const port = new FakeDeliveryPort(); const clock = fakeClock(); const d = new Delivery(s, port, clock)
    for (const k of ['a', 'b', 'c']) { d.enqueue({ ...base, key: k, text: k }); clock.advance(1000) }
    await d.pump()
    expect(port.calls.map(c => c.messageId)).toEqual(['a', 'b', 'c'].map(messageIdOf))
  })

  it('同一毫秒入队的按入队顺序投，不按消息键字母序（回归：「就绪」曾排到「进展」前面）', async () => {
    const s = tmpStore(); const port = new FakeDeliveryPort(); const d = new Delivery(s, port, fakeClock())
    for (const k of ['z', 'a', 'm']) d.enqueue({ ...base, key: k, text: k })
    await d.pump()
    expect(port.calls.map(c => c.messageId)).toEqual(['z', 'a', 'm'].map(messageIdOf))
  })
})
