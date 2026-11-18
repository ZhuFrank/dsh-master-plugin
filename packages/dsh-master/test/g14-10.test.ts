/**
 * G14 ⑩ 任务叫法（照 Claude Code 看板 T020 的规则）：只有看板上能改（Frank）；
 * 规则：4–20 字、不能有换行和 markdown 符号、不能含任务 / 等你定编号、和别的任务现在的叫法不重名也不互为子串（不分大小写）、空 = 恢复原标题；
 * 改了 ⇒ 总管和负责成员各收一条 inject；之后插件发给会话的消息里任务写成「T018（你叫它：…）」；历史只追加（task/alias 事件）。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID, validateAlias } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { PanelService, type PanelPort, type TurnText } from '../src/panel-service.ts'
import { validateAction } from '../src/panel-api.ts'
import { Attribution } from '../src/attrib.ts'
import { Patrol } from '../src/patrol.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

class FakePanelPort implements PanelPort {
  async promptUser() {}
  async turnText(_s: string, _t: number): Promise<TurnText | undefined> { return undefined }
}
const flush = () => new Promise(r => setImmediate(r))
async function ready() {
  const dir = tmpdir('g14-10'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const dport = new FakeDeliveryPort()
  const core = new Core(store, new Delivery(store, dport, clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, mem, timer: () => () => {} })
  const panel = new PanelService(store, core, new Attribution(store, core, clock), new FakePanelPort(), clock)
  await core.ensureMaster(tmpdir('m'))
  await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  await core.dispatch({ task: 'L1118-1', kind: 'light', title: '整理脚本', to: 'a', text: '做' }, MASTER_ID)
  await core.dispatch({ task: 'L1118-2', kind: 'light', title: '改 README', to: 'a', text: '做' }, MASTER_ID)
  await flush(); dport.calls.length = 0
  return { clock, store, dport, core, panel }
}

describe('G14 ⑩ 叫法规则 validateAlias', () => {
  const others = ['下载整理', '每周发布打包流程']
  it('合法的去掉首尾空白；空 = 恢复原标题', () => {
    expect(validateAlias('  说明书改版  ', others)).toBe('说明书改版')
    expect(validateAlias('', others)).toBe('')
  })
  it('长度、换行、markdown 符号、编号、撞名、互为子串都拒', () => {
    for (const bad of ['短', '一二三四五六七八九十一二三四五六七八九十多', '两行\n标题', '加粗**标题', '链接[x]', 'T018 的活', '看 Q1118-2', '下载整理', '下载整理二期', '发布打包', 'ＤＯＷＮ下载整理'])
      expect(() => validateAlias(bad, others), bad).toThrow()
  })
})

describe('G14 ⑩ 看板改叫法', () => {
  it('改了：卡片带 alias；总管和负责成员各收一条 inject；历史事件；undo 是改回旧叫法', async () => {
    const s = await ready()
    const r: any = await s.panel.act({ action: 'alias', task: 'L1118-1', alias: '下载整理' } as any); await flush()
    expect(r).toMatchObject({ ok: true, alias: '下载整理', undo: { action: 'alias', task: 'L1118-1', alias: '' } })
    expect(s.panel.state({}).tasks.find((t: any) => t.id === 'L1118-1')).toMatchObject({ alias: '下载整理', title: '整理脚本' })
    const notes = s.dport.calls.filter(c => c.text.includes('下载整理'))
    expect(notes.map(c => [c.to, c.mode]).sort()).toEqual([['exec-a', 'inject'], [MASTER_ID, 'inject']])
    expect(s.store.events({ type: 'task/alias' }).map(e => JSON.parse(e.data))).toEqual([expect.objectContaining({ old: null, new: '下载整理' })])
    await expect(s.panel.act({ action: 'alias', task: 'L1118-2', alias: '下载整理' } as any)).rejects.toThrow(/重名|子串/)
  })
  it('之后插件发给会话的消息里写「L1118-1（你叫它：下载整理）」：派活 / 发话、巡检报告、压缩后提醒', async () => {
    const s = await ready()
    await s.panel.act({ action: 'alias', task: 'L1118-1', alias: '下载整理' } as any); await flush(); s.dport.calls.length = 0
    await s.core.send({ to: 'a', task: 'L1118-1', text: '顺便看下 L1118-1 的测试' }, MASTER_ID); await flush()
    expect(s.dport.calls.filter(c => c.to === 'exec-a').at(-1)!.text).toContain('L1118-1（你叫它：下载整理）')
    const p = new Patrol(s.store, s.core, undefined, s.clock, { stallMs: 1e12, longRunMs: 1e12 })
    p.findings = () => [{ key: 'x:1', text: 'exec-a 的 L1118-1[进行中] 已经 200 分钟没有回报' }]
    p.tick(); await flush()
    expect(s.dport.calls.filter(c => c.to === MASTER_ID).at(-1)!.text).toContain('L1118-1（你叫它：下载整理）')
    s.core.onCompaction('exec-a', '1'); await flush()
    expect(s.dport.calls.filter(c => c.to === 'exec-a').at(-1)!.text).toContain('L1118-1（你叫它：下载整理）')
  })
  it('接口解析：alias 动作认，超长拒', () => {
    expect(validateAction({ action: 'alias', task: 'L1118-1', alias: '下载整理' })).toEqual({ action: 'alias', task: 'L1118-1', alias: '下载整理' })
    expect(validateAction({ action: 'alias', task: 'L1118-1', alias: 'x'.repeat(300) })).toMatchObject({ error: expect.any(String) })
  })
})

describe('G14 审稿 SHOULD 4：叫法标注不碰路径里的编号；叫法里的 $ 原样', () => {
  it('tasks/L1118-1.md、L1118-1.log 不改；正文里的编号照标', async () => {
    const s = await ready()
    await s.panel.act({ action: 'alias', task: 'L1118-1', alias: '下载整理' } as any)
    const t = s.core.annotateTasks('任务书在 tasks/L1118-1.md，日志 L1118-1.log；L1118-1 还没结')
    expect(t).toBe('任务书在 tasks/L1118-1.md，日志 L1118-1.log；L1118-1（你叫它：下载整理） 还没结')
  })
  it('叫法里有 $& / $1 ⇒ 原样写进去，不被当成替换模板', async () => {
    const s = await ready()
    await s.panel.act({ action: 'alias', task: 'L1118-1', alias: '省$&钱方案' } as any)
    expect(s.core.annotateTasks('看 L1118-1')).toBe('看 L1118-1（你叫它：省$&钱方案）')
  })
})
