/**
 * G14 第二批（G14-2b）单测。
 * ⑦ 看板搜索 + 状态 / 负责筛选（matchTasks：编号、标题、负责、叫法、最后一句回报；全角转半角、不分大小写、多词都要中）。
 * ⑧ 统计白叫醒：巡检 / 保底叫醒总管时记一笔，总管那一轮只调了只读工具（master_patrol 等）= noop，调了别的 = acted；按发现种类统计 7 天。
 * ⑥ 成员回报正文太长：投给总管的只放前 1,500 字 + 「全文在看板 / 任务书」，库里和任务书照存全文（照 Claude Code T010 回报限长）。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

const flush = () => new Promise(r => setImmediate(r))
async function ready() {
  const dir = tmpdir('g14b'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const dport = new FakeDeliveryPort()
  const core = new Core(store, new Delivery(store, dport, clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, mem, timer: () => () => {} })
  await core.ensureMaster(tmpdir('m'))
  await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  await core.dispatch({ task: 'L1118-5', kind: 'light', title: '小活', to: 'a', text: '做' }, MASTER_ID)
  const tool = (caller: string, name: string) => { const t = core.toolsFor(caller).find(x => x.name === name); if (!t) throw new Error(`${caller} 没有 ${name}`); return (a: unknown) => t.run(a, caller) }
  await flush(); dport.calls.length = 0
  return { clock, store, dport, core, tool, mem }
}

describe('G14 ⑥ 回报正文太长时截短', () => {
  it('3,000 字的 body：总管收到的 ≤ 1,800 字（含消息头和状态行）、写明全文在哪；库里事件是全文', async () => {
    const s = await ready()
    const body = `要点在前：清单改成表格了。\n${'细节。'.repeat(1000)}`
    await s.tool('exec-a', 'master_report')({ task: 'L1118-5', state: '进展', action: '改完清单', body }); await flush()
    const t = s.dport.calls.filter(c => c.to === MASTER_ID).at(-1)!.text
    expect(t.length).toBeLessThanOrEqual(1800)
    expect(t).toContain('要点在前：清单改成表格了。')
    expect(t).toMatch(/截断[\s\S]*全文/)
    const ev = s.store.events({ task: 'L1118-5', type: 'task/report' }).at(-1)!
    expect(JSON.parse(ev.data).body).toBe(body)
  })
  it('短 body 原样投，不加截断说明', async () => {
    const s = await ready()
    await s.tool('exec-a', 'master_report')({ task: 'L1118-5', state: '进展', action: '改完', body: '短短一段' }); await flush()
    const t = s.dport.calls.filter(c => c.to === MASTER_ID).at(-1)!.text
    expect(t).toContain('短短一段'); expect(t).not.toMatch(/截断/)
  })
  it('工具说明提醒要点放前面', async () => {
    const s = await ready()
    expect(s.core.toolsFor('exec-a').find(t => t.name === 'master_report')!.description).toMatch(/要点放前面/)
  })
})

describe('G14 ⑦ 看板搜索 / 筛选（matchTasks）', async () => {
  const { matchTasks, filterOptions } = await import('../src/board-groups.ts') as any
  const T = (id: string, title: string, owner: string, state: string, extra: Record<string, unknown> = {}) => ({ id, title, owner, state, closed: false, openAsks: 0, ...extra })
  const tasks = [
    T('T021', '整理脚本 tidy.py', 'alpha.x', '进行中', { lastLine: '[T021] 状态=进展 ｜当前动作：单元测试写完了' }),
    T('L1118-5', '改 README', 'alpha.y', '完成', { alias: '说明书' }),
    T('T022', 'Release 打包', 'alpha.x', '受阻'),
  ]
  const ids = (xs: any[]) => xs.map(t => t.id)
  it('空搜索、空筛选 ⇒ 原样', () => { expect(ids(matchTasks(tasks, '', {}))).toEqual(['T021', 'L1118-5', 'T022']) })
  it('编号、标题、负责、叫法、最后一句回报都能搜到', () => {
    expect(ids(matchTasks(tasks, 't021', {}))).toEqual(['T021'])
    expect(ids(matchTasks(tasks, 'readme', {}))).toEqual(['L1118-5'])
    expect(ids(matchTasks(tasks, '说明书', {}))).toEqual(['L1118-5'])
    expect(ids(matchTasks(tasks, '单元测试', {}))).toEqual(['T021'])
    expect(ids(matchTasks(tasks, 'alpha.x', {}))).toEqual(['T021', 'T022'])
  })
  it('全角转半角、多词都要中（可以中在不同字段）', () => {
    expect(ids(matchTasks(tasks, 'ＴＩＤＹ', {}))).toEqual(['T021'])
    expect(ids(matchTasks(tasks, 'alpha.x  打包', {}))).toEqual(['T022'])
    expect(ids(matchTasks(tasks, 'alpha.x 不存在的词', {}))).toEqual([])
  })
  it('状态 / 负责筛选，和搜索叠加；下拉选项按实际出现的值生成', () => {
    expect(ids(matchTasks(tasks, '', { state: '受阻' }))).toEqual(['T022'])
    expect(ids(matchTasks(tasks, '', { owner: 'alpha.x' }))).toEqual(['T021', 'T022'])
    expect(ids(matchTasks(tasks, 'tidy', { owner: 'alpha.y' }))).toEqual([])
    expect(filterOptions(tasks)).toEqual({ states: ['受阻', '完成', '进行中'], owners: ['alpha.x', 'alpha.y'] })
  })
})

describe('G14 ⑧ 统计白叫醒', async () => {
  const { Patrol } = await import('../src/patrol.ts')
  it('叫醒后那一轮只调了 master_patrol ⇒ noop；调了 master_send ⇒ acted；按种类统计', async () => {
    const s = await ready()
    s.core.noteWake('patrol', ['ask:1', 'stalled:exec-a:T1'])
    s.clock.advance(1000); s.core.onStatus(MASTER_ID, 'running'); s.core.noteToolCall(MASTER_ID, 'master_patrol'); s.clock.advance(1000); s.core.onStatus(MASTER_ID, 'idle')
    s.core.noteWake('schedule', ['ask:1'])
    s.clock.advance(1000); s.core.onStatus(MASTER_ID, 'running'); s.core.noteToolCall(MASTER_ID, 'master_patrol'); s.core.noteToolCall(MASTER_ID, 'master_send'); s.clock.advance(1000); s.core.onStatus(MASTER_ID, 'idle')
    const out = s.store.events({ type: 'wake/outcome' }).map(e => JSON.parse(e.data))
    expect(out.map(o => [o.source, o.outcome])).toEqual([['patrol', 'noop'], ['schedule', 'acted']])
    expect(s.core.wakeStats()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ask', wakes: 2, noop: 1 }),
      expect.objectContaining({ kind: 'stalled', wakes: 1, noop: 1 }),
    ]))
  })
  it('没被叫醒的轮次不算；叫醒前就开始的那一轮不算', async () => {
    const s = await ready()
    s.core.onStatus(MASTER_ID, 'running'); s.clock.advance(500)
    s.core.noteWake('patrol', ['x:1'])
    s.clock.advance(500); s.core.onStatus(MASTER_ID, 'idle')
    expect(s.store.events({ type: 'wake/outcome' })).toHaveLength(0)
    s.clock.advance(1000); s.core.onStatus(MASTER_ID, 'running'); s.clock.advance(1000); s.core.onStatus(MASTER_ID, 'idle')
    expect(s.store.events({ type: 'wake/outcome' }).map(e => JSON.parse(e.data).outcome)).toEqual(['noop'])
  })
  it('巡检真报了一条 ⇒ 记下这次叫醒（只记新增的 key）', async () => {
    const s = await ready()
    const p = new Patrol(s.store, s.core, undefined, s.clock, { stallMs: 1e12, longRunMs: 1e12 })
    p.findings = () => [{ key: 'ask:9', text: 'x' }]
    expect(p.tick()).toBe('reported')
    expect(JSON.parse(s.store.getMeta('wake:pending')!)).toMatchObject({ source: 'patrol', keys: ['ask:9'] })
  })
})
