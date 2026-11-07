/**
 * G8 暂停 / 恢复项目总管（单测部分）：暂停记在项目自己的库里（meta paused）；暂停时成员一轮没回报不提醒总管；
 * 总管守则写明已暂停、用户找你照常干活；总管有 master_pause（只能暂停，恢复由用户在看板点）；看板动作认 pause / resume。
 * 定时保底删掉 / 重建、巡检不发、保底消息被拒、看板按钮、重启后仍暂停在 e2e/g8-pause.e2e.test.ts。
 */
import { describe, it, expect } from 'vitest'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { rolePrompt } from '../src/prompts.ts'
import { validateAction } from '../src/panel-api.ts'
import { pausedInfo, setPaused } from '../src/pause.ts'
import { tmpStore, tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

function setup(pause?: (caller: string, reason: string) => unknown) {
  const store = tmpStore('g8'); const dport = new FakeDeliveryPort(); const sport = new FakeSessionPort(); const clock = fakeClock()
  const timers: Array<{ fn: () => void; at: number }> = []
  const core = new Core(store, new Delivery(store, dport, clock), sport, clock, {
    idleGraceMs: 2000, timer: (fn, ms) => { const t = { fn, at: clock() + ms }; timers.push(t); return () => { timers.splice(timers.indexOf(t), 1) } }, ...(pause ? { pause } : {}),
  })
  const runTimers = async () => { const due = timers.filter(t => t.at <= clock()); for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn() } await new Promise(r => setTimeout(r, 5)) }
  return { store, dport, sport, clock, core, runTimers }
}
const tool = (core: Core, caller: string, name: string) => {
  const t = core.toolsFor(caller).find(x => x.name === name)
  if (!t) throw new Error(`${caller} 没有工具 ${name}`)
  return (args: unknown) => t.run(args, caller)
}

describe('G8 暂停状态', () => {
  it('setPaused / pausedInfo：记在库的 meta 里，清掉就恢复', () => {
    const s = setup()
    expect(pausedInfo(s.store)).toBeUndefined()
    setPaused(s.store, { at: '2026-11-07T14:20:00+08:00', by: 'user', reason: '先停一下' })
    expect(pausedInfo(s.store)).toEqual({ at: '2026-11-07T14:20:00+08:00', by: 'user', reason: '先停一下' })
    setPaused(s.store, undefined)
    expect(pausedInfo(s.store)).toBeUndefined()
  })
  it('暂停时成员一轮结束没回报：不提醒总管；恢复后照常提醒', async () => {
    const s = setup(); await s.core.ensureMaster(tmpdir('mcwd'))
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await tool(s.core, MASTER_ID, 'master_dispatch')({ task: 'L1107-1', kind: 'light', title: 't', to: 'a', text: 'x' })
    const idle = () => s.store.events({ type: 'message/queued' }).filter(e => JSON.parse(e.data).key?.startsWith('idle:'))
    setPaused(s.store, { at: 'x', by: 'user' })
    s.core.onStatus('exec-a', 'running'); s.clock.advance(1000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(3000); await s.runTimers()
    expect(idle()).toEqual([])
    setPaused(s.store, undefined)
    s.core.onStatus('exec-a', 'running'); s.clock.advance(1000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(3000); await s.runTimers()
    expect(idle()).toHaveLength(1)
  })
})

describe('G8 总管守则与工具', () => {
  it('暂停时守则写明已暂停、用户找你照常干活、恢复要用户在看板点；没暂停时没有这段', () => {
    const p = rolePrompt('master', 'm1', '/h.md', 'm1', { root: '/r', paused: { at: '2026-11-07 14:20', by: 'user', reason: '先停一下' } })
    expect(p).toContain('## 这个项目已暂停')
    expect(p).toContain('2026-11-07 14:20')
    expect(p).toContain('用户直接找你时照常干活')
    expect(p).toContain('看板上点「恢复」')
    expect(rolePrompt('master', 'm1', '/h.md', 'm1', { root: '/r' })).not.toContain('这个项目已暂停')
  })
  it('总管有 master_pause（带 reason），成员没有；调用交给入口的暂停函数', async () => {
    const calls: Array<[string, string]> = []
    const s = setup((caller, reason) => { calls.push([caller, reason]); return { paused: true } })
    await s.core.ensureMaster(tmpdir('mcwd'))
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    expect(s.core.toolsFor(MASTER_ID).map(t => t.name)).toContain('master_pause')
    expect(s.core.toolsFor('exec-a').map(t => t.name)).not.toContain('master_pause')
    expect(s.core.toolsFor(MASTER_ID).map(t => t.name)).not.toContain('master_resume')
    expect(await tool(s.core, MASTER_ID, 'master_pause')({ reason: '用户说先停' })).toEqual({ paused: true })
    expect(calls).toEqual([[MASTER_ID, '用户说先停']])
    await expect(tool(s.core, MASTER_ID, 'master_pause')({})).rejects.toThrow(/reason/)
  })
  it('没配暂停函数（旧单元）就没有 master_pause', async () => {
    const s = setup(); await s.core.ensureMaster(tmpdir('mcwd'))
    expect(s.core.toolsFor(MASTER_ID).map(t => t.name)).not.toContain('master_pause')
  })
})

describe('G8 看板动作', () => {
  it('pause（可带 reason）/ resume', () => {
    expect(validateAction({ action: 'pause' })).toEqual({ action: 'pause' })
    expect(validateAction({ action: 'pause', reason: '先停' })).toEqual({ action: 'pause', reason: '先停' })
    expect(validateAction({ action: 'resume' })).toEqual({ action: 'resume' })
    expect(validateAction({ action: 'pause', reason: 'x'.repeat(501) })).toEqual({ error: 'reason 太长' })
  })
})
