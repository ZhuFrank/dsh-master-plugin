/**
 * G11-1 消息直送（L1107-2 方案 §2.3 第 1–4、6 条；第 5 条选 A，保留「用户直接指示」inject 不改）：
 * ① 用户在成员会话里开的那一轮，结束时不发「空闲提醒」叫醒总管（只记 reminder/user-turn）；派活开的照旧提醒；
 * ② 看板「回答等你定」直接投给这件任务的负责成员，总管只留记录；负责人是总管 / 没有负责人 / 已关闭 ⇒ 照旧发给总管；
 * ③ 任务卡片带 talkTo：看板「在对话里提到」打开谁；
 * ④ 成员守则「用户直接找你时」；
 * ⑤ 巡检「直接对话」发现：改了结论 / 对外动作或叫停关键词 / 30 分钟没回（会话 running 不算）/ 已关闭的会话。
 * directToMember: false ⇒ 全部回到旧行为。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID, type CoreOptions } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { PanelService, type PanelPort, type TurnText } from '../src/panel-service.ts'
import { Attribution } from '../src/attrib.ts'
import { Patrol } from '../src/patrol.ts'
import { rolePrompt } from '../src/prompts.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

class FakePanelPort implements PanelPort {
  prompts: Array<{ sessionId: string; content: any[] }> = []
  async promptUser(sessionId: string, _r: string, content: any[]) { this.prompts.push({ sessionId, content }) }
  async turnText(_s: string, _t: number): Promise<TurnText | undefined> { return undefined }
}

function setup(opts: Partial<CoreOptions> = {}) {
  const dir = tmpdir('g11'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const dport = new FakeDeliveryPort(); const sport = new FakeSessionPort()
  const timers: Array<{ fn: () => void; at: number }> = []
  const core = new Core(store, new Delivery(store, dport, clock), sport, clock, {
    idleGraceMs: 2000, mem, timer: (fn, ms) => { const t = { fn, at: clock() + ms }; timers.push(t); return () => { timers.splice(timers.indexOf(t), 1) } }, ...opts,
  })
  const runTimers = async () => { const due = timers.filter(t => t.at <= clock()); for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn() } await new Promise(r => setTimeout(r, 5)) }
  const pport = new FakePanelPort()
  const panel = new PanelService(store, core, new Attribution(store, core, clock), pport, clock)
  const patrol = new Patrol(store, core, mem, clock, { stallMs: 10 * 3600_000, longRunMs: 10 * 3600_000 })
  return { dir, clock, store, dport, sport, core, runTimers, pport, panel, patrol }
}
const flush = () => new Promise(r => setImmediate(r))
const toMaster = (s: ReturnType<typeof setup>) => s.dport.calls.filter(c => c.to === MASTER_ID)
async function ready(opts: Partial<CoreOptions> = {}) {
  const s = setup(opts); await s.core.ensureMaster(tmpdir('m'))
  await s.core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  await s.core.dispatch({ task: 'L1107-9', kind: 'light', title: '小活', to: 'a', text: '做' }, MASTER_ID)
  await flush(); s.dport.calls.length = 0
  s.sport.lastText.set('exec-a', '这是回答')
  return s
}

describe('G11-1 ① 用户开的那一轮不发空闲提醒', () => {
  it('用户先说话、再开始跑 ⇒ 一轮结束不回报也不叫醒总管（只有那条 inject）；记 reminder/user-turn', async () => {
    const s = await ready()
    s.core.onUserMessage('exec-a', 'u1', '这个文件在哪？')
    s.core.onStatus('exec-a', 'running'); s.clock.advance(3000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(5000); await s.runTimers(); await flush()
    expect(toMaster(s).map(c => c.mode)).toEqual(['inject'])
    expect(toMaster(s).some(c => c.text.includes('没有用 master_report 回报'))).toBe(false)
    expect(s.store.events({ type: 'reminder/user-turn' })).toHaveLength(1)
  })
  it('先开始跑、紧接着才收到用户消息（宿主事件先后不定）也算用户开的', async () => {
    const s = await ready()
    s.core.onStatus('exec-a', 'running'); s.clock.advance(200); s.core.onUserMessage('exec-a', 'u1', '这个文件在哪？')
    s.clock.advance(3000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(5000); await s.runTimers(); await flush()
    expect(toMaster(s).some(c => c.text.includes('没有用 master_report 回报'))).toBe(false)
  })
  it('对照：派活开的一轮（没有用户消息）照旧提醒', async () => {
    const s = await ready()
    s.core.onStatus('exec-a', 'running'); s.clock.advance(3000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(5000); await s.runTimers(); await flush()
    expect(toMaster(s).filter(c => c.text.includes('没有用 master_report 回报'))).toHaveLength(1)
  })
  it('对照：派活开的一轮跑到一半用户插话（离开始很久）⇒ 这一轮不算用户开的，照旧提醒', async () => {
    const s = await ready()
    s.core.onStatus('exec-a', 'running'); s.clock.advance(60_000); s.core.onUserMessage('exec-a', 'u1', '顺便看下 README')
    s.clock.advance(3000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(5000); await s.runTimers(); await flush()
    expect(toMaster(s).filter(c => c.text.includes('没有用 master_report 回报'))).toHaveLength(1)
  })
  it('一条用户消息只认领一轮：用户问完、成员答完，紧接着（10 秒内）派活开的那一轮不回报 ⇒ 照旧提醒（g2-flow 回归抓到）', async () => {
    const s = await ready()
    s.core.onUserMessage('exec-a', 'u1', 'hello')
    s.core.onStatus('exec-a', 'running'); s.clock.advance(1000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(1000); s.core.onStatus('exec-a', 'running'); s.clock.advance(1000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(5000); await s.runTimers(); await flush()
    expect(toMaster(s).filter(c => c.text.includes('没有用 master_report 回报'))).toHaveLength(1)
    // 第一轮（用户开的）的检查到点时已经有新一轮了，按原逻辑让给新一轮判断，不记 user-turn
    expect(s.store.events({ type: 'reminder/user-turn' })).toHaveLength(0)
  })
  it('directToMember: false ⇒ 旧行为，用户开的那一轮也提醒', async () => {
    const s = await ready({ directToMember: false })
    s.core.onUserMessage('exec-a', 'u1', '这个文件在哪？')
    s.core.onStatus('exec-a', 'running'); s.clock.advance(3000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(5000); await s.runTimers(); await flush()
    expect(toMaster(s).filter(c => c.text.includes('没有用 master_report 回报'))).toHaveLength(1)
  })
})

describe('G11-1 ② 看板「回答等你定」直投负责成员', () => {
  it('负责人是在岗成员 ⇒ 投给成员（followup，带问题和回答），不 prompt 总管；时间线记一条，事件写明转给谁', async () => {
    const s = await ready()
    const { id } = await s.core.askUser({ task: 'L1107-9', question: '用 A 还是 B？', options: ['A', 'B'] })
    const r = await s.panel.act({ action: 'answer', ask: id, answer: 'B' })
    await flush()
    expect(s.pport.prompts).toHaveLength(0)
    const toA = s.dport.calls.filter(c => c.to === 'exec-a')
    expect(toA).toHaveLength(1)
    expect(toA[0]!.mode).toBe('followup')
    expect(toA[0]!.text).toMatch(/用 A 还是 B？[\s\S]*B/)
    // 给总管只留一条 inject（不叫醒；它下次醒来看得到用户答了什么、转给了谁）——巡检报告是 followup 会叫醒，不能走巡检
    expect(toMaster(s).map(c => c.mode)).toEqual(['inject'])
    expect(toMaster(s)[0]!.text).toMatch(/已直接转给 exec-a/)
    expect(r).toMatchObject({ ok: true, to: 'exec-a' })
    const ev = s.store.events({ type: 'ask/answered' }).at(-1)!
    expect(JSON.parse(ev.data)).toMatchObject({ id, answer: 'B', to: 'exec-a' })
    expect(s.panel.thread('L1107-9').items.some((it: any) => it.kind === 'message' && String(it.text ?? '').includes('回答') && String(it.text).includes('B'))).toBe(true)
  })
  it('成员收到答案后跑的那一轮不回报 ⇒ 也不发空闲提醒（e2e 第 4 次实测抓到：这一轮是用户的答案开的）', async () => {
    const s = await ready()
    const { id } = await s.core.askUser({ task: 'L1107-9', question: '用 A 还是 B？', options: ['A', 'B'] })
    await s.panel.act({ action: 'answer', ask: id, answer: 'B' }); await flush()
    s.clock.advance(500); s.core.onStatus('exec-a', 'running'); s.clock.advance(3000); s.core.onStatus('exec-a', 'idle')
    s.clock.advance(5000); await s.runTimers(); await flush()
    expect(toMaster(s).filter(c => c.text.includes('没有用 master_report 回报'))).toHaveLength(0)
    expect(s.store.events({ type: 'reminder/user-turn' })).toHaveLength(1)
  })
  it('负责人已关闭 ⇒ 照旧发给总管', async () => {
    const s = await ready()
    const { id } = await s.core.askUser({ task: 'L1107-9', question: 'Q?', options: ['A'] })
    s.store.closeSession('exec-a', new Date().toISOString())
    await s.panel.act({ action: 'answer', ask: id, answer: 'A' })
    expect(s.pport.prompts.map(p => p.sessionId)).toEqual([MASTER_ID])
  })
  it('任务的负责人是总管自己、或者没有这个任务 ⇒ 照旧发给总管', async () => {
    const s = await ready()
    s.store.db.prepare('UPDATE tasks SET owner = ? WHERE id = ?').run(MASTER_ID, 'L1107-9')
    const { id } = await s.core.askUser({ task: 'L1107-9', question: 'Q?', options: ['A'] })
    await s.panel.act({ action: 'answer', ask: id, answer: 'A' })
    const { id: id2 } = await s.core.askUser({ task: 'L9999-1', question: 'Q2?', options: ['A'] })
    await s.panel.act({ action: 'answer', ask: id2, answer: 'A' })
    expect(s.pport.prompts.map(p => p.sessionId)).toEqual([MASTER_ID, MASTER_ID])
    expect(s.dport.calls.filter(c => c.to === 'exec-a')).toHaveLength(0)
  })
  it('directToMember: false ⇒ 照旧发给总管', async () => {
    const s = await ready({ directToMember: false })
    const { id } = await s.core.askUser({ task: 'L1107-9', question: 'Q?', options: ['A'] })
    await s.panel.act({ action: 'answer', ask: id, answer: 'A' })
    expect(s.pport.prompts.map(p => p.sessionId)).toEqual([MASTER_ID])
  })
})

describe('G11-1 ③ 任务卡片 talkTo', () => {
  it('负责人在岗 ⇒ 成员；关闭后 ⇒ 总管；directToMember: false ⇒ 总管', async () => {
    const s = await ready()
    const card = () => s.panel.state({}).tasks.find((t: any) => t.id === 'L1107-9') as any
    expect(card().talkTo).toBe('exec-a')
    s.store.closeSession('exec-a', new Date().toISOString())
    expect(card().talkTo).toBe(MASTER_ID)
    const s2 = await ready({ directToMember: false })
    expect((s2.panel.state({}).tasks.find((t: any) => t.id === 'L1107-9') as any).talkTo).toBe(MASTER_ID)
  })
})

describe('G11-1 ④ 成员守则「用户直接找你时」', () => {
  it('列出六种要报总管的情况、「已转总管」、「⚠️ 改了结论」；总管守则里没有这一节', () => {
    const p = rolePrompt('exec', 'exec-a')
    const sec = p.split('## 用户直接找你时')[1]?.split('\n## ')[0] ?? ''
    expect(sec).not.toBe('')
    for (const w of ['闸门', '状态要变', '拍板', '对外动作', '叫停', '别的任务', '拿不准', '已转总管', '⚠️ 改了结论', 'master_report']) expect(sec).toContain(w)
    expect(rolePrompt('master', MASTER_ID)).not.toContain('## 用户直接找你时')
  })
})

describe('G11-1 ⑤ 巡检「直接对话」发现', () => {
  const keys = (s: ReturnType<typeof setup>) => s.patrol.findings().map(f => f.key).filter(k => k.startsWith('direct'))
  /** 用户在 exec-a 里说一句，成员跑完一轮（回答 text） */
  async function talk(s: ReturnType<typeof setup>, id: string, text: string, answer = '好的，答案是 X') {
    s.sport.lastText.set('exec-a', answer)
    s.core.onUserMessage('exec-a', id, text)
    s.core.onStatus('exec-a', 'running'); s.sport.live.set('exec-a', 'running'); s.clock.advance(3000)
    s.sport.live.set('exec-a', 'idle'); s.core.onStatus('exec-a', 'idle'); await flush(); await new Promise(r => setTimeout(r, 5))
  }
  it('普通追问、成员答了 ⇒ 没有发现；答过了过 31 分钟也不报「没回」', async () => {
    const s = await ready()
    await talk(s, 'u1', '这个文件在哪？')
    expect(keys(s)).toEqual([])
    s.clock.advance(31 * 60_000)
    expect(keys(s)).toEqual([])
  })
  it('用户原话里有对外动作 / 叫停关键词 ⇒ 报', async () => {
    const s = await ready()
    await talk(s, 'u1', '先别发布，等我看完')
    await talk(s, 'u2', '把这个推送到 GitHub')
    expect(keys(s)).toEqual(['direct-keyword:exec-a:u1', 'direct-keyword:exec-a:u2'])
  })
  it('成员的回答里有「⚠️ 改了结论」 ⇒ 报', async () => {
    const s = await ready()
    await talk(s, 'u1', '这个数对吗？', '我重算了一遍，是 12 不是 15。\n⚠️ 改了结论：总数从 15 改成 12')
    expect(keys(s)).toEqual(['direct-changed:exec-a:u1'])
  })
  it('30 分钟没回：用户说了话之后这个会话一直没有一轮结束、现在是 idle ⇒ 报；不到 30 分钟不报', async () => {
    const s = await ready()
    s.core.onUserMessage('exec-a', 'u1', '在吗？')
    s.clock.advance(29 * 60_000); expect(keys(s)).toEqual([])
    s.clock.advance(2 * 60_000); expect(keys(s)).toEqual(['direct-noreply:exec-a:u1'])
  })
  it('30 分钟没回的对照：会话一直 running（在跑长活）⇒ 不报', async () => {
    const s = await ready()
    s.core.onStatus('exec-a', 'running'); s.sport.live.set('exec-a', 'running')
    s.clock.advance(60_000); s.core.onUserMessage('exec-a', 'u1', '在吗？')
    s.clock.advance(45 * 60_000)
    expect(keys(s)).toEqual([])
  })
  it('用户在已关闭的成员会话里说话 ⇒ 报「已不归总管管」', async () => {
    const s = await ready()
    s.store.closeSession('exec-a', new Date().toISOString())
    s.core.onUserMessage('exec-a', 'u1', '继续做')
    const f = s.patrol.findings().filter(x => x.key.startsWith('direct'))
    expect(f.map(x => x.key)).toEqual(['direct-closed:exec-a:u1'])
    expect(f[0]!.text).toContain('已不归总管管')
  })
  it('超过 24 小时的直接对话不再报', async () => {
    const s = await ready()
    await talk(s, 'u1', '先别发布')
    s.clock.advance(25 * 3600_000)
    expect(keys(s)).toEqual([])
  })
  it('directToMember: false ⇒ 不报直接对话（旧行为靠 inject 和空闲提醒）', async () => {
    const s = await ready({ directToMember: false })
    await talk(s, 'u1', '先别发布')
    expect(keys(s)).toEqual([])
  })
})
