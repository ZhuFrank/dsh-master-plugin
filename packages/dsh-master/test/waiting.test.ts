import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { Patrol } from '../src/patrol.ts'
import { WaitingTracker, track } from '../src/waiting.ts'
import { notifyItems, NotifyBatcher } from '../src/client/index.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

describe('G5-E ⑤ 等你点', () => {
  it('track：进来记一条、结束（不管成功失败）就删；结果原样返回，不替用户做决定', async () => {
    let now = 1000; const t = new WaitingTracker(() => now)
    let release!: (v: string) => void
    const p = track(t, 'exec-a', 'approval', 'bash', () => new Promise<string>(r => { release = r }))
    expect(t.list()).toMatchObject([{ session: 'exec-a', kind: 'approval', label: 'bash', since: 1000 }])
    release('rejected')
    expect(await p).toBe('rejected')
    expect(t.list()).toEqual([])
    const q = track(t, 'exec-b', 'question', '选哪个？', () => Promise.reject(new Error('cancelled')))
    await expect(q).rejects.toThrow('cancelled')
    expect(t.list()).toEqual([])
  })
  it('巡检：等了超过 10 分钟才报，只说「去那个会话里点」', async () => {
    const dir = tmpdir('wait'); const clock = fakeClock(); const store = new Store(path.join(dir, 'master.db'))
    const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 1000 })
    await core.ensureMaster(tmpdir('m'))
    const w = new WaitingTracker(clock)
    const patrol = new Patrol(store, core, undefined, clock, { stallMs: 3600_000, longRunMs: 3600_000, waiting: () => w.list() })
    w.start('exec-a', 'approval', 'bash')
    clock.advance(9 * 60_000); expect(patrol.findings().filter(f => f.key.startsWith('waiting:'))).toEqual([])
    clock.advance(2 * 60_000)
    const f = patrol.findings().filter(x => x.key.startsWith('waiting:'))
    expect(f).toHaveLength(1); expect(f[0]!.text).toMatch(/⏳ exec-a 等用户批准已经 11 分钟：bash（只能去那个会话里点）/)
    void MASTER_ID
  })
  it('浏览器通知条目里有等你点', () => {
    expect(notifyItems({ waiting: [{ session: 's', title: '执行 S', kind: 'question', label: '选哪个？', since: '2026-11-04 2300' }] }))
      .toEqual([{ key: 'wait:s:2026-11-04 2300', text: '⏳ 执行 S 等你回答：选哪个？', session: 's' }])
  })
  it('合批通知带上要跳的会话（等你点的才有）', () => {
    const b = new NotifyBatcher(0)
    b.feed([], 0)
    expect(b.feed([{ key: 'task:x', text: 'x 待验收' }], 1)).toEqual({ title: '总管看板', body: 'x 待验收' })
    expect(b.feed([{ key: 'task:y', text: 'y' }, { key: 'wait:s:1', text: '⏳ s', session: 's' }], 2)).toMatchObject({ session: 's' })
  })
})
