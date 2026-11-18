/**
 * G14 ③（T005 待评估第 7、5 项 + 分析 #27）：
 * a 结案任务上的「等你定」答复不再直送成员，交给总管并叫醒（T018 11-17 21:29 又碰到）；
 * b 巡检报总管还没看过的迟到回报（结案任务上来的回报原来只 inject，不叫醒）；
 * c 状态栏：等你定最早一件挂超过 2 小时 ⇒ 标红（asksOverdue / asksOldestMin）；
 * d master_ask_close：在对话里答过的等你定由总管结案（第 5 项：原来永远不结案）。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { PanelService, type PanelPort, type TurnText } from '../src/panel-service.ts'
import { Attribution } from '../src/attrib.ts'
import { Patrol } from '../src/patrol.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

class FakePanelPort implements PanelPort {
  prompts: Array<{ sessionId: string; content: any[] }> = []
  async promptUser(sessionId: string, _r: string, content: any[]) { this.prompts.push({ sessionId, content }) }
  async turnText(_s: string, _t: number): Promise<TurnText | undefined> { return undefined }
}
const flush = () => new Promise(r => setImmediate(r))
async function ready() {
  const dir = tmpdir('g14-3'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const dport = new FakeDeliveryPort()
  const core = new Core(store, new Delivery(store, dport, clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, mem, timer: () => () => {} })
  const pport = new FakePanelPort()
  const panel = new PanelService(store, core, new Attribution(store, core, clock), pport, clock)
  const patrol = new Patrol(store, core, mem, clock, { stallMs: 10 * 3600_000, longRunMs: 10 * 3600_000 })
  await core.ensureMaster(tmpdir('m'))
  await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  await core.dispatch({ task: 'L1107-9', kind: 'light', title: '小活', to: 'a', text: '做' }, MASTER_ID)
  const tool = (caller: string, name: string) => { const t = core.toolsFor(caller).find(x => x.name === name); if (!t) throw new Error(`${caller} 没有 ${name}`); return (a: unknown) => t.run(a, caller) }
  await flush(); dport.calls.length = 0
  return { clock, store, dport, core, pport, panel, patrol, tool }
}

describe('G14 ③a 结案任务上的等你定答复交给总管', () => {
  it('任务已结案 ⇒ 答复 prompt 总管（叫醒），不直送成员；卡片 talkTo 也是总管', async () => {
    const s = await ready()
    const { id } = await s.core.askUser({ task: 'L1107-9', question: '清单用表格吗？', options: ['表格', '一行一个'] })
    await s.tool('exec-a', 'master_report')({ task: 'L1107-9', state: '完成', action: '做完了' })
    expect(s.store.getTask('L1107-9')!.state).toBe('完成')
    const r = await s.panel.act({ action: 'answer', ask: id, answer: '表格' }); await flush()
    expect(r).toMatchObject({ to: MASTER_ID })
    expect(s.pport.prompts.map(p => p.sessionId)).toEqual([MASTER_ID])
    expect(s.dport.calls.filter(c => c.to === 'exec-a')).toHaveLength(0)
    expect(s.panel.talkTo('L1107-9')).toBe(MASTER_ID)
  })
})

describe('G14 ③b 巡检报总管还没看过的迟到回报', () => {
  it('结案后成员又回报 ⇒ 巡检有一项；总管跑过一轮以后消失', async () => {
    const s = await ready()
    await s.tool('exec-a', 'master_report')({ task: 'L1107-9', state: '完成', action: '做完了' })
    s.clock.advance(60_000)
    await s.tool('exec-a', 'master_report')({ task: 'L1107-9', state: '进展', action: '按表格改完了清单' })
    const late = () => s.patrol.findings().filter(f => f.key.startsWith('late-report:'))
    expect(late()).toHaveLength(1)
    expect(late()[0]!.text).toMatch(/L1107-9[\s\S]*按表格改完了清单/)
    s.clock.advance(60_000); s.core.onStatus(MASTER_ID, 'running')
    expect(late()).toHaveLength(0)
  })
})

describe('G14 ③c 状态栏：等你定挂超过 2 小时标红', () => {
  it('最早一件超过 2 小时 ⇒ asksOverdue = 1、asksOldestMin ≥ 120；之前是 0', async () => {
    const s = await ready()
    await s.core.askUser({ task: 'L1107-9', question: 'Q?', options: ['A'] })
    s.clock.advance(60 * 60_000)
    expect(s.panel.statusBar({ waitingCount: 0 }).counts).toMatchObject({ asks: 1, asksOverdue: 0 })
    s.clock.advance(61 * 60_000)
    const c: any = s.panel.statusBar({ waitingCount: 0 }).counts
    expect(c.asksOverdue).toBe(1)
    expect(c.asksOldestMin).toBeGreaterThanOrEqual(120)
  })
})

describe('G14 ③d master_ask_close：在对话里答过的等你定由总管结案', () => {
  it('按编号结案、记答案和事件；已结的、不存在的报错；成员没有这个工具', async () => {
    const s = await ready()
    const { id, code } = await s.core.askUser({ task: 'L1107-9', question: 'Q?', options: ['A', 'B'] }) as any
    expect(s.core.toolsFor('exec-a').map(t => t.name)).not.toContain('master_ask_close')
    expect(await s.tool(MASTER_ID, 'master_ask_close')({ code, answer: '用户在对话里说选 B' })).toMatchObject({ code, state: 'answered' })
    expect(s.store.getAsk(id)).toMatchObject({ state: 'answered', answer: '用户在对话里说选 B' })
    expect(s.store.events({ type: 'ask/answered' }).map(e => JSON.parse(e.data))).toEqual([expect.objectContaining({ id, via: 'conversation' })])
    await expect(s.tool(MASTER_ID, 'master_ask_close')({ code, answer: 'x' })).rejects.toThrow(/已经/)
    await expect(s.tool(MASTER_ID, 'master_ask_close')({ code: 'Q0101-99', answer: 'x' })).rejects.toThrow(/没有/)
  })
})
