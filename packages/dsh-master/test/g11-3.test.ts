/**
 * G11-3 Focus 区 + 按日期分组折叠（照本机看板 11-06 包；Frank #723：Focus 存项目库，不放浏览器）：
 * ① 看板动作 focus：白名单校验（任务号、on 必须是布尔）；
 * ② PanelService：focus 开 / 关写进项目库（重开库还在）；任务卡片带 focus；没有这个任务 ⇒ not_found；
 * ③ filterTasks：置顶的已结任务超过 7 天也留在默认视图（不被归档挤走）；
 * ④ listGroups：★ Focus → 等你处理 → 最近 5 天按日期 → 更早（默认折叠）；只看等我 / 已归档不变。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { PanelService, type PanelPort } from '../src/panel-service.ts'
import { Attribution } from '../src/attrib.ts'
import { validateAction, filterTasks } from '../src/panel-api.ts'
import { listGroups, RECENT_DAYS } from '../src/board-groups.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

describe('G11-3 ① 动作校验', () => {
  it('focus：任务号 + on 布尔；缺 on、on 不是布尔、任务号不对 ⇒ 拒', () => {
    expect(validateAction({ action: 'focus', task: 'L1107-1', on: true })).toEqual({ action: 'focus', task: 'L1107-1', on: true })
    expect(validateAction({ action: 'focus', task: 'T005', on: false })).toEqual({ action: 'focus', task: 'T005', on: false })
    expect(validateAction({ action: 'focus', task: 'L1107-1' })).toMatchObject({ error: expect.any(String) })
    expect(validateAction({ action: 'focus', task: 'L1107-1', on: 'true' })).toMatchObject({ error: expect.any(String) })
    expect(validateAction({ action: 'focus', task: '../x', on: true })).toMatchObject({ error: expect.any(String) })
  })
})

async function setup(dir = tmpdir('g11-3')) {
  const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, mem })
  const panel = new PanelService(store, core, new Attribution(store, core, clock), { promptUser: async () => {}, turnText: async () => undefined } as PanelPort, clock)
  return { dir, clock, store, core, panel }
}

describe('G11-3 ② focus 存项目库', () => {
  it('开 ⇒ 卡片 focus=true；重开库还在；关 ⇒ false；没有的任务 ⇒ not_found', async () => {
    const s = await setup()
    await s.core.ensureMaster(tmpdir('m'))
    await s.core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
    await s.core.dispatch({ task: 'L1107-1', kind: 'light', title: '活', to: 'a', text: '做' }, MASTER_ID)
    const card = (p: PanelService) => p.state({}).tasks.find((t: any) => t.id === 'L1107-1') as any
    expect(card(s.panel).focus).toBe(false)
    expect(await s.panel.act({ action: 'focus', task: 'L1107-1', on: true })).toMatchObject({ ok: true, focus: true })
    expect(card(s.panel).focus).toBe(true)
    // 重开同一个库（模拟 DSH 重启 / 换一台设备看）：还在
    // 先让派活排在 setImmediate 里的投递跑完再关库（不然它在关掉的库上读，留下 unhandled rejection，vitest 退出码 1）
    await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 20))
    s.store.db.close()
    const s2 = await setup(s.dir)
    expect(card(s2.panel).focus).toBe(true)
    await s2.panel.act({ action: 'focus', task: 'L1107-1', on: false })
    expect(card(s2.panel).focus).toBe(false)
    await expect(s2.panel.act({ action: 'focus', task: 'L9999-1', on: true })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('G11-3 ②b 看板服务把置顶集合传给过滤（接线）', () => {
  it('结束超过 7 天的任务：没置顶 ⇒ 默认视图没有；置顶 ⇒ 有', async () => {
    const s = await setup()
    await s.core.ensureMaster(tmpdir('m'))
    await s.core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
    await s.core.dispatch({ task: 'L1101-9', kind: 'light', title: '老活', to: 'a', text: '做' }, MASTER_ID)
    await s.core.report({ task: 'L1101-9', state: '完成', action: '做完了' }, 'exec-a')
    s.store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run('2026-01-01T10:00:00+08:00', 'L1101-9')
    const ids = () => s.panel.state({}).tasks.map((t: any) => t.id)
    expect(ids()).not.toContain('L1101-9')
    await s.panel.act({ action: 'focus', task: 'L1101-9', on: true })
    expect(ids()).toContain('L1101-9')
  })
})

describe('G11-3 ③ 置顶的已结任务不被归档挤走', () => {
  const now = Date.parse('2026-11-20T12:00:00+08:00')
  const row = (id: string, state: string, updated: string) => ({ id, state, updated_at: updated, created_at: updated } as any)
  it('结束超过 7 天：没置顶 ⇒ 只在已归档；置顶 ⇒ 默认视图也有', () => {
    const tasks = [row('L1101-1', '完成', '2026-11-01T10:00:00+08:00'), row('L1101-2', '完成', '2026-11-01T10:00:00+08:00')]
    const focus = new Set(['L1101-2'])
    expect(filterTasks(tasks, 'active', now, {}, new Set(), focus).map(t => t.id)).toEqual(['L1101-2'])
    expect(filterTasks(tasks, 'archived', now, {}, new Set(), focus).map(t => t.id)).toEqual(['L1101-1'])
    expect(filterTasks(tasks, 'active', now).map(t => t.id)).toEqual([])
  })
})

describe('G11-3 ④ listGroups', () => {
  const T = (id: string, updated: string, extra: Record<string, unknown> = {}) => ({ id, state: '进行中', closed: false, openAsks: 0, focus: false, updated, ...extra })
  const tasks = [
    T('L1120-1', '2026-11-20 0930'),                          // 今天
    T('L1120-2', '2026-11-20 1100', { state: '完成', closed: true }),
    T('L1119-1', '2026-11-19 2000'),                          // 昨天
    T('L1116-1', '2026-11-16 0800'),                          // 第 5 天（20、19、18、17、16）
    T('L1115-1', '2026-11-15 2359'),                          // 第 6 天 ⇒ 更早
    T('L1101-1', '2026-11-01 1000'),                          // 更早（没结，不能丢）
    T('L1118-1', '2026-11-18 1000', { state: '受阻' }),        // 等你处理
    T('L1117-1', '2026-11-17 1000', { focus: true }),         // Focus
    T('L1110-1', '2026-11-10 1000', { focus: true, state: '待验收' }), // Focus 优先于等你处理
  ]
  const g = listGroups(tasks, { mine: false, archived: false, today: '2026-11-20' })
  it(`顺序与成员：★ Focus → 等你处理 → 最近 ${RECENT_DAYS} 天按日期（新的在前）→ 更早；每个任务只出现一次`, () => {
    expect(g.map(x => [x.key, x.list.map(t => t.id)])).toEqual([
      ['focus', ['L1117-1', 'L1110-1']],
      ['need', ['L1118-1']],
      ['day:2026-11-20', ['L1120-1', 'L1120-2']],
      ['day:2026-11-19', ['L1119-1']],
      ['day:2026-11-16', ['L1116-1']],
      ['older', ['L1115-1', 'L1101-1']],
    ])
    expect(g.flatMap(x => x.list).length).toBe(tasks.length)
  })
  it('日期组名带「今天 / 昨天」；只有「更早」默认折叠', () => {
    expect(g.find(x => x.key === 'day:2026-11-20')!.name).toBe('11-20 今天')
    expect(g.find(x => x.key === 'day:2026-11-19')!.name).toBe('11-19 昨天')
    expect(g.find(x => x.key === 'day:2026-11-16')!.name).toBe('11-16')
    expect(g.find(x => x.key === 'focus')!.name).toBe('★ Focus')
    expect(g.filter(x => x.collapsedByDefault).map(x => x.key)).toEqual(['older'])
  })
  it('只看等我 ⇒ 只有一组「等你处理」（含置顶的）；已归档 ⇒ 一组；空组不出', () => {
    expect(listGroups(tasks, { mine: true, archived: false, today: '2026-11-20' }).map(x => [x.key, x.list.map(t => t.id)])).toEqual([['need', ['L1118-1', 'L1110-1']]])
    expect(listGroups(tasks, { mine: false, archived: true, today: '2026-11-20' }).map(x => x.key)).toEqual(['archived'])
    expect(listGroups([T('L1120-1', '2026-11-20 0930')], { mine: false, archived: false, today: '2026-11-20' }).map(x => x.key)).toEqual(['day:2026-11-20'])
  })
})
