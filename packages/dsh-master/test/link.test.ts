import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { Patrol } from '../src/patrol.ts'
import { PanelService } from '../src/panel-service.ts'
import { Attribution } from '../src/attrib.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

async function setup() {
  const dir = tmpdir('link'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 1000, mem })
  await core.ensureMaster(tmpdir('m'))
  await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  for (const [t, title] of [['L1104-1', '贪吃蛇加暂停'], ['L1104-2', '贪吃蛇换皮肤'], ['L1104-3', 'hello 脚本']]) await core.dispatch({ task: t, kind: 'light', title, to: 'a', text: '做' }, MASTER_ID)
  const dl = (slug: string, task: string, tags: string[]) => { clock.advance(60_000); mem.devlogAdd({ slug, hook: slug, tags, task, files_touched: [`/w/${slug}.dat`], depth: '琐碎', no_related_reason: '测试', sections: { 改了什么: 'x' } }) }
  dl('snake-pause', 'L1104-1', ['snake', 'pause', '单文件', 'html'])
  dl('snake-skin', 'L1104-2', ['snake', 'skin', '单文件', 'html'])
  dl('hello-cli', 'L1104-3', ['hello.py', 'argparse', '单文件', 'html'])
  const patrol = new Patrol(store, core, mem, clock, { stallMs: 99 * 3600_000, longRunMs: 99 * 3600_000 })
  return { clock, store, mem, core, patrol }
}
const links = (p: Patrol) => p.findings().filter(f => f.key.startsWith('link:'))

describe('G5-E ⑥ 跨任务关联：巡检报候选，总管确认后两边时间线各留一条', () => {
  it('巡检只报真有共同具体标签的一对（单文件 / html 不算）', async () => {
    const s = await setup()
    const f = links(s.patrol)
    expect(f).toHaveLength(1)
    expect(f[0]!.text).toMatch(/跨任务关联候选：L1104-1 ↔ L1104-2（共同标签 「snake」/)
    expect(f[0]!.text).toContain('master_link')
  })
  it('master_link：两边各一条 task/linked；之后巡检不再报；重复连不再写', async () => {
    const s = await setup()
    const [tool] = s.core.toolsFor(MASTER_ID).filter(t => t.name === 'master_link')
    expect(await tool!.run({ task: 'L1104-1', with: 'l1104-2', why: '都在改贪吃蛇' }, MASTER_ID)).toEqual({ task: 'L1104-1', with: 'L1104-2', linked: true })
    const ev = (t: string) => s.store.events({ task: t, type: 'task/linked' }).map(e => JSON.parse(e.data))
    expect(ev('L1104-1')).toEqual([{ with: 'L1104-2', why: '都在改贪吃蛇', by: MASTER_ID }])
    expect(ev('L1104-2')).toEqual([{ with: 'L1104-1', why: '都在改贪吃蛇', by: MASTER_ID }])
    expect(links(s.patrol)).toEqual([])
    expect(await tool!.run({ task: 'L1104-2', with: 'L1104-1', why: '再连一次' }, MASTER_ID)).toMatchObject({ linked: false, already: true })
    expect(ev('L1104-1')).toHaveLength(1)
    await expect(tool!.run({ task: 'L1104-1', with: 'L9999-9', why: 'x' }, MASTER_ID)).rejects.toThrow(/没有任务/)
    await expect(tool!.run({ task: 'L1104-1', with: 'L1104-1', why: 'x' }, MASTER_ID)).rejects.toThrow(/自己/)
    await expect(tool!.run({ task: 'L1104-1', with: 'L1104-3', why: ' ' }, MASTER_ID)).rejects.toThrow(/why/)
    // 时间线里看得到（带编号）
    const th = new PanelService(s.store, s.core, new Attribution(s.store, s.core, s.clock), { promptUser: async () => {}, turnText: async () => null } as any, s.clock).thread('L1104-2')
    expect(th.items.filter((x: any) => x.type === 'task/linked').map((x: any) => [x.data.with, typeof x.no])).toEqual([['L1104-1', 'number']])
  })
  it('执行会话没有 master_link', async () => {
    const s = await setup()
    expect(s.core.toolsFor('exec-a').some(t => t.name === 'master_link')).toBe(false)
  })
  it('已结任务：最近 7 天还有条目才参与', async () => {
    const s = await setup()
    s.core.userCloseTask('L1104-2', '完成')
    expect(links(s.patrol)).toHaveLength(1)
    s.clock.advance(8 * 86400_000)
    expect(links(s.patrol)).toEqual([])
  })
})
