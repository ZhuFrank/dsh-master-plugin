/**
 * G14 ⑤ 跟进提醒存进库（分析 #23，照 T019 建议 1「承诺落库」）：
 * master_remind(at, text, task?) / master_reminders / master_remind_cancel，只给总管；
 * 到点给总管投 followup（叫醒）；实例没开 / 暂停中错过的，下一次补投并写明晚了多久；状态栏显示下次提醒。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { PanelService, type PanelPort, type TurnText } from '../src/panel-service.ts'
import { Attribution } from '../src/attrib.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

class FakePanelPort implements PanelPort {
  async promptUser() {}
  async turnText(_s: string, _t: number): Promise<TurnText | undefined> { return undefined }
}
const flush = () => new Promise(r => setImmediate(r))
async function ready(file?: string) {
  const dir = tmpdir('g14-5'); const clock = fakeClock()
  const store = new Store(file ?? path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const dport = new FakeDeliveryPort()
  const core = new Core(store, new Delivery(store, dport, clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, mem, timer: () => () => {} })
  const panel = new PanelService(store, core, new Attribution(store, core, clock), new FakePanelPort(), clock)
  await core.ensureMaster(tmpdir('m'))
  await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  const tool = (caller: string, name: string) => { const t = core.toolsFor(caller).find(x => x.name === name); if (!t) throw new Error(`${caller} 没有 ${name}`); return (a: unknown) => t.run(a, caller) }
  await flush(); dport.calls.length = 0
  return { clock, store, dport, core, panel, tool }
}
const toMaster = (s: Awaited<ReturnType<typeof ready>>) => s.dport.calls.filter(c => c.to === MASTER_ID)

describe('G14 ⑤ master_remind', () => {
  it('只有总管有这三个工具', async () => {
    const s = await ready()
    for (const n of ['master_remind', 'master_reminders', 'master_remind_cancel']) {
      expect(s.core.toolsFor(MASTER_ID).map(t => t.name)).toContain(n)
      expect(s.core.toolsFor('exec-a').map(t => t.name)).not.toContain(n)
    }
  })
  it('相对时间「2h」：没到不投；到点投一条 followup 给总管，带任务和原话；只投一次', async () => {
    const s = await ready()
    const r: any = await s.tool(MASTER_ID, 'master_remind')({ at: '2h', text: '核一下 T021 的市场条目刷新了没有', task: 'T021' })
    expect(r).toMatchObject({ id: expect.any(Number), state: 'pending' })
    s.clock.advance(119 * 60_000); s.core.fireReminders(); await flush()
    expect(toMaster(s)).toHaveLength(0)
    s.clock.advance(2 * 60_000); s.core.fireReminders(); s.core.fireReminders(); await flush()
    expect(toMaster(s)).toHaveLength(1)
    expect(toMaster(s)[0]!.mode).toBe('followup')
    expect(toMaster(s)[0]!.text).toMatch(/到点提醒[\s\S]*T021[\s\S]*核一下 T021 的市场条目刷新了没有/)
    expect(((await s.tool(MASTER_ID, 'master_reminders')({})) as any).reminders.map((x: any) => x.state)).toEqual(['done'])
    expect(s.panel.statusBar({ waitingCount: 0 }).nextReminder).toBeNull()
  })
  it('绝对时间（北京时间）也认；过去的时间、看不懂的格式报错', async () => {
    const s = await ready()
    const { bjtIso } = await import('../src/time.ts')
    const later = bjtIso(s.clock() + 3 * 86400_000).slice(0, 16).replace('T', ' ')
    expect(await s.tool(MASTER_ID, 'master_remind')({ at: later, text: 'x' })).toMatchObject({ state: 'pending' })
    await expect(s.tool(MASTER_ID, 'master_remind')({ at: '2020-01-01 10:00', text: 'x' })).rejects.toThrow(/已经过去/)
    await expect(s.tool(MASTER_ID, 'master_remind')({ at: '下周', text: 'x' })).rejects.toThrow(/at/)
  })
  it('错过的（实例没开）重启后补投，写明晚了多久；取消的不投', async () => {
    const dir = tmpdir('g14-5r'); const file = path.join(dir, 'master.db')
    const s = await ready(file)
    const a: any = await s.tool(MASTER_ID, 'master_remind')({ at: '1h', text: '第一件' })
    const b: any = await s.tool(MASTER_ID, 'master_remind')({ at: '1h', text: '第二件' })
    expect(await s.tool(MASTER_ID, 'master_remind_cancel')({ id: b.id })).toMatchObject({ state: 'cancelled' })
    s.clock.advance(3 * 3600_000); s.core.fireReminders(); await flush()
    const t = toMaster(s).map(c => c.text)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatch(/第一件[\s\S]*晚了 120 分钟/)
    const list: any = await s.tool(MASTER_ID, 'master_reminders')({})
    expect(list.reminders.map((x: any) => [x.id, x.state])).toEqual([[a.id, 'done'], [b.id, 'cancelled']])
  })
  it('状态栏：下次提醒的时间和内容', async () => {
    const s = await ready()
    expect(s.panel.statusBar({ waitingCount: 0 }).nextReminder).toBeNull()
    await s.tool(MASTER_ID, 'master_remind')({ at: '3h', text: '晚一点的' })
    await s.tool(MASTER_ID, 'master_remind')({ at: '1h', text: '早一点的' })
    expect(s.panel.statusBar({ waitingCount: 0 }).nextReminder).toMatchObject({ text: '早一点的' })
  })
})

describe('G14 审稿 SHOULD 6：绝对时间校验月日时分', () => {
  it('2027-02-30、2027-13-01、2027-04-31、25:00、10:61 都报错，不悄悄顺延；2028-02-29（闰年）可以', async () => {
    const s = await ready()
    for (const bad of ['2027-02-30 10:00', '2027-13-01 10:00', '2027-04-31 10:00', '2027-05-01 25:00', '2027-05-01 10:61'])
      await expect(s.tool(MASTER_ID, 'master_remind')({ at: bad, text: 'x' }), bad).rejects.toThrow(/不存在|看不懂/)
    expect(await s.tool(MASTER_ID, 'master_remind')({ at: '2028-02-29 09:30', text: 'x' })).toMatchObject({ at: expect.stringMatching(/^2028-02-29 0930/) })
  })
})
