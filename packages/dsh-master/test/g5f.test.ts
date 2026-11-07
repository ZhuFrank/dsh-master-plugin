import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { PanelService } from '../src/panel-service.ts'
import { Attribution } from '../src/attrib.ts'
import { rolePrompt } from '../src/prompts.ts'
import { WaitingTracker, pendingFromRecord, waitTitle } from '../src/waiting.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

async function setup() {
  const dir = tmpdir('g5f'); const clock = fakeClock(); const store = new Store(path.join(dir, 'master.db'))
  const dp = new FakeDeliveryPort()
  const core = new Core(store, new Delivery(store, dp, clock), new FakeSessionPort(), clock, { idleGraceMs: 1000 })
  await core.ensureMaster(tmpdir('m'))
  await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  await core.dispatch({ task: 'L1105-1', kind: 'light', title: '统计', to: 'a', text: '做' }, MASTER_ID)
  return { clock, store, core, dp }
}
const tool = (core: Core, who: string, name: string) => core.toolsFor(who).find(t => t.name === name)!

describe('G5-F ③ 轻任务验收进时间线', () => {
  it('回报完成即结案；给总管的消息提醒它用 master_review 记一笔', async () => {
    const s = await setup()
    await tool(s.core, 'exec-a', 'master_report').run({ task: 'L1105-1', state: '完成', action: '写好了' }, 'exec-a')
    expect(s.store.getTask('L1105-1')!.state).toBe('完成')
    const toMaster = s.store.messagesFor('L1105-1').filter(m => m.to_id === MASTER_ID).map(m => m.text).join('\n')
    expect(toMaster).toContain('master_review 记一笔')
  })
  it('通过：写 task/reviewed，轻任务保持完成（不因没给 final 变回进行中）；时间线「只看回报 / 验收」里有它', async () => {
    const s = await setup()
    await tool(s.core, 'exec-a', 'master_report').run({ task: 'L1105-1', state: '完成', action: '写好了' }, 'exec-a')
    await tool(s.core, MASTER_ID, 'master_review').run({ task: 'L1105-1', verdict: '通过', notes: '数过了，1957 行对' }, MASTER_ID)
    expect(s.store.getTask('L1105-1')!.state).toBe('完成')
    const ev = s.store.events({ task: 'L1105-1', type: 'task/reviewed' }).map(e => JSON.parse(e.data))
    expect(ev).toMatchObject([{ verdict: '通过', final: true, notes: '数过了，1957 行对' }])
    const th = new PanelService(s.store, s.core, new Attribution(s.store, s.core, s.clock), { promptUser: async () => {}, turnText: async () => undefined } as any, s.clock).thread('L1105-1')
    const shown = th.items.filter((x: any) => x.kind === 'event' && ['task/report', 'task/late-report', 'task/reviewed'].includes(x.type)).map((x: any) => x.type)
    expect(shown).toEqual(['task/report', 'task/reviewed'])
  })
  it('打回：重新打开（打回），执行会话收到逐条意见', async () => {
    const s = await setup()
    await tool(s.core, 'exec-a', 'master_report').run({ task: 'L1105-1', state: '完成', action: '写好了' }, 'exec-a')
    await tool(s.core, MASTER_ID, 'master_review').run({ task: 'L1105-1', verdict: '打回', notes: '1. 合计少了 docs 根目录' }, MASTER_ID)
    expect(s.store.getTask('L1105-1')!.state).toBe('打回')
    expect(s.store.messagesFor('L1105-1').some(m => m.to_id === 'exec-a' && m.text.includes('合计少了'))).toBe(true)
  })
})

describe('G5-F ② 等你点补扫', () => {
  const ev = (type: string, data: any, time = 1000) => ({ type, time, data })
  it('问了没结果的审批 / 选择题算挂着；有 decided / tool/result / turn/end 的不算', () => {
    const p = pendingFromRecord([
      ev('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }),
      ev('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1' }, 2000),
      ev('tool/call', { callId: 'c2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: '选哪个？' }] }) }, 3000),
    ])
    expect(p).toEqual([{ kind: 'approval', ref: 'a1', callId: 'c1', label: 'bash', since: 2000 }, { kind: 'question', ref: 'c2', callId: 'c2', label: '选哪个？', since: 3000 }])
    // 宿主正常停机：审批 cancelled、提问 ASK_ABORTED（都会写 tool/result）⇒ 不补
    expect(pendingFromRecord([ev('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1' }), ev('approval/decided', { id: 'a1', outcome: 'cancelled' })])).toEqual([])
    expect(pendingFromRecord([ev('tool/call', { callId: 'c2', name: 'ask_user_question', arguments: '{}' }), ev('tool/result', { message: { toolCallId: 'c2' } })])).toEqual([])
    expect(pendingFromRecord([ev('approval/asked', { id: 'a1', toolName: 'bash' }), ev('turn/end', {})])).toEqual([])
    // 时间字段是 ISO 字符串时也能读
    expect(pendingFromRecord([{ type: 'approval/asked', time: '2026-11-05T12:00:00+08:00', data: { id: 'x', toolName: 'bash' } }])[0]!.since).toBe(Date.parse('2026-11-05T12:00:00+08:00'))
  })
  it('补进来的按 ref 去重；宿主记下结果（settle）就消失', () => {
    const t = new WaitingTracker(() => 5000)
    t.start('s1', 'approval', 'bash', { since: 2000, ref: 'a1', callId: 'c1', backfilled: true })
    t.start('s1', 'approval', 'bash', { since: 2000, ref: 'a1', callId: 'c1', backfilled: true })
    expect(t.list()).toHaveLength(1)
    t.settle('s1', 'c1'); expect(t.list()).toEqual([])
    t.start('s1', 'question', 'q', { ref: 'c2', callId: 'c2', backfilled: true }); t.settle('s2', 'c2'); expect(t.list()).toHaveLength(1)
    t.settle('s1', 'c2'); expect(t.list()).toEqual([])
  })
})

describe('G5-F ⑥ 横幅里的会话名', () => {
  it('花名册名字 → 宿主标题 → 新会话（未命名 · 前 8 位）', () => {
    expect(waitTitle('exec-a', '执行 A', '宿主标题')).toBe('执行 A')
    expect(waitTitle('session-5a1b2c3d-4e5f-4a6b', null, '帮我整理文件')).toBe('帮我整理文件')
    expect(waitTitle('session-5a1b2c3d-4e5f-4a6b-8c7d', null, '')).toBe('新会话（未命名 · 5a1b2c3d）')
    expect(waitTitle('plain-xyz', undefined, undefined)).toBe('新会话（未命名 · plain-xy）')
  })
})

describe('G5-F ⑦ 守则：执行会话没有选择题工具，总管代问', () => {
  it('两边提示词都写明', () => {
    expect(rolePrompt('master', 'master')).toMatch(/执行会话没有给用户出选择题的工具[^\n]*master_ask_user 代问/)
    expect(rolePrompt('exec', 'exec-a')).toMatch(/你没有给用户出选择题的工具[^\n]*master_ask_user 代问/)
    expect(rolePrompt('master', 'master')).toMatch(/轻任务[^\n]*master_review 记一笔/)
  })
  it('交付手册写明（公开版没有交付手册，核 README）', () => {
    const handbook = path.resolve(import.meta.dirname, '../../../docs/交付手册.md')
    if (fs.existsSync(handbook)) {
      expect(fs.readFileSync(handbook, 'utf8')).toMatch(/执行会话\*\*没有\*\*给你出选择题的工具[^\n]*master_ask_user[^\n]*代问/)
    } else {
      const readme = fs.readFileSync(path.resolve(import.meta.dirname, '../../../README.zh-CN.md'), 'utf8')
      expect(readme).toMatch(/成员不能直接打断你[^\n]*由总管用 `master_ask_user` 代问/)
    }
  })
})

describe('G5-F 补：已点名的 slug 按词边界认', () => {
  it('snake-game-l1103-2 不算点名了 snake-game', async () => {
    const { topicPriors } = await import('../src/recall-push.ts')
    const p = (slug: string) => ({ slug, line: slug, reason: 'x', decisions: [], memories: [] })
    expect(topicPriors([p('snake-game')], '写了 snake-game-l1103-2').map(x => x.slug)).toEqual(['snake-game'])
    expect(topicPriors([p('snake-game')], '写了 snake-game。').map(x => x.slug)).toEqual([])
  })
})
