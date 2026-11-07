import fs from 'node:fs'
import { describe, it, expect, beforeEach } from 'vitest'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery, messageIdOf } from '../src/delivery.ts'
import type { Store } from '../src/store.ts'
import { tmpStore, tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

function setup() {
  const store = tmpStore('core'); const dport = new FakeDeliveryPort(); const sport = new FakeSessionPort(); const clock = fakeClock()
  const timers: Array<{ fn: () => void; at: number }> = []
  const core = new Core(store, new Delivery(store, dport, clock), sport, clock, {
    idleGraceMs: 2000, timer: (fn, ms) => { const t = { fn, at: clock() + ms }; timers.push(t); return () => { timers.splice(timers.indexOf(t), 1) } },
  })
  const runTimers = async () => { const due = timers.filter(t => t.at <= clock()); for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn() } await new Promise(r => setTimeout(r, 5)) }
  return { store, dport, sport, clock, core, timers, runTimers }
}
const tool = (core: Core, caller: string, name: string) => {
  const t = core.toolsFor(caller).find(x => x.name === name)
  if (!t) throw new Error(`${caller} 没有工具 ${name}`)
  return (args: unknown) => t.run(args, caller)
}
const flush = () => new Promise(r => setImmediate(r))
const heavy = { task: 'T005', kind: 'heavy', title: '插件', to: 'a', gate: 'G1', text: '做 spike', expected: '4 小时', output: '/tmp/out', resume: '读 docs' }

describe('Core · 角色', () => {
  let s: ReturnType<typeof setup>
  beforeEach(async () => { s = setup(); await s.core.ensureMaster(tmpdir('mcwd')) })

  it('不在花名册的会话一个 dsh-master 工具都没有', () => {
    expect(s.core.toolsFor('session-random')).toEqual([])
  })
  it('总管有 10 个总管工具、没有 master_report；执行会话只有 master_report（无记忆层时）', async () => {
    expect(s.core.toolsFor(MASTER_ID).map(t => t.name).sort()).toEqual(['master_ask_user', 'master_close', 'master_dispatch', 'master_link', 'master_patrol', 'master_review', 'master_send', 'master_sessions', 'master_spawn', 'task_spec_write'])
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    expect(s.core.toolsFor('exec-a').map(t => t.name)).toEqual(['master_report'])
  })
  it('关闭后的执行会话没有工具、不能再派活', async () => {
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await tool(s.core, MASTER_ID, 'master_close')({ name: 'a' })
    expect(s.core.toolsFor('exec-a')).toEqual([])
    await expect(tool(s.core, MASTER_ID, 'master_dispatch')({ ...heavy })).rejects.toThrow(/已关闭/)
  })
  it('执行会话只能回报派给自己的任务', async () => {
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'b', cwd: tmpdir('b'), title: 'B' })
    await tool(s.core, MASTER_ID, 'master_dispatch')({ ...heavy })
    await expect(tool(s.core, 'exec-b', 'master_report')({ task: 'T005', state: '就绪', action: 'x' })).rejects.toThrow(/不是派给你/)
  })
})

describe('Core · 派活 / 回报 / 验收', () => {
  let s: ReturnType<typeof setup>
  beforeEach(async () => {
    s = setup(); await s.core.ensureMaster(tmpdir('mcwd'))
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
  })

  it('spawn：cwd 必须是存在的绝对目录；名字格式受限；重复 spawn 幂等', async () => {
    const spawn = tool(s.core, MASTER_ID, 'master_spawn')
    await expect(spawn({ name: 'x', cwd: 'relative', title: 'X' })).rejects.toThrow(/绝对路径/)
    await expect(spawn({ name: 'Bad_Name', cwd: tmpdir('x'), title: 'X' })).rejects.toThrow(/格式不对/)
    expect(await spawn({ name: 'a', cwd: tmpdir('a2'), title: 'A' })).toMatchObject({ id: 'exec-a', existed: true })
  })
  it('重任务缺闸门 / 预计耗时 / 产物目录 / 续跑方式 → 拒；编号与类型不符 → 拒', async () => {
    const dispatch = tool(s.core, MASTER_ID, 'master_dispatch')
    for (const k of ['gate', 'expected', 'output', 'resume']) {
      const a: any = { ...heavy }; delete a[k]
      await expect(dispatch(a), k).rejects.toThrow()
    }
    await expect(dispatch({ ...heavy, kind: 'light' })).rejects.toThrow(/T 编号/)
    expect(s.store.getTask('T005')).toBeUndefined()
  })
  it('同样的派活调用两次只投一次（业务键去重）', async () => {
    const dispatch = tool(s.core, MASTER_ID, 'master_dispatch')
    expect(await dispatch({ ...heavy })).toMatchObject({ status: 'queued' })
    expect(await dispatch({ ...heavy })).toMatchObject({ status: 'duplicate' })
    await flush(); await flush()
    expect(s.dport.received('exec-a')).toHaveLength(1)
    expect(s.store.events({ type: 'task/dispatched' })).toHaveLength(1)
  })
  it('回报：状态值受限；状态行时间由插件按北京时间填；就绪 followup 唤醒总管，进展 inject 不打断', async () => {
    await tool(s.core, MASTER_ID, 'master_dispatch')({ ...heavy })
    const report = tool(s.core, 'exec-a', 'master_report')
    await expect(report({ task: 'T005', state: '搞定了', action: 'x' })).rejects.toThrow(/state 只能是/)
    s.clock.advance(13 * 60_000)
    const r1: any = await report({ task: 'T005', state: '进展', action: '在写代码' })
    expect(r1.line).toBe('[T005] 状态=进展 ｜时间：2026-11-03 0713 ｜当前动作：在写代码')
    const r2: any = await report({ task: 'T005', state: '就绪', action: 'G1 写完', ask: '用 A 还是 B？', body: '产物 /tmp/out' })
    expect(r2.line).toBe('[T005] 状态=就绪 ｜时间：2026-11-03 0713 ｜当前动作：G1 写完 ｜要你定：用 A 还是 B？')
    await flush()
    const modes = s.dport.calls.filter(c => c.to === MASTER_ID).map(c => c.mode)
    expect(modes).toEqual(['inject', 'followup'])
    expect(s.store.getTask('T005')?.state).toBe('待验收')
  })
  it('验收：打回 → 任务「打回」并把意见发给执行会话；通过且 final → 完成', async () => {
    await tool(s.core, MASTER_ID, 'master_dispatch')({ ...heavy })
    const review = tool(s.core, MASTER_ID, 'master_review')
    await review({ task: 'T005', verdict: '打回', gate: 'G1', notes: '1. 截图缺手机宽' })
    expect(s.store.getTask('T005')?.state).toBe('打回')
    await review({ task: 'T005', verdict: '通过', gate: 'G1', notes: '好', final: true })
    expect(s.store.getTask('T005')?.state).toBe('完成')
    await flush()
    expect(s.dport.calls.filter(c => c.to === 'exec-a').map(c => c.text.split('\n')[1])).toEqual(['派活：T005（重任务 · 闸门 G1）插件', '验收：T005 闸门 G1 打回', '验收：T005 闸门 G1 通过（任务完成）'])
    await expect(tool(s.core, MASTER_ID, 'master_dispatch')({ ...heavy, text: '再做' })).rejects.toThrow(/已完成/)
  })
  it('ask_user 记一条待定事项', async () => {
    await tool(s.core, MASTER_ID, 'master_ask_user')({ task: 'T005', question: '用哪个 key？', options: ['A', 'B'] })
    expect(s.store.openAsks()).toMatchObject([{ task: 'T005', question: '用哪个 key？', options: '["A","B"]' }])
  })
})

describe('Core · 空闲没回报的兜底', () => {
  async function ready() {
    const s = setup(); await s.core.ensureMaster(tmpdir('mcwd'))
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await tool(s.core, MASTER_ID, 'master_dispatch')({ ...heavy })
    await flush()
    s.sport.lastText.set('exec-a', '我做完了第一步')
    return s
  }
  it('一轮结束没回报 → 宽限期后提醒总管（带最后一句话），只提醒一次', async () => {
    const s = await ready()
    s.core.onStatus('exec-a', 'running'); s.clock.advance(5000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(1999); await s.runTimers()
    expect(s.dport.calls.filter(c => c.to === MASTER_ID)).toHaveLength(0)
    s.clock.advance(1); await s.runTimers(); await flush()
    const toMaster = s.dport.calls.filter(c => c.to === MASTER_ID)
    expect(toMaster).toHaveLength(1)
    expect(toMaster[0]!.text).toMatch(/exec-a 一轮结束了，但没有用 master_report 回报[\s\S]*我做完了第一步/)
    s.core.onStatus('exec-a', 'idle'); s.clock.advance(5000); await s.runTimers(); await flush()
    expect(s.dport.calls.filter(c => c.to === MASTER_ID)).toHaveLength(1)
  })
  it('这一轮里回报过 → 不提醒', async () => {
    const s = await ready()
    s.core.onStatus('exec-a', 'running')
    await tool(s.core, 'exec-a', 'master_report')({ task: 'T005', state: '进展', action: 'x' })
    s.core.onStatus('exec-a', 'idle'); s.clock.advance(5000); await s.runTimers(); await flush()
    expect(s.dport.calls.filter(c => c.to === MASTER_ID).map(c => c.mode)).toEqual(['inject'])
  })
  it('没有在途任务 → 不提醒；不在花名册 → 不管', async () => {
    const s = await ready()
    await tool(s.core, MASTER_ID, 'master_review')({ task: 'T005', verdict: '通过', notes: 'ok', final: true })
    s.core.onStatus('exec-a', 'running'); s.core.onStatus('exec-a', 'idle')
    s.core.onStatus('session-x', 'running'); s.core.onStatus('session-x', 'idle')
    s.clock.advance(5000); await s.runTimers(); await flush()
    expect(s.dport.calls.filter(c => c.to === MASTER_ID)).toHaveLength(0)
  })
})
