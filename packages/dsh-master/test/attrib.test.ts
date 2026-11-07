import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { Attribution } from '../src/attrib.ts'
import { scanUserText, rewriteTaskLinks, decodeSessionRef, decideTurn, relayTask, taskBrief, LAYER, NOTICE_HEAD, PEER_REMINDER } from '../src/mentions.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

const sref = (id: string) => `dsh-session:${Buffer.from(JSON.stringify(id)).toString('base64url')}`
const userMsg = (text: string) => ({ id: `u-${Math.random()}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const textOf = (m: any) => m.content.map((c: any) => c.text).join('')

describe('mentions · 识别', () => {
  const exists = (id: string) => ['T005', 'L1103-1'].includes(id)
  it('引用块、手打 @、正文裸写：只认存在的任务号；已 @ 的不再算「正文提到」', () => {
    const sc = scanUserText('看 @[T005 插件](dsh-master-task:T005) 和 @L1103-1，还有 T005、T999、@T998，以及 L1103-1。路径 /x/T005 和 a-T005 不算', exists)
    expect(sc.atTasks.sort()).toEqual(['L1103-1', 'T005'])
    expect(sc.textTasks).toEqual([])
    expect(scanUserText('只是提到 T005 进度', exists)).toEqual({ atTasks: [], sessions: [], textTasks: ['T005'] })
    expect(scanUserText('@T999 不存在', exists).atTasks).toEqual([])
    expect(scanUserText('邮箱 a@T005 不是 @', exists).atTasks).toEqual([])
  })
  it('@会话：解出会话 ID；不规范的载荷丢掉', () => {
    expect(scanUserText(`问下 @[执行 W](${sref('exec-w')}) 做到哪了`, exists).sessions).toEqual(['exec-w'])
    expect(decodeSessionRef('InNiIg')).toBe('sb')
    expect(decodeSessionRef('not-json')).toBeUndefined()
    expect(decodeSessionRef(Buffer.from('123').toString('base64url'))).toBeUndefined() // 不是字符串
  })
  it('rewriteTaskLinks / relayTask', () => {
    expect(rewriteTaskLinks('看 @[T005 插件](dsh-master-task:T005) 吧')).toBe('看 @T005 吧')
    expect(relayTask('[dsh-master 消息 · 来自 master · 发给 exec-w · L1103-1 · 派活 · 2026-11-03 2108]（消息键 x）')).toBe('L1103-1')
    expect(relayTask('[dsh-master 消息 · 来自 master · 发给 exec-w · - · 消息 · 2026]')).toBeUndefined()
  })
  it('decideTurn：非 maybe 里层级最小的当主任务；同任务取最强；maybe 不当主', () => {
    const d = decideTurn([{ task: 'A', layer: 2, reason: '' }, { task: 'B', layer: 1, reason: '' }, { task: 'A', layer: 5, reason: '' }, { task: 'C', layer: 4, reason: '' }])
    expect(d.primary?.task).toBe('B'); expect(d.also.map(x => x.task)).toEqual(['A']); expect(d.maybe.map(x => x.task)).toEqual(['C'])
    expect(decideTurn([{ task: 'C', layer: 4, reason: '' }]).primary).toBeUndefined()
  })
  it('taskBrief ≤2KB，含最近 3 条回报和未答等你定', () => {
    const b = taskBrief({ id: 'T005', title: 'x'.repeat(500), state: '进行中', gate: 'G4c', owner: 'exec-p' },
      Array.from({ length: 6 }, (_, i) => ({ at: `11-03 21${i}0`, line: `回报 ${i} ` + 'y'.repeat(400) })), [{ id: 7, question: '选哪个？' }])
    expect(b.length).toBeLessThanOrEqual(2000)
    expect(b).toContain('回报 5'); expect(b).not.toContain('回报 2'); expect(b).toContain('#7 选哪个？')
  })
})

function setup() {
  const dir = tmpdir('attrib'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 1000, tag: (c, a) => attrib.tag(c, a) })
  const attrib: Attribution = new Attribution(store, core, clock)
  return { store, core, attrib, clock }
}
describe('Attribution · 四层归属 + 兜底', () => {
  let s: ReturnType<typeof setup>
  beforeEach(async () => {
    s = setup(); await s.core.ensureMaster(tmpdir('m'))
    await s.core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
    await s.core.spawn({ name: 'b', cwd: tmpdir('b'), title: 'B' }, MASTER_ID)
    await s.core.dispatch({ task: 'L1103-1', kind: 'light', title: '一号', to: 'a', text: '做' }, MASTER_ID)
    await s.core.dispatch({ task: 'L1103-2', kind: 'light', title: '二号', to: 'b', text: '做' }, MASTER_ID)
    await s.core.dispatch({ task: 'L1103-3', kind: 'light', title: '三号', to: 'b', text: '做' }, MASTER_ID)
    await s.core.report({ task: 'L1103-1', state: '进展', action: '做到一半了' }, 'exec-a')
  })
  const primary = (session: string, turn: number) => s.attrib.turnsOf(session).find(x => x.turn === turn)?.primary

  it('第 1 层 @任务：归属 + 引用块改写成 @T + 附上任务摘要（标明不是用户说的）', () => {
    const r = s.attrib.processStep(MASTER_ID, 1, [userMsg('看看 @[L1103-1 一号](dsh-master-task:L1103-1) 怎么样')])
    expect(primary(MASTER_ID, 1)).toMatchObject({ task: 'L1103-1', layer: LAYER.AT_TASK })
    expect(textOf(r.messages[0])).toBe('看看 @L1103-1 怎么样')
    const note = textOf(r.messages.at(-1))
    expect(note.startsWith(NOTICE_HEAD)).toBe(true)
    expect(note).toContain('L1103-1 一号｜状态 进行中'); expect(note).toContain('做到一半了')
    expect(r.messages.at(-1).source).toMatchObject({ kind: 'dsh-master', form: 'notice' })
  })
  it('手打的 @L1103-1 也算第 1 层；不存在的 @L9999-9 不算、也不附摘要', () => {
    s.attrib.processStep(MASTER_ID, 2, [userMsg('@L1103-1 进度？')])
    expect(primary(MASTER_ID, 2)).toMatchObject({ task: 'L1103-1', layer: LAYER.AT_TASK })
    const r = s.attrib.processStep(MASTER_ID, 3, [userMsg('@L9999-9 进度？')])
    expect(s.attrib.turnsOf(MASTER_ID).find(x => x.turn === 3)).toBeUndefined()
    expect(r.changed).toBe(false)
  })
  it('看板上回答等你定：原文写成 @任务，这一轮算第 1 层（不是「可能相关」）', () => {
    s.attrib.processStep(MASTER_ID, 20, [userMsg('【来自看板｜回答等你定 #1（@L1103-1）】\n问题：A 还是 B？\n回答：B')])
    expect(primary(MASTER_ID, 20)).toMatchObject({ task: 'L1103-1', layer: LAYER.AT_TASK })
  })
  it('第 2 层：工具调用带任务号；插件转来的消息带任务号', () => {
    s.attrib.processStep(MASTER_ID, 4, [userMsg('随便聊聊')])
    s.attrib.onTool(MASTER_ID, 'master_send', { task: 'L1103-2', to: 'b', text: 'x' })
    expect(primary(MASTER_ID, 4)).toMatchObject({ task: 'L1103-2', layer: LAYER.TOOL })
    s.attrib.processStep('exec-a', 1, [{ role: 'user', source: { kind: 'dsh-master', form: 'relay' }, content: [{ type: 'text', text: '[dsh-master 消息 · 来自 master · 发给 exec-a · L1103-1 · 派活 · 2026-11-03 2108]（消息键 k）\n派活' }] }])
    expect(primary('exec-a', 1)).toMatchObject({ task: 'L1103-1', layer: LAYER.TOOL })
  })
  it('第 3 层：总管会话里 @执行会话 且它恰好 1 个在途任务；有 2 个时只附状态不归属', () => {
    const r = s.attrib.processStep(MASTER_ID, 5, [userMsg(`@[执行 A](${sref('exec-a')}) 做到哪了？`)])
    expect(primary(MASTER_ID, 5)).toMatchObject({ task: 'L1103-1', layer: LAYER.AT_EXEC })
    const note = textOf(r.messages.at(-1))
    expect(note).toContain('宿主附的快照里看不到回报'); expect(note).toContain('exec-a（A）：在途任务 L1103-1'); expect(note).toContain('做到一半了')
    const r2 = s.attrib.processStep(MASTER_ID, 6, [userMsg(`@[执行 B](${sref('exec-b')}) 呢？`)])
    expect(s.attrib.turnsOf(MASTER_ID).find(x => x.turn === 6)).toBeUndefined()
    expect(textOf(r2.messages.at(-1))).toContain('在途任务 L1103-2、L1103-3')
  })
  it('@执行会话 而它没有在途任务：附最近 1 个已结束任务的摘要（含回报）', async () => {
    await s.core.report({ task: 'L1103-1', state: '完成', action: '交付了 add()，自测 3/3' }, 'exec-a') // 轻任务回报「完成」即结案
    expect(s.store.getTask('L1103-1')!.state).toBe('完成')
    const r = s.attrib.processStep(MASTER_ID, 30, [userMsg(`@[执行 A](${sref('exec-a')}) 最近干了什么？`)])
    const note = textOf(r.messages.at(-1))
    expect(note).toContain('exec-a（A）：在途任务 无')
    expect(note).toContain('最近一个已结束的任务：'); expect(note).toContain('L1103-1 一号｜状态 完成'); expect(note).toContain('自测 3/3')
    expect(s.attrib.turnsOf(MASTER_ID).find(x => x.turn === 30)).toBeUndefined() // 没有在途，不归属
  })
  it('第 4 层：正文提到只算「可能相关」，不当主任务；有更硬的信号时主任务取更硬的', () => {
    s.attrib.processStep(MASTER_ID, 7, [userMsg('L1103-2 那个先放放，@L1103-1 继续')])
    const t = s.attrib.turnsOf(MASTER_ID).find(x => x.turn === 7)!
    expect(t.primary).toMatchObject({ task: 'L1103-1', layer: LAYER.AT_TASK }); expect(t.maybe).toEqual(['L1103-2'])
  })
  it('兜底 master_tag：只有总管能用；任务要存在；层级最弱，不改已有的硬归属', async () => {
    const tag = s.core.toolsFor(MASTER_ID).find(t => t.name === 'master_tag')!
    expect(s.core.toolsFor('exec-a').some(t => t.name === 'master_tag')).toBe(false)
    s.attrib.processStep(MASTER_ID, 8, [userMsg('嗯')])
    await tag.run({ turn: 8, task: 'L1103-3' }, MASTER_ID)
    expect(primary(MASTER_ID, 8)).toMatchObject({ task: 'L1103-3', layer: LAYER.TAG })
    await expect(tag.run({ turn: 8, task: 'L9999-1' }, MASTER_ID)).rejects.toThrow(/没有任务/)
    await expect(tag.run({ turn: 0, task: 'L1103-3' }, MASTER_ID)).rejects.toThrow(/正整数/)
    await expect(Promise.resolve().then(() => s.attrib.tag('exec-a', { turn: 8, task: 'L1103-3' }))).rejects.toThrow(/只有总管/)
    s.attrib.processStep(MASTER_ID, 9, [userMsg('@L1103-1')]); await tag.run({ turn: 9, task: 'L1103-3' }, MASTER_ID)
    const t9 = s.attrib.turnsOf(MASTER_ID).find(x => x.turn === 9)!
    expect(t9.primary?.task).toBe('L1103-1'); expect(t9.also).toEqual(['L1103-3'])
  })
  it('执行会话里 @ 别的执行会话 ⇒ 提醒「不直接协作，回报总管」，不归属、不拦（消息照样进模型）', () => {
    const msg = userMsg(`你去问下 @[执行 B](${sref('exec-b')})`)
    const r = s.attrib.processStep('exec-a', 2, [msg])
    expect(r.messages[0]).toBe(msg)
    expect(textOf(r.messages.at(-1))).toContain(PEER_REMINDER)
    expect(s.attrib.turnsOf('exec-a').find(x => x.turn === 2)).toBeUndefined()
    expect(s.store.events({ type: 'mention/exec-peer' })).toHaveLength(1)
  })
  it('不在花名册的会话：什么都不做', () => {
    const msg = userMsg('@L1103-1 ?')
    const r = s.attrib.processStep('random-session', 1, [msg])
    expect(r).toEqual({ messages: [msg], changed: false })
    expect(s.attrib.candidatesFor('random-session')).toEqual([])
  })
  it('@ 菜单候选：总管看全部未结 + 近 7 天；执行会话只看派给自己的', async () => {
    expect(s.attrib.candidatesFor(MASTER_ID).map(t => t.id)).toEqual(['L1103-1', 'L1103-2', 'L1103-3'])
    expect(s.attrib.candidatesFor('exec-b').map(t => t.id)).toEqual(['L1103-2', 'L1103-3'])
    expect(s.attrib.candidatesFor('exec-a').map(t => t.id)).toEqual(['L1103-1'])
    s.core.userCloseTask('L1103-2', '完成'); s.clock.advance(8 * 24 * 3600_000)
    expect(s.attrib.candidatesFor(MASTER_ID).map(t => t.id)).toEqual(['L1103-1', 'L1103-3'])
  })
  it('时间线：轮次带依据和摘句；一轮的主任务 / 也提到 / 可能相关分得清', () => {
    s.attrib.processStep(MASTER_ID, 10, [userMsg('@[L1103-1 一号](dsh-master-task:L1103-1) 和 L1103-2 一起看')])
    expect(s.attrib.turnsForTask('L1103-1')).toMatchObject([{ session: MASTER_ID, turn: 10, role: 'primary', why: '@任务', excerpt: '@L1103-1 和 L1103-2 一起看' }])
    expect(s.attrib.turnsForTask('L1103-2')).toMatchObject([{ turn: 10, role: 'maybe', why: '正文提到（可能相关）' }])
  })
})
