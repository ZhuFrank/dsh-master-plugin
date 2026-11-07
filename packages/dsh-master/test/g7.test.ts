/**
 * G7 打磨轮（单测部分）：
 * ⑥ 工具返回值一律是对象（toolOutput 兜底）；① 回报 / 派活 / 验收的 gate 归一成闸门编号；
 * ③ 成员守则写明往项目外写怎么申请放宽；⑦ 总管守则补两句；安全：守卫拦非总管会话读实例日志目录。
 * ⑥ 的宿主那一层、④ ⑤ 在 e2e/g7-polish.e2e.test.ts。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Core, MASTER_ID, normGate } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { toolOutput } from '../src/tool-output.ts'
import { rolePrompt } from '../src/prompts.ts'
import { guardDecision, NO_SECRET } from '../src/guard.ts'
import { tmpStore, tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

function setup() {
  const store = tmpStore('g7'); const clock = fakeClock()
  const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, timer: () => () => {} })
  return { store, core }
}
const tool = (core: Core, caller: string, name: string) => {
  const t = core.toolsFor(caller).find(x => x.name === name)
  if (!t) throw new Error(`${caller} 没有工具 ${name}`)
  return (args: unknown) => t.run(args, caller)
}

describe('G7 ⑥ 工具返回值', () => {
  it('toolOutput：对象原样；数组、字符串、空值包成对象', () => {
    const o = { a: 1 }
    expect(toolOutput(o)).toBe(o)
    expect(toolOutput([1, 2])).toEqual({ result: [1, 2] })
    expect(toolOutput('x')).toEqual({ result: 'x' })
    expect(toolOutput(undefined)).toEqual({ result: null })
    expect(toolOutput(null)).toEqual({ result: null })
  })
  it('master_sessions 返回 { sessions: [...] }（没有成员时也是对象）', async () => {
    const s = setup(); await s.core.ensureMaster(tmpdir('mcwd'))
    const r0 = await tool(s.core, MASTER_ID, 'master_sessions')({}) as any
    expect(Array.isArray(r0)).toBe(false)
    expect(r0.sessions.map((x: any) => x.id)).toEqual([MASTER_ID])
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    const r1 = await tool(s.core, MASTER_ID, 'master_sessions')({}) as any
    expect(r1.sessions.map((x: any) => x.id).sort()).toEqual(['exec-a', MASTER_ID].sort())
  })
  it('所有工具（总管、成员）的返回值都是对象', async () => {
    const s = setup(); await s.core.ensureMaster(tmpdir('mcwd'))
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    for (const name of ['master_sessions', 'master_patrol']) {
      const r = await tool(s.core, MASTER_ID, name)({})
      expect(r !== null && typeof r === 'object' && !Array.isArray(r), name).toBe(true)
    }
  })
})

describe('G7 ① gate 归一成闸门编号', () => {
  it('normGate：去掉后面的标题，保留 G6-1 / G6a 这类编号；不是 G 开头的原样', () => {
    expect(['G1 — 写清单', 'G1', ' g2 收尾', 'G6-1（数据层）', 'G6-1', 'G6a: 研究', 'G4b', 'G1（实现 + 自测）', '试运行', 'G12—x'].map(normGate))
      .toEqual(['G1', 'G1', 'G2', 'G6-1', 'G6-1', 'G6a', 'G4b', 'G1', '试运行', 'G12'])
    expect(normGate(undefined)).toBeUndefined()
    expect(normGate('  ')).toBeUndefined()
  })
  let s: ReturnType<typeof setup>
  beforeEach(async () => {
    s = setup(); await s.core.ensureMaster(tmpdir('mcwd'))
    await tool(s.core, MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
  })
  it('成员回报写「G1 — 写清单」，库里和事件里记 G1', async () => {
    await tool(s.core, MASTER_ID, 'master_dispatch')({ task: 'L1107-1', kind: 'light', title: 't', to: 'a', text: 'x' })
    await tool(s.core, 'exec-a', 'master_report')({ task: 'L1107-1', state: '进展', action: '写清单', gate: 'G1 — 写清单' })
    expect(s.store.getTask('L1107-1')!.gate).toBe('G1')
    const ev = s.store.events({ task: "L1107-1", type: "task/report" }).at(-1) as any
    expect((typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data).gate).toBe('G1')
  })
  it('派活和验收的 gate 也归一', async () => {
    await tool(s.core, MASTER_ID, 'master_dispatch')({ task: 'L1107-2', kind: 'light', title: 't', to: 'a', text: 'x', gate: 'G2（收尾）' })
    expect(s.store.getTask('L1107-2')!.gate).toBe('G2')
  })
})

describe('G7 守则', () => {
  it('⑦ 总管守则：工具报错就停下回报，不翻源码、不全盘搜索；成员只能用 master_spawn 建', () => {
    const p = rolePrompt('master', 'm1', '/h.md', 'm1', { root: '/r' })
    expect(p).toContain('- dsh-master 的工具报错（比如 invalid output、unknown tool）就停下：把原样的报错告诉用户，结束本轮。')
    expect(p).toContain('不要去翻插件源码、~/.dsh 这类别的实例目录，也不要全盘 find / grep 找原因，更不要想办法绕过守卫')
    expect(p).toMatch(/成员只能用 master_spawn 建/)
    expect(p).toMatch(/不会进花名册/)
  })
  it('③ 成员守则：往项目外写要带 sandbox_permissions 申请放宽，不要只回报受阻', () => {
    const p = rolePrompt('exec', 'p.a', '/h.md', 'm1', { root: '/r' })
    expect(p).toContain('sandbox_permissions')
    expect(p).toMatch(/不要只回报「受阻」/)
  })
})

describe('G7 安全：守卫拦非总管会话读实例日志', () => {
  const logs = '/Users/x/.dsh-master/logs'
  const cfg = { protectedPaths: ['/Users/x/.dsh-master/dsh-master'], secretPaths: [logs], env: { HOME: '/Users/x', DSH_HOME: '/Users/x/.dsh-master' } }
  const bash = (command: string, role?: 'master' | 'exec', cwd = '/w') => guardDecision({ name: 'bash', args: { command }, role, cwd }, cfg)
  it('成员、未入编会话用命令读日志被拦（绝对路径、~、$DSH_HOME、通配、相对路径、grep）', () => {
    for (const role of ['exec', undefined] as const) {
      expect(bash('cat /Users/x/.dsh-master/logs/dsh.log', role)).toBe(NO_SECRET)
      expect(bash('grep token ~/.dsh-master/logs/dsh.log | tail -1', role)).toBe(NO_SECRET)
      expect(bash('tail -n 5 $DSH_HOME/logs/dsh.log', role)).toBe(NO_SECRET)
      expect(bash('ls ~/.dsh-master/logs/*', role)).toBe(NO_SECRET)
      expect(bash('cat logs/dsh.log', role, '/Users/x/.dsh-master')).toBe(NO_SECRET)
      expect(bash('cat dsh.log', role, '/Users/x/.dsh-master/logs')).toBe(NO_SECRET)
    }
  })
  it('成员用 read / grep 工具读日志被拦', () => {
    expect(guardDecision({ name: 'read', args: { file_path: '/Users/x/.dsh-master/logs/dsh.log' }, role: 'exec', cwd: '/w' }, cfg)).toBe(NO_SECRET)
    expect(guardDecision({ name: 'read', args: { file_path: '~/.dsh-master/logs/dsh.2.log' }, role: undefined, cwd: '/w' }, cfg)).toBe(NO_SECRET)
    expect(guardDecision({ name: 'grep', args: { pattern: 'token', path: '/Users/x/.dsh-master/logs' }, role: 'exec', cwd: '/w' }, cfg)).toBe(NO_SECRET)
  })
  it('总管可以读；别的目录照常放行', () => {
    expect(bash('tail -n 5 ~/.dsh-master/logs/dsh.log', 'master')).toBeUndefined()
    expect(guardDecision({ name: 'read', args: { file_path: '/Users/x/.dsh-master/logs/dsh.log' }, role: 'master', cwd: '/w' }, cfg)).toBeUndefined()
    expect(bash('cat /Users/x/proj/logs/app.log', 'exec')).toBeUndefined()
    expect(bash('ls ~/.dsh-master', 'exec')).toBeUndefined()
    expect(guardDecision({ name: 'read', args: { file_path: '/Users/x/proj/logs/dsh.log' }, role: 'exec', cwd: '/w' }, cfg)).toBeUndefined()
  })
})

describe('G7 ⑧ 定时保底只为新发现叫醒模型', () => {
  it('unseenForSchedule：没发现 0；有新发现 >0；记下以后同样的发现 0；巡检报过的也算见过；发现变了又 >0', async () => {
    const { Patrol } = await import('../src/patrol.ts')
    const s = setup(); await s.core.ensureMaster(tmpdir('mcwd'))
    const p = new Patrol(s.store, s.core, undefined, fakeClock(), { stallMs: 1e12, longRunMs: 1e12 })
    expect(p.unseenForSchedule().count).toBe(0)
    await tool(s.core, MASTER_ID, 'master_ask_user')({ task: 'L1107-9', question: '要不要继续？', options: ['要', '不要'] })
    const a = p.unseenForSchedule()
    expect(a.count).toBe(1)
    p.markScheduleSeen(a.sig)
    expect(p.unseenForSchedule().count).toBe(0)
    await tool(s.core, MASTER_ID, 'master_ask_user')({ task: 'L1107-8', question: '第二件？', options: ['是', '否'] })
    const b = p.unseenForSchedule() // 两件等你定合成一项发现（asks:…），但签名变了
    expect(b.count).toBe(1)
    expect(b.sig).not.toBe(a.sig)
    expect(p.tick()).toBe('reported') // 巡检消息报过 ⇒ 保底也不再为它叫醒
    expect(p.unseenForSchedule().count).toBe(0)
  })
})

describe('G7 ⑨ 已结案但还挂着等你定的任务（3090 master-workspace 看板：T101 等你定被分进「已结束」，「只看等我」是 0）', async () => {
  const { needsYou, boardGroups } = await import('../src/board-groups.ts')
  const { filterTasks } = await import('../src/panel-api.ts')
  const card = (id: string, state: string, closed: boolean, openAsks = 0) => ({ id, state, closed, openAsks })
  const t101 = card('T101', '完成', true, 1)
  const done = card('L1107-2', '完成', true)
  const run = card('L1107-3', '进行中', false)
  const wait = card('L1107-4', '待验收', false)
  it('needsYou：有没回答的等你定就算等我，不管任务是不是已结案', () => {
    expect([t101, done, run, wait].map(needsYou)).toEqual([true, false, false, true])
  })
  it('标签：Q 的状态不顶掉任务状态（已结案的写「完成 · 等你定」）', async () => {
    const { stateLabel } = await import('../src/board-groups.ts')
    expect([t101, done, run, card('L1107-5', '进行中', false, 1)].map(stateLabel)).toEqual(['完成 · 等你定', '完成', '进行中', '等你定'])
  })
  it('分组：T101 在「等你处理」，不在「已结束」；只看等我也有它', () => {
    const g = Object.fromEntries(boardGroups([t101, done, run, wait], { mine: false, archived: false }).map(([n, l]) => [n, l.map((x: any) => x.id)]))
    expect(g['等你处理']).toEqual(['T101', 'L1107-4'])
    expect(g['进行中']).toEqual(['L1107-3'])
    expect(g['已结束（近 7 天）']).toEqual(['L1107-2'])
    const mine = boardGroups([t101, done, run, wait], { mine: true, archived: false })
    expect(mine.map(([n]) => n)).toEqual(['等你处理'])
    expect(mine[0]![1].map((x: any) => x.id)).toEqual(['T101', 'L1107-4'])
  })
  it('超过 7 天的已结案任务，只要还挂着等你定，就留在近 7 天视图、不进已归档', () => {
    const now = Date.parse('2026-11-20T12:00:00+08:00'); const old = new Date(now - 8 * 24 * 3600_000).toISOString()
    const row = (id: string) => ({ id, kind: 'heavy' as const, title: id, owner: 'p.a', state: '完成', gate: 'G1', meta: '{}', created_at: old, updated_at: old })
    const rows = [row('T101'), row('T102')]
    expect(filterTasks(rows, 'active', now, {}, new Set(['T101'])).map(x => x.id)).toEqual(['T101'])
    expect(filterTasks(rows, 'archived', now, {}, new Set(['T101'])).map(x => x.id)).toEqual(['T102'])
  })
})
