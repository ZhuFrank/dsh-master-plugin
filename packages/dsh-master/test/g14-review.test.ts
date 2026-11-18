/**
 * G14-2 独立审稿返工（总管 11-18 1925 转）：每条一个测试，先在返工前的代码上确认红过。
 * MUST 1：index.ts 里 ⑧ 加的行尾注释把 `tag: …` 吞进了注释 ⇒ 真实实例的 master_tag 消失（core.ts 要 opts.tag 才注册）。
 *         入口没有单测能跑到，这里读源码、去掉注释后钉住 Core 选项里有 tag / patrol / doctor 三项；e2e g4c-sidebar 在 G14-3 必跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const SRC = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '../src', f), 'utf8')
/** 去掉 // 行尾注释（不处理字符串里的 //：index.ts 这一段没有） */
const code = (s: string) => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

describe('G14 审稿 MUST 1：入口给 Core 的选项没被注释吞掉', () => {
  it('makeUnit 里 tag / patrol / doctor 三个选项都在代码里（不在注释里）', () => {
    const c = code(SRC('index.ts'))
    expect(c).toMatch(/tag: \(caller, a\) => u\.attrib\.tag\(caller, a\)/)
    expect(c).toMatch(/patrol: async \(\) => \(\{ findings: u\.patrol\.findings\(\)/)
    expect(c).toMatch(/doctor: \(\) => \(\{ problems: doctor\(/)
  })
})

// ---------------- MUST 2：等你定一件一条 key；② 用真实 findings 跑 ----------------
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { Patrol } from '../src/patrol.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

const flush = () => new Promise(r => setImmediate(r))
async function realRig() {
  const dir = tmpdir('g14rev'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const dport = new FakeDeliveryPort()
  const core = new Core(store, new Delivery(store, dport, clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, mem, timer: () => () => {} })
  await core.ensureMaster(tmpdir('m'))
  await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  await core.dispatch({ task: 'L1118-1', kind: 'light', title: '活', to: 'a', text: '做' }, MASTER_ID)
  const patrol = new Patrol(store, core, undefined, clock, { stallMs: 1e12, longRunMs: 1e12 })
  await flush(); dport.calls.length = 0
  const patrolMsgs = () => dport.calls.filter(c => c.to === MASTER_ID && c.text.includes('巡检发现'))
  return { store, core, clock, patrol, dport, patrolMsgs }
}

describe('G14 审稿 MUST 2：答掉一件等你定，不再叫醒总管', () => {
  it('两件等你定各一条 key；答掉一件 ⇒ quiet、不投递；再来一件新的 ⇒ 照报', async () => {
    const s = await realRig()
    const q1 = await s.core.askUser({ task: 'L1118-1', question: '第一问？', options: ['A'] })
    await s.core.askUser({ task: 'L1118-1', question: '第二问？', options: ['A'] })
    expect(s.patrol.findings().filter(f => f.key.startsWith('ask')).map(f => f.key).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^ask:\d+$/), expect.stringMatching(/^ask:\d+$/)]))
    expect(s.patrol.tick()).toBe('reported'); await flush()
    expect(s.patrolMsgs()).toHaveLength(1)
    s.store.answerAsk(q1.id, 'A', new Date().toISOString())
    expect(s.patrol.tick()).toBe('quiet'); await flush()
    expect(s.patrolMsgs()).toHaveLength(1)
    await s.core.askUser({ task: 'L1118-1', question: '第三问？', options: ['A'] })
    expect(s.patrol.tick()).toBe('reported')
  })
})

// ---------------- SHOULD 7：计划写了、没做的三处 ----------------
import { PanelService, type PanelPort, type TurnText } from '../src/panel-service.ts'
import { Attribution } from '../src/attrib.ts'
class FakePanelPort implements PanelPort {
  async promptUser() {}
  async turnText(_s: string, _t: number): Promise<TurnText | undefined> { return undefined }
}
async function panelRig() {
  const s = await realRig()
  const attrib = new Attribution(s.store, s.core, s.clock)
  const panel = new PanelService(s.store, s.core, attrib, new FakePanelPort(), s.clock)
  const tool = (caller: string, name: string) => { const t = s.core.toolsFor(caller).find(x => x.name === name); if (!t) throw new Error(`${caller} 没有 ${name}`); return (a: unknown) => t.run(a, caller) }
  return { ...s, attrib, panel, tool }
}

describe('G14 审稿 SHOULD 7 ③：适时提示总管用 master_ask_close', () => {
  it('验收一件还挂着等你定的任务 ⇒ 返回里提示 master_ask_close；同一件任务再问一件时也提示', async () => {
    const s = await panelRig()
    const q: any = await s.core.askUser({ task: 'L1118-1', question: '表格还是一行一个？', options: ['表格'] })
    const r: any = await s.tool(MASTER_ID, 'master_review')({ task: 'L1118-1', verdict: '通过', notes: '核过' })
    expect(String(r.note)).toMatch(new RegExp(`${q.code}[\\s\\S]*master_ask_close`))
    const r2: any = await s.tool(MASTER_ID, 'master_ask_user')({ task: 'L1118-1', question: '再问一件？', options: ['好'] })
    expect(String(r2.note)).toMatch(/master_ask_close/)
  })
  it('压缩后提醒里列等你定时也带这句', async () => {
    const s = await panelRig()
    await s.core.askUser({ task: 'L1118-1', question: 'Q?', options: ['A'] })
    s.core.onCompaction(MASTER_ID, '1'); await flush()
    expect(s.dport.calls.filter(c => c.to === MASTER_ID).at(-1)!.text).toMatch(/还没答的等你定[\s\S]*master_ask_close/)
  })
})

describe('G14 审稿 SHOULD 7 ⑩：守则里的叫法对照表；用户说的话里叫法后面标「（= 编号）」', () => {
  it('aliasTable：只列没结的、有叫法的任务；一件都没有 ⇒ 空串', async () => {
    const s = await panelRig()
    expect(s.core.aliasTable()).toBe('')
    await s.panel.act({ action: 'alias', task: 'L1118-1', alias: '下载整理' } as any)
    expect(s.core.aliasTable()).toMatch(/叫法对照[\s\S]*「下载整理」= L1118-1/)
  })
  it('入口把叫法对照表接进守则（读源码钉住）', () => {
    expect(code(SRC('index.ts'))).toMatch(/u\.core\.aliasTable\(\)/)
  })
  it('用户消息里出现叫法 ⇒ 后面加「（= L1118-1）」；已经写了编号、或同时对上两件任务 ⇒ 不加；改过名的旧叫法也认', async () => {
    const s = await panelRig()
    await s.core.dispatch({ task: 'L1118-2', kind: 'light', title: '活二', to: 'a', text: '做' }, MASTER_ID)
    await s.panel.act({ action: 'alias', task: 'L1118-1', alias: '下载整理' } as any)
    await s.panel.act({ action: 'alias', task: 'L1118-2', alias: '每周发布' } as any)
    expect(s.core.annotateUserAliases('下载整理先停一下')).toBe('下载整理（= L1118-1）先停一下')
    expect(s.core.annotateUserAliases('L1118-1 也就是下载整理，先停')).toBe('L1118-1 也就是下载整理，先停')
    expect(s.core.annotateUserAliases('下载整理和每周发布都停')).toBe('下载整理和每周发布都停')
    await s.panel.act({ action: 'alias', task: 'L1118-1', alias: '整理下载夹' } as any)
    expect(s.core.annotateUserAliases('下载整理怎么样了')).toBe('下载整理（= L1118-1）怎么样了')
  })
  it('每步前处理（processStep）真的改写用户消息', async () => {
    const s = await panelRig()
    await s.panel.act({ action: 'alias', task: 'L1118-1', alias: '下载整理' } as any)
    const msg = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '下载整理先停一下' }] }
    const r = s.attrib.processStep(MASTER_ID, 1, [msg])
    expect(r.changed).toBe(true)
    expect(r.messages[0].content[0].text).toBe('下载整理（= L1118-1）先停一下')
  })
})

describe('G14 审稿 SHOULD 7 ⑤：任务详情里显示挂着的提醒', () => {
  it('thread(task).task.reminders 列这件任务挂着的提醒；到点后不再列', async () => {
    const s = await panelRig()
    await s.tool(MASTER_ID, 'master_remind')({ at: '2h', text: '核一下市场条目', task: 'L1118-1' })
    await s.tool(MASTER_ID, 'master_remind')({ at: '3h', text: '别的任务的', task: 'L1118-9' })
    expect((s.panel.thread('L1118-1').task as any).reminders).toEqual([expect.objectContaining({ text: '核一下市场条目' })])
    s.clock.advance(2 * 3600_000 + 1000); s.core.fireReminders()
    expect((s.panel.thread('L1118-1').task as any).reminders).toEqual([])
  })
})

// ---------------- SHOULD 9：每种巡检 key 在「只有它消失」时都不叫醒总管 ----------------
describe('G14 审稿 SHOULD 9：逐种 key 核「只有项消失」不叫醒', () => {
  // 15 种发现 key（patrol.ts findings 里全部的 key 前缀），每种取一个真实格式的样例
  const KINDS: Record<string, string> = {
    'stalled': 'stalled:alpha.x:T001', 'long-run': 'long-run:alpha.x:1794620000000', 'waiting': 'waiting:alpha.x:1794620000000',
    'direct-closed': 'direct-closed:alpha.x:m1', 'direct-changed': 'direct-changed:alpha.x:m1', 'direct-keyword': 'direct-keyword:alpha.x:m1', 'direct-noreply': 'direct-noreply:alpha.x:m1',
    'delivery-error': 'delivery-error:send:master:alpha.x:abc', 'ask': 'ask:3', 'late-report': 'late-report:42', 'heavy-stuck': 'heavy-stuck:7',
    'link': 'link:T001|T002:tts,配音', 'mem': 'mem:devlog 指向的文件不存在', 'drift': 'drift:tasks/T001.md:abc123', 'drift-absorbed': 'drift-absorbed:9',
  }
  it('样例覆盖了 patrol.ts 里全部的 key 种类', () => {
    const inSrc = [...new Set([...SRC('patrol.ts').matchAll(/key: `([a-z-]+):/g)].map(m => m[1]!))].filter(k => k !== 'patrol').sort()
    expect(Object.keys(KINDS).sort()).toEqual(inSrc)
  })
  for (const [kind, key] of Object.entries(KINDS)) {
    it(`${kind}：和别的发现一起报过以后只有它消失 ⇒ quiet、不投递`, async () => {
      const s = await realRig()
      let cur = [{ key, text: kind }, { key: 'stalled:alpha.y:T999', text: '另一项' }]
      s.patrol.findings = () => cur
      expect(s.patrol.tick()).toBe('reported'); await flush()
      cur = [{ key: 'stalled:alpha.y:T999', text: '另一项' }]
      expect(s.patrol.tick()).toBe('quiet'); await flush()
      expect(s.patrolMsgs()).toHaveLength(1)
    })
  }
  it('真实产生：停滞（stalled）—— 成员回报了、这一项消失 ⇒ quiet', async () => {
    const s = await realRig()
    const p = new Patrol(s.store, s.core, undefined, s.clock, { stallMs: 60_000, longRunMs: 1e12 })
    await s.core.askUser({ task: 'L1118-1', question: '留一项别的', options: ['A'] })
    s.clock.advance(120_000)
    expect(p.findings().map(f => f.key.split(':')[0]).sort()).toEqual(['ask', 'stalled'])
    expect(p.tick()).toBe('reported')
    const t = s.core.toolsFor('exec-a').find(x => x.name === 'master_report')!
    await t.run({ task: 'L1118-1', state: '进展', action: '还在做' }, 'exec-a')
    expect(p.findings().map(f => f.key.split(':')[0])).toEqual(['ask'])
    expect(p.tick()).toBe('quiet')
  })
  it('真实产生：迟到回报（late-report）—— 总管跑过一轮、这一项消失 ⇒ quiet', async () => {
    const s = await realRig()
    const rep = s.core.toolsFor('exec-a').find(x => x.name === 'master_report')!
    await rep.run({ task: 'L1118-1', state: '完成', action: '做完了' }, 'exec-a')
    await s.core.askUser({ task: 'L1118-9', question: '留一项别的', options: ['A'] })
    s.clock.advance(60_000)
    await rep.run({ task: 'L1118-1', state: '进展', action: '又改了一点' }, 'exec-a')
    expect(s.patrol.findings().map(f => f.key.split(':')[0]).sort()).toEqual(['ask', 'late-report'])
    expect(s.patrol.tick()).toBe('reported')
    s.clock.advance(60_000); s.core.onStatus(MASTER_ID, 'running')
    expect(s.patrol.tick()).toBe('quiet')
  })
  it('真实产生：等你点（waiting）—— 点过了、这一项消失 ⇒ quiet', async () => {
    const s = await realRig()
    let waiting = [{ session: 'exec-a', kind: 'approval' as const, label: 'bash', since: s.clock() }]
    const p = new Patrol(s.store, s.core, undefined, s.clock, { stallMs: 1e12, longRunMs: 1e12, waiting: () => waiting })
    await s.core.askUser({ task: 'L1118-1', question: '留一项别的', options: ['A'] })
    s.clock.advance(11 * 60_000)
    expect(p.tick()).toBe('reported')
    waiting = []
    expect(p.tick()).toBe('quiet')
  })
})

describe('G14 复核（不急的两处之二）：用户消息认叫法也做 NFKC 归一', () => {
  it('叫法「Down整理」，用户写全角「ＤＯＷＮ整理」也认，标在原文那几个字后面', async () => {
    const s = await panelRig()
    await s.panel.act({ action: 'alias', task: 'L1118-1', alias: 'Down整理' } as any)
    expect(s.core.annotateUserAliases('ＤＯＷＮ整理先停一下')).toBe('ＤＯＷＮ整理（= L1118-1）先停一下')
  })
})
