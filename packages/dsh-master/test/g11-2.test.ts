/**
 * G11-2 总管状态栏（L1107-2 方案 §3）：
 * ① doingLabel：「正在：」只记工具名 + 参数里的 description（压成一行、≤80 字），不记命令全文和别的参数（隐私）；
 * ② MasterNowTracker：只记最近一次；
 * ③ PanelService.statusBar：总管忙闲 / 正在、下次保底、三个计数（等你定 / 等你点 / 受阻）、执行会话块（在岗成员 + 手上任务 + 闸门）。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { PanelService, type PanelPort } from '../src/panel-service.ts'
import { Attribution } from '../src/attrib.ts'
import { doingLabel, MasterNowTracker, DOING_MAX } from '../src/status-bar.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

describe('G11-2 ① doingLabel 隐私', () => {
  const secretCurl = { command: "curl -sS -H 'Authorization: Bearer sk-live-abc123' https://api.example.com/v1/x", description: '查询接口状态' }
  it('bash 带 description ⇒「bash · 说明」；命令全文（curl、Authorization、令牌、地址）一个字都不出现', () => {
    const t = doingLabel('bash', secretCurl)
    expect(t).toBe('bash · 查询接口状态')
    for (const w of ['curl', 'Authorization', 'Bearer', 'sk-live', 'api.example.com']) expect(t).not.toContain(w)
  })
  it('没有 description ⇒ 只有工具名（不退回去用命令或路径）', () => {
    expect(doingLabel('bash', { command: secretCurl.command })).toBe('bash')
    expect(doingLabel('write', { path: '/Users/someone/secret/plan.md', content: 'x' })).toBe('write')
    expect(doingLabel('master_dispatch', { task: 'T1', text: '派活正文' })).toBe('master_dispatch')
  })
  it('description 压成一行、最多 80 字；不是字符串就当没有', () => {
    const long = '一'.repeat(200)
    const t = doingLabel('bash', { description: `第一行\n  第二行\t${long}` })
    expect(t.startsWith('bash · 第一行 第二行 一')).toBe(true)
    expect([...t.slice('bash · '.length)].length).toBeLessThanOrEqual(DOING_MAX)
    expect(t.endsWith('…')).toBe(true)
    expect(doingLabel('bash', { description: { evil: 'Authorization' } })).toBe('bash')
    expect(doingLabel(undefined, undefined)).toBe('（未知工具）')
  })
})

describe('G11-2 ② MasterNowTracker', () => {
  it('每个总管只留最近一次；别的会话互不影响', () => {
    const t = new MasterNowTracker()
    t.record('m', 'bash', { description: '跑单测' }, 1000)
    t.record('m', 'master_review', {}, 2000)
    t.record('n', 'bash', { description: '别的项目' }, 3000)
    expect(t.get('m')).toEqual({ label: 'master_review', atMs: 2000 })
    expect(t.get('n')?.label).toBe('bash · 别的项目')
    expect(t.get('x')).toBeUndefined()
  })
})

describe('G11-2 ③ PanelService.statusBar', () => {
  async function setup() {
    const dir = tmpdir('g11-2'); const clock = fakeClock()
    const store = new Store(path.join(dir, 'master.db'))
    const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
    const sport = new FakeSessionPort()
    const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), sport, clock, { idleGraceMs: 2000, mem })
    const panel = new PanelService(store, core, new Attribution(store, core, clock), { promptUser: async () => {}, turnText: async () => undefined } as PanelPort, clock)
    await core.ensureMaster(tmpdir('m'))
    await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
    await core.spawn({ name: 'b', cwd: tmpdir('b'), title: 'B' }, MASTER_ID)
    await core.spawn({ name: 'c', cwd: tmpdir('c'), title: 'C' }, MASTER_ID)
    const specTool = core.toolsFor(MASTER_ID).find(t => t.name === 'task_spec_write')!
    await specTool.run({ task: 'T100', title: '大活', expected: '1h', output: '/tmp/o', resume: 'r', 目标: 'x', 要读的: 'x', 交付物: 'x', 验收标准: 'x', 红线: 'x', gates: [{ id: 'G2', title: '第二步' }] }, MASTER_ID)
    await core.dispatch({ task: 'T100', kind: 'heavy', title: '大活', to: 'a', gate: 'G2', text: '做', expected: '1h', output: '/tmp/o', resume: 'x' }, MASTER_ID)
    await core.dispatch({ task: 'L1107-1', kind: 'light', title: '小活', to: 'b', text: '做' }, MASTER_ID)
    await core.dispatch({ task: 'L1107-2', kind: 'light', title: '卡住的活', to: 'b', text: '做' }, MASTER_ID)
    await core.report({ task: 'L1107-2', state: '受阻', action: '缺权限' }, 'exec-b')
    await core.dispatch({ task: 'L1107-3', kind: 'light', title: '做完的活', to: 'a', text: '做' }, MASTER_ID)
    await core.report({ task: 'L1107-3', state: '完成', action: '做完了' }, 'exec-a') // 已结的任务不进成员块
    await core.askUser({ task: 'T100', question: '用 A 还是 B？', options: ['A', 'B'] })
    s_close(store)
    sport.live.set(MASTER_ID, 'running'); sport.live.set('exec-a', 'running'); sport.live.set('exec-b', 'idle')
    return { store, core, panel, clock }
  }
  const s_close = (store: Store) => store.closeSession('exec-c', new Date().toISOString())

  it('总管忙 + 正在什么、下次保底、三个计数、执行会话块（关闭的不列；任务带闸门）', async () => {
    const { panel } = await setup()
    const sb = panel.statusBar({ doing: { label: 'bash · 跑单测', atMs: Date.parse('2026-11-07T14:03:00Z') }, waitingCount: 2, nextSchedule: '2026-11-07T14:40:00.000Z' })
    expect(sb.master).toMatchObject({ id: MASTER_ID, live: 'running', doing: 'bash · 跑单测', doingAt: '2026-11-07 2203' })
    expect(sb.nextSchedule).toBe('2026-11-07 2240')
    expect(sb.counts).toEqual({ asks: 1, waiting: 2, blocked: 1 })
    expect(sb.members.map(m => m.id)).toEqual(['exec-a', 'exec-b'])
    expect(sb.members[0]).toMatchObject({ live: 'running', tasks: [{ id: 'T100', state: '进行中', gate: 'G2' }] })
    expect(sb.members[1]!.tasks.map(t => `${t.id}[${t.state}]`)).toEqual(['L1107-1[进行中]', 'L1107-2[受阻]'])
  })
  it('没有记录 / 没有定时保底 ⇒ doing、nextSchedule 都是 null（不编）', async () => {
    const { panel } = await setup()
    const sb = panel.statusBar({ waitingCount: 0 })
    expect(sb.master.doing).toBeNull(); expect(sb.master.doingAt).toBeNull(); expect(sb.nextSchedule).toBeNull()
  })
})
