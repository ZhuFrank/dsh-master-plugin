/**
 * G14 ⑨ 手动收起 / 归档 + 撤销（照 Claude Code 看板 T020 P1 和 T031 A 组的规则）：
 * - 收起：任何任务，只是列表里不显示，进「已收起」视图；收起后有新回报或新等你定 ⇒ 自动回到列表；
 * - 归档：只对已结束、没有挂着等你定的任务，马上进「已归档」，不等 7 天；恢复 = 回到列表（自动归档的也能恢复）；
 * - Focus + 收起：收起优先；Focus + 归档：归档优先，恢复后回到 Focus；
 * - 每个动作返回 undo（反向动作），看板 5 秒内可撤销。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { PanelService, type PanelPort, type TurnText } from '../src/panel-service.ts'
import { validateAction as parseAction } from '../src/panel-api.ts'
import { Attribution } from '../src/attrib.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

class FakePanelPort implements PanelPort {
  async promptUser() {}
  async turnText(_s: string, _t: number): Promise<TurnText | undefined> { return undefined }
}
const flush = () => new Promise(r => setImmediate(r))
async function ready() {
  const dir = tmpdir('g14-9'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, mem, timer: () => () => {} })
  const panel = new PanelService(store, core, new Attribution(store, core, clock), new FakePanelPort(), clock)
  await core.ensureMaster(tmpdir('m'))
  await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  for (const id of ['L1118-1', 'L1118-2', 'L1118-3']) await core.dispatch({ task: id, kind: 'light', title: `活 ${id}`, to: 'a', text: '做' }, MASTER_ID)
  const tool = (caller: string, name: string) => { const t = core.toolsFor(caller).find(x => x.name === name); if (!t) throw new Error(`${caller} 没有 ${name}`); return (a: unknown) => t.run(a, caller) }
  await tool('exec-a', 'master_report')({ task: 'L1118-2', state: '完成', action: '做完了' })
  await flush()
  const ids = (view?: string) => panel.state({ view }).tasks.map((t: any) => t.id).sort()
  return { clock, store, core, panel, tool, ids }
}

describe('G14 ⑨ 手动收起 / 归档', () => {
  it('收起：列表里没了、在「已收起」里；取消收起回来；undo 是反向动作；state 带 hiddenCount', async () => {
    const s = await ready()
    const r: any = await s.panel.act({ action: 'hide', task: 'L1118-1' } as any)
    expect(r).toMatchObject({ ok: true, undo: { action: 'setmarks', task: 'L1118-1', marks: { hide: null } } })
    expect(s.ids()).toEqual(['L1118-2', 'L1118-3'])
    expect(s.ids('hidden')).toEqual(['L1118-1'])
    expect((s.panel.state({}) as any).hiddenCount).toBe(1)
    await s.panel.act({ action: 'unhide', task: 'L1118-1' } as any)
    expect(s.ids()).toEqual(['L1118-1', 'L1118-2', 'L1118-3'])
  })
  it('收起后来了新回报 / 新等你定 ⇒ 自动回到列表', async () => {
    const s = await ready()
    await s.panel.act({ action: 'hide', task: 'L1118-1' } as any); await s.panel.act({ action: 'hide', task: 'L1118-3' } as any)
    s.clock.advance(60_000)
    await s.tool('exec-a', 'master_report')({ task: 'L1118-1', state: '受阻', action: '卡住了' })
    await s.core.askUser({ task: 'L1118-3', question: 'Q?', options: ['A'] })
    expect(s.ids()).toEqual(['L1118-1', 'L1118-2', 'L1118-3'])
    expect(s.ids('hidden')).toEqual([])
  })
  it('归档：只对已结束的；马上进「已归档」；恢复回到列表；没结束的 / 挂着等你定的拒', async () => {
    const s = await ready()
    await expect(s.panel.act({ action: 'archive', task: 'L1118-1' } as any)).rejects.toThrow(/没结束/)
    const r: any = await s.panel.act({ action: 'archive', task: 'L1118-2' } as any)
    expect(r).toMatchObject({ ok: true, undo: { action: 'setmarks', task: 'L1118-2', marks: { archive: null } } })
    expect(s.ids()).toEqual(['L1118-1', 'L1118-3'])
    expect(s.ids('archived')).toEqual(['L1118-2'])
    await s.panel.act({ action: 'restore', task: 'L1118-2' } as any)
    expect(s.ids()).toEqual(['L1118-1', 'L1118-2', 'L1118-3'])
    await s.core.askUser({ task: 'L1118-2', question: '还挂着', options: ['A'] })
    await expect(s.panel.act({ action: 'archive', task: 'L1118-2' } as any)).rejects.toThrow(/等你定/)
  })
  it('自动归档（结束超过 7 天）的也能恢复到列表', async () => {
    const s = await ready()
    s.clock.advance(8 * 86400_000)
    expect(s.ids('archived')).toEqual(['L1118-2'])
    await s.panel.act({ action: 'restore', task: 'L1118-2' } as any)
    expect(s.ids('archived')).toEqual([])
    expect(s.ids()).toContain('L1118-2')
  })
  it('Focus + 收起：收起优先；Focus + 归档：归档优先，恢复后 Focus 还在；卡片带 focus / hidden / archivedManual', async () => {
    const s = await ready()
    await s.panel.act({ action: 'focus', task: 'L1118-1', on: true }); await s.panel.act({ action: 'hide', task: 'L1118-1' } as any)
    expect(s.ids()).not.toContain('L1118-1')
    expect(s.panel.state({ view: 'hidden' }).tasks.find((t: any) => t.id === 'L1118-1')).toMatchObject({ focus: true, hidden: true })
    await s.panel.act({ action: 'focus', task: 'L1118-2', on: true }); await s.panel.act({ action: 'archive', task: 'L1118-2' } as any)
    expect(s.ids()).not.toContain('L1118-2')
    expect(s.panel.state({ view: 'archived' }).tasks.find((t: any) => t.id === 'L1118-2')).toMatchObject({ focus: true, archivedManual: true })
    await s.panel.act({ action: 'restore', task: 'L1118-2' } as any)
    expect(s.panel.state({}).tasks.find((t: any) => t.id === 'L1118-2')).toMatchObject({ focus: true })
  })
  it('接口解析：四个动作认，task 格式不对拒', () => {
    for (const a of ['hide', 'unhide', 'archive', 'restore']) expect(parseAction({ action: a, task: 'L1118-1' })).toEqual({ action: a, task: 'L1118-1' })
    expect(parseAction({ action: 'hide', task: '../x' })).toMatchObject({ error: expect.any(String) })
  })
})

describe('G14 审稿 SHOULD 3：撤销要退回原样（断言撤销后的状态）', () => {
  it('归档后撤销 ⇒ 回到列表，而且结束 7 天后照样自动归档（不能留下「恢复过」）', async () => {
    const s = await ready()
    const r: any = await s.panel.act({ action: 'archive', task: 'L1118-2' } as any)
    await s.panel.act(r.undo)
    expect(s.ids()).toContain('L1118-2')
    s.clock.advance(8 * 86400_000)
    expect(s.ids('archived')).toEqual(['L1118-2'])
  })
  it('恢复自动归档的再撤销 ⇒ 回到已归档', async () => {
    const s = await ready()
    s.clock.advance(8 * 86400_000)
    const r: any = await s.panel.act({ action: 'restore', task: 'L1118-2' } as any)
    expect(s.ids('archived')).toEqual([])
    await s.panel.act(r.undo)
    expect(s.ids('archived')).toEqual(['L1118-2'])
  })
  it('收起后撤销 ⇒ 回到列表；再收起照常', async () => {
    const s = await ready()
    const r: any = await s.panel.act({ action: 'hide', task: 'L1118-1' } as any)
    await s.panel.act(r.undo)
    expect(s.ids('hidden')).toEqual([])
    await s.panel.act({ action: 'hide', task: 'L1118-1' } as any)
    expect(s.ids('hidden')).toEqual(['L1118-1'])
  })
})

describe('G14 复核 SHOULD：setmarks 设归档标记也要过「已结束、没挂等你定」两条检查', () => {
  const ISO = '2026-11-18T19:30:00+08:00'
  it('没结束的任务 ⇒ setmarks 归档被拒', async () => {
    const s = await ready()
    await expect(s.panel.act({ action: 'setmarks', task: 'L1118-1', marks: { hide: null, archive: ISO, restore: null } } as any)).rejects.toThrow(/没结束/)
    expect(s.ids('archived')).toEqual([])
  })
  it('挂着等你定的 ⇒ setmarks 归档被拒（等你定不能被藏起来）', async () => {
    const s = await ready()
    await s.core.askUser({ task: 'L1118-2', question: '还挂着', options: ['A'] })
    await expect(s.panel.act({ action: 'setmarks', task: 'L1118-2', marks: { hide: null, archive: ISO, restore: null } } as any)).rejects.toThrow(/等你定/)
  })
  it('撤销「恢复」把手动归档写回 ⇒ 已结束、没挂等你定时照常可以', async () => {
    const s = await ready()
    await s.panel.act({ action: 'archive', task: 'L1118-2' } as any)
    const r: any = await s.panel.act({ action: 'restore', task: 'L1118-2' } as any)
    await s.panel.act(r.undo)
    expect(s.ids('archived')).toEqual(['L1118-2'])
  })
})
