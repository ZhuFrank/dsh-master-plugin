/**
 * G6-3 — 看板与交互：编号识别（客户端纯函数）+ 闸门 / Q 索引、未入编、会话视图（服务端）。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { Store } from '../src/store.ts'
import { Core } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Attribution } from '../src/attrib.ts'
import { PanelService } from '../src/panel-service.ts'
import { MemoryLayer } from 'dsh-master-devlog'
import { refParts, linkRefs, refTitle, withSession } from '../src/client/index.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

const IDX = {
  gateIndex: { T013: { title: '归因', spec: '/s/T013.md', gates: { G14: { title: '归因表最终版', produces: '', status: '已验收', outputs: [] }, 'G6-1': { title: '数据层', produces: '', status: '进行中', outputs: [] } } } },
  askIndex: { 'Q1105-2': { task: 'T013', question: '状态存哪？', state: 'open', answer: null, at: '2026-11-05 2300' } },
}
const refs = (t: string, cur?: string) => refParts(t, IDX, cur).filter(p => typeof p !== 'string').map(p => (p as any).text)

describe('G6-3 编号识别', () => {
  it('跨任务三种写法、Q 编号都认；本任务里光写的 Gn 只在有本任务时认', () => {
    expect(refs('见 T013·G14、T013 G14、T013-G14')).toEqual(['T013·G14', 'T013 G14', 'T013-G14'])
    expect(refs('先定 Q1105-2 再说')).toEqual(['Q1105-2'])
    expect(refs('G14 做完了')).toEqual([])
    expect(refs('G14 做完了', 'T013')).toEqual(['G14'])
    expect(refs('G6-1（数据层）好了', 'T013')).toEqual(['G6-1'])
  })
  it('只认编号表里查得到的；文件名、路径、粗体、别的编号里的不认', () => {
    expect(refs('T999·G1 和 Q0101-9', 'T013')).toEqual([])
    expect(refs('G5_report.md、G14.html、SG14、/x/G14、**G14**、x.G14', 'T013')).toEqual([])
    expect(refs('句末的 G14。', 'T013')).toEqual(['G14'])
  })
  it('全文：变成 dshm-gate / dshm-q 链接；代码里的不动；光写的 Gn 按本任务', () => {
    expect(linkRefs('见 T013·G14 和 Q1105-2，`T013·G14` 不动', IDX)).toBe('见 [T013·G14](dshm-gate/T013/G14) 和 [Q1105-2](dshm-q/Q1105-2)，`T013·G14` 不动')
    expect(linkRefs('G14 好了', IDX, 'T013')).toBe('[G14](dshm-gate/T013/G14) 好了')
  })
  it('悬停标题：编号 + 标题 + 状态；Q 带问题和是否已定', () => {
    expect(refTitle({ kind: 'gate', task: 'T013', gate: 'G14' }, IDX)).toBe('T013·G14 · 归因表最终版（已验收）')
    expect(refTitle({ kind: 'q', code: 'Q1105-2' }, IDX)).toBe('Q1105-2 · 状态存哪？（待定）')
  })
  it('接口带上当前会话', () => {
    expect(withSession('/api/x?view=active', 'a b')).toBe('/api/x?view=active&session=a%20b')
    expect(withSession('/api/x', undefined)).toBe('/api/x')
  })
})

async function setup() {
  const dir = tmpdir('g63'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'm.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'mem.db'), docsRoot: path.join(dir, 'docs'), clock })
  const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 1000, mem })
  await core.ensureMaster(tmpdir('mw'))
  const tool = (who: string, name: string) => (a: unknown) => core.toolsFor(who).find(t => t.name === name)!.run(a, who)
  const panel = new PanelService(store, core, new Attribution(store, core, clock), { promptUser: async () => {}, turnText: async () => undefined } as any, clock)
  return { store, core, tool, panel, clock }
}
const SPEC = { task: 'T013', title: '归因', expected: '1h', output: '/tmp/out', resume: 'r', 目标: 'x', 要读的: 'x', 交付物: 'x', 验收标准: 'x', 红线: 'x',
  gates: [{ id: 'G6-1', title: '数据层', produces: '/tmp/out/g61.md' }, { id: 'G6-2', title: '开张与团队' }] }

describe('G6-3 闸门 / Q 索引（服务端）', () => {
  it('状态全从事件来；G6-1 和 G6-2 不再合成 G6；产物 = 定义 + 这个闸门回报里的路径', async () => {
    const s = await setup()
    await s.tool('master', 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A', purpose: '做数据层' })
    await s.tool('master', 'task_spec_write')(SPEC)
    await s.tool('master', 'master_dispatch')({ task: 'T013', kind: 'heavy', title: '归因', to: 'a', gate: 'G6-1', text: '开始' })
    await s.tool('exec-a', 'master_report')({ task: 'T013', state: '就绪', gate: 'G6-1', action: '好了', body: '产物 /tmp/out/projects.ts（新）' })
    let gi = s.panel.gateIndex().T013!
    expect(Object.keys(gi.gates)).toEqual(['G6-1', 'G6-2'])
    expect(gi.gates['G6-1']).toMatchObject({ title: '数据层', status: '进行中', outputs: ['/tmp/out/g61.md', '/tmp/out/projects.ts'] })
    expect(gi.gates['G6-2']!.status).toBe('未验收')
    expect(gi.spec).toMatch(/tasks\/T013\.md$/)
    await s.tool('master', 'master_review')({ task: 'T013', verdict: '通过', gate: 'G6-1', notes: '好' })
    gi = s.panel.gateIndex().T013!
    expect(gi.gates['G6-1']!.status).toBe('已验收')
    // 任务详情的闸门格子：按定义、编号精确
    expect(s.panel.thread('T013').task!.gates.map((g: any) => [g.gate, g.state])).toEqual([['G6-1', 'passed'], ['G6-2', 'seen']])
    await s.tool('master', 'master_review')({ task: 'T013', verdict: '打回', gate: 'G6-2', notes: '缺' })
    expect(s.panel.gateIndex().T013!.gates['G6-2']!.status).toBe('打回')
    expect(s.panel.thread('T013').task!.gates.map((g: any) => [g.gate, g.state])).toEqual([['G6-1', 'passed'], ['G6-2', 'rejected']])
  })
  it('没定义闸门的任务：闸门格子照事件来，打回的是打回、不算已验收', async () => {
    const s = await setup()
    await s.tool('master', 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await s.tool('master', 'master_dispatch')({ task: 'L1106-3', kind: 'light', title: '没任务书的活', to: 'a', text: 'x' })
    await s.tool('master', 'master_review')({ task: 'L1106-3', verdict: '通过', gate: 'G1', notes: '好' })
    await s.tool('master', 'master_review')({ task: 'L1106-3', verdict: '打回', gate: 'G2', notes: '缺' })
    expect(s.panel.thread('L1106-3').task!.gates.map((g: any) => [g.gate, g.state])).toEqual([['G1', 'passed'], ['G2', 'rejected']])
    expect(s.panel.gateIndex()['L1106-3']).toBeUndefined() // 没定义就不进编号表（不变成标签和卡片）
  })
  it('Q 索引：编号 → 问题 / 任务 / 是否已定', async () => {
    const s = await setup()
    await s.tool('master', 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await s.tool('master', 'master_dispatch')({ task: 'L1106-1', kind: 'light', title: 't', to: 'a', text: 'x' })
    const { code, id } = await s.core.askUser({ task: 'L1106-1', question: '要吗？' })
    expect(s.panel.askIndex()[code]).toMatchObject({ task: 'L1106-1', question: '要吗？', state: 'open' })
    s.store.answerAsk(id, '要', new Date().toISOString())
    expect(s.panel.askIndex()[code]).toMatchObject({ state: 'answered', answer: '要' })
  })
})

describe('G6-3 未入编、会话视图', () => {
  it('未入编：后来入编了的不再列', async () => {
    const s = await setup()
    s.store.addEvent({ at: new Date().toISOString(), session: 'session-x', type: 'session/unenrolled', data: { cwd: '/r', preset: 'standard' } })
    s.store.addEvent({ at: new Date().toISOString(), session: 'exec-a', type: 'session/unenrolled', data: { cwd: '/r', preset: 'standard' } })
    await s.tool('master', 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    expect(s.panel.unenrolled().map(u => u.session)).toEqual(['session-x'])
  })
  it('会话视图：负责什么、谁关的、最近回报的时间 + 状态 + 任务', async () => {
    const s = await setup()
    await s.tool('master', 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A', purpose: '做数据层' })
    await s.tool('master', 'master_spawn')({ name: 'b', cwd: tmpdir('b'), title: 'B' })
    await s.tool('master', 'master_dispatch')({ task: 'L1106-1', kind: 'light', title: '活', to: 'a', text: 'x' })
    await s.tool('exec-a', 'master_report')({ task: 'L1106-1', state: '进展', action: '做着' })
    await s.tool('master', 'master_close')({ name: 'b' })
    const v = Object.fromEntries(s.panel.sessionsView().map((x: any) => [x.id, x]))
    expect(v['exec-a']).toMatchObject({ purpose: '做数据层', closedBy: null, lastReport: { state: '进展', task: 'L1106-1' }, open: [{ id: 'L1106-1', state: '进行中', title: '活' }] })
    expect(v['exec-b']).toMatchObject({ purpose: null, status: 'closed', closedBy: '总管关的' })
  })
})
