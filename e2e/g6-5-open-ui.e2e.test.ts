/**
 * G6-5 — 照界面的真实流程开张（3090 试用第 1 项失败的复现；假模型 + 沙盒，不起 Chrome；不碰 3090 / 3082）：
 * 侧栏「在 X 中新建会话」⇒ 会话头里是默认预设 standard；在输入框下方的模式菜单里选「dsh-master 总管」⇒ 宿主单独记一条
 * agent-preset/selected；紧接着发第一句话。插件要在这条事件上开张，第一句话的那一步就要有总管工具。
 * 同时覆盖：同一项目里再这样选一次总管 ⇒ 第二个总管被拒；选「dsh-master 执行会话」⇒ 未入编并告诉它成员要由总管建；不选 ⇒ 未入编。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })

it('G6-5：界面流程开张（先建 standard 会话、再选总管预设、马上发第一句话）', async () => {
  const base = path.join(E2E_WORK, `g65ui-${Date.now()}`)
  const alpha = (() => { const d = path.join(base, 'alpha'); fs.mkdirSync(path.join(d, 'sub'), { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) })()
  const sb = await createSandbox({ name: 'g6-5-ui', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32 } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const projects = async () => (await sb.get('/dsh-master-debug/projects')).registry as Array<{ id: string; root: string; master: string }>
  const events = (type: string) => sb.get(`/dsh-master-debug/events?project=alpha&type=${encodeURIComponent(type)}`) as Promise<any[]>
  const hist = async (sid: string) => JSON.stringify(await sb.get(`/dsh-master-debug/history?sessionId=${encodeURIComponent(sid)}`))
  const reqsWith = (mark: string) => sb.mock.requests().filter(r => r.messages.some(m => m.role === 'user' && m.text.includes(mark)))

  // ── 新建会话：头里是 standard（界面默认），这时还不是项目 ──
  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sleep(1000)
  expect(await projects()).toEqual([])
  // ── 模式菜单选「dsh-master 总管」，紧接着发第一句话（不等） ──
  expect((await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })).selected).toBe('dsh-master-master')
  await prompt('ui-m', '你好 FIRST-MSG')
  await quiet()
  expect((await projects()).map(p => [p.id, p.root, p.master])).toEqual([['alpha', alpha, 'ui-m']])
  expect(fs.existsSync(path.join(alpha, '.dsh-master', 'owner'))).toBe(true)
  expect(fs.readFileSync(path.join(alpha, '.git', 'info', 'exclude'), 'utf8')).toContain('/.dsh-master/')
  // 第一句话那一步就有总管工具和守则
  const first = reqsWith('FIRST-MSG')[0]!
  expect(first.tools).toEqual(expect.arrayContaining(['master_spawn', 'master_dispatch', 'master_review']))
  expect(first.messages.some(m => m.text.includes('# 你是总管（会话 ui-m）'))).toBe(true)
  expect(await hist('ui-m')).toContain('这个工作区已开张为项目 alpha')
  expect((await events('project/opened')).map((e: any) => e.data.root)).toEqual([alpha])
  expect((await sb.get('/dsh-master-debug/open-log') as any[]).filter(x => x.session === 'ui-m').map(x => [x.via, x.preset])).toEqual([['created', 'standard'], ['preset-selected', 'dsh-master-master']])
  // 开了张就能干活：建成员
  await prompt('ui-m', call('master_spawn', { name: 'x', title: '成员 X' })); await quiet()
  expect((await sb.get('/dsh-master-debug/state?project=alpha')).sessions.map((s: any) => s.id).sort()).toEqual(['alpha.x', 'ui-m'])

  // ── 同一项目里再这样选一次总管：第二个总管被拒，并告诉它 ──
  await sb.post('/dsh-master-debug/create', { id: 'ui-m2', cwd: path.join(alpha, 'sub') })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m2', preset: 'dsh-master-master' })
  await sb.waitFor('第二个总管被记下', async () => (await events('project/second-master')).some((e: any) => e.session === 'ui-m2'))
  expect((await projects()).find(p => p.id === 'alpha')!.master).toBe('ui-m')
  await sb.waitFor('第二个总管收到说明', async () => (await hist('ui-m2')).includes('不会'))

  // ── 选「dsh-master 执行会话」：不进团队，未入编，告诉它成员要由总管建 ──
  await sb.post('/dsh-master-debug/create', { id: 'ui-e', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-e', preset: 'dsh-master-exec' })
  await sb.waitFor('执行预设会话收到说明', async () => (await hist('ui-e')).includes('成员只能由总管用 master_spawn 建'))
  await prompt('ui-e', '你好 EXEC-PRESET-MSG'); await quiet()
  expect(reqsWith('EXEC-PRESET-MSG')[0]!.tools.filter(t => t?.startsWith('master_'))).toEqual([])
  // ── 不选预设的普通会话：未入编 ──
  await sb.post('/dsh-master-debug/create', { id: 'ui-p', cwd: alpha })
  await sb.waitFor('未入编', async () => (await events('session/unenrolled')).some((e: any) => e.session === 'ui-p'))
  const un = Object.fromEntries((await events('session/unenrolled')).map((e: any) => [e.session, e.data.preset]))
  expect(un['ui-e']).toBe('dsh-master-exec'); expect(un['ui-p']).toBe('standard')
  expect((await projects()).length).toBe(1)
}, 300_000)
