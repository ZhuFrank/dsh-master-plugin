/**
 * G6-2 — 开张与团队（假模型 + 沙盒，不起 Chrome；不碰 3090 / 3082）：
 * 在两个 git 仓库里各用「dsh-master 总管」预设新建会话 ⇒ 开张两个项目（alpha、beta），各建 2 个成员；
 * 派活、回报、等你定互不串；守卫拦成员写 <根>/.dsh-master/；同一项目第二个总管被拒；普通会话记成未入编；
 * .git/info/exclude、owner 文件写好；旧单元不受影响；重启后两个项目都还在。
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

it('G6-2：两个项目开张，团队互不串，守卫、第二个总管、未入编、重启', async () => {
  const base = path.join(E2E_WORK, `g62-${Date.now()}`)
  const repo = (n: string) => { const d = path.join(base, n); fs.mkdirSync(path.join(d, 'sub'), { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) }
  const alpha = repo('alpha'), beta = repo('beta')
  const sb = await createSandbox({ name: 'g6-2', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32 } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const projects = async () => (await sb.get('/dsh-master-debug/projects')).registry as Array<{ id: string; root: string; master: string }>
  const events = (pj: string | null, type: string) => sb.get(`/dsh-master-debug/events?type=${encodeURIComponent(type)}${pj ? `&project=${pj}` : ''}`)
  const mine = (sid: string) => sb.mock.requests().filter(r => r.messages.some(m => m.text.includes(`你是执行会话（${sid}）`) || m.text.includes(`# 你是总管（会话 ${sid}）`)))
  const sees = (sid: string, mark: string) => mine(sid).some(r => r.messages.some(m => m.text.includes(mark)))

  await prompt('master', '你好'); await quiet() // 旧单元照常

  // ── 开张：用总管预设新建会话 ──
  await sb.post('/dsh-master-debug/create', { id: 'a-master', cwd: alpha, preset: 'dsh-master-master' })
  await sb.post('/dsh-master-debug/create', { id: 'b-master', cwd: beta, preset: 'dsh-master-master' })
  await sb.waitFor('两个项目登记', async () => (await projects()).length === 2)
  expect((await projects()).map(p => [p.id, p.root, p.master])).toEqual([['alpha', alpha, 'a-master'], ['beta', beta, 'b-master']])
  for (const [pj, root] of [['alpha', alpha], ['beta', beta]] as const) {
    expect((await events(pj, 'project/opened')).map((e: any) => e.data.root)).toEqual([root])
    expect(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('/.dsh-master/')
    expect(JSON.parse(fs.readFileSync(path.join(root, '.dsh-master', 'owner'), 'utf8')).stateDir).toBe(path.join(sb.home, 'dsh-master'))
  }
  // 开张通知送到了总管会话（第一轮能看到）
  await prompt('a-master', '你好'); await quiet()
  expect(sees('a-master', '这个工作区已开张为项目 alpha')).toBe(true)

  // ── 团队：各建 2 个成员（不给 cwd）；给别的 cwd 被拒 ──
  for (const [m, pj] of [['a-master', 'alpha'], ['b-master', 'beta']] as const) {
    for (const n of ['x', 'y']) { await prompt(m, call('master_spawn', { name: n, title: `${pj} 成员 ${n}` })); await quiet() }
    expect((await sb.get(`/dsh-master-debug/state?project=${pj}`)).sessions.map((s: any) => s.id).sort()).toEqual([m, `${pj}.x`, `${pj}.y`].sort())
  }
  await prompt('a-master', call('master_spawn', { name: 'z', title: 'z', cwd: '/tmp' })); await quiet()
  expect(JSON.stringify(await sb.get('/dsh-master-debug/history?sessionId=a-master'))).toContain('固定是项目根')

  // ── 派活：同一个任务号各派各的 ──
  await prompt('a-master', call('master_dispatch', { task: 'L1106-1', kind: 'light', title: 'alpha 的活', to: 'x', text: 'ALPHA-TASK-MARK' })); await quiet()
  await prompt('b-master', call('master_dispatch', { task: 'L1106-1', kind: 'light', title: 'beta 的活', to: 'x', text: 'BETA-TASK-MARK' })); await quiet()
  await sb.waitFor('两边成员各收到自己的派活', async () => sees('alpha.x', 'ALPHA-TASK-MARK') && sees('beta.x', 'BETA-TASK-MARK'))
  expect(sees('alpha.x', 'BETA-TASK-MARK')).toBe(false); expect(sees('beta.x', 'ALPHA-TASK-MARK')).toBe(false)
  expect(sees('alpha.y', 'ALPHA-TASK-MARK')).toBe(false)
  // ── 回报：只到本项目的总管 ──
  await prompt('alpha.x', call('master_report', { task: 'L1106-1', state: '完成', action: 'ALPHA-DONE-MARK' })); await quiet()
  await sb.waitFor('alpha 总管收到回报', async () => sees('a-master', 'ALPHA-DONE-MARK'))
  expect(sees('b-master', 'ALPHA-DONE-MARK')).toBe(false)
  expect((await sb.get('/dsh-master-debug/state?project=alpha')).tasks.find((t: any) => t.id === 'L1106-1').state).toBe('完成')
  expect((await sb.get('/dsh-master-debug/state?project=beta')).tasks.find((t: any) => t.id === 'L1106-1').state).not.toBe('完成')
  // ── 等你定：各自编号 ──
  await prompt('a-master', call('master_ask_user', { task: 'L1106-1', question: 'ALPHA 问？' })); await quiet()
  await prompt('b-master', call('master_ask_user', { task: 'L1106-1', question: 'BETA 问？' })); await quiet()
  const qa = await events('alpha', 'ask/open'), qb = await events('beta', 'ask/open')
  expect(qa.map((e: any) => e.data.question)).toEqual(['ALPHA 问？']); expect(qb.map((e: any) => e.data.question)).toEqual(['BETA 问？'])
  expect(qa[0].data.code).toMatch(/^Q\d{4}-1$/); expect(qb[0].data.code).toBe(qa[0].data.code)
  // 旧单元不受影响
  expect((await sb.get('/dsh-master-debug/state')).tasks.some((t: any) => t.id === 'L1106-1')).toBe(false)

  // ── 守卫：成员不能直接写 <根>/.dsh-master/（write 工具、bash 相对路径都拦）；别的文件照写 ──
  await prompt('alpha.y', call('write', { file_path: path.join(alpha, '.dsh-master', 'docs', 'HACK.md'), content: 'x' })); await quiet()
  await prompt('alpha.y', call('bash', { description: 'write dot dir', command: 'echo x > .dsh-master/HACK2.txt' })); await quiet()
  await prompt('alpha.y', call('write', { file_path: path.join(alpha, 'ok.txt'), content: 'ok' })); await quiet()
  expect(fs.existsSync(path.join(alpha, '.dsh-master', 'docs', 'HACK.md'))).toBe(false)
  expect(fs.existsSync(path.join(alpha, '.dsh-master', 'HACK2.txt'))).toBe(false)
  expect(fs.readFileSync(path.join(alpha, 'ok.txt'), 'utf8')).toBe('ok')
  expect((await events('alpha', 'guard/deny')).length).toBeGreaterThanOrEqual(2)

  // ── 同一项目第二个总管：拒绝，并告诉它原因；普通会话记成未入编 ──
  await sb.post('/dsh-master-debug/create', { id: 'a-master2', cwd: path.join(alpha, 'sub'), preset: 'dsh-master-master' })
  await sb.waitFor('第二个总管被记下', async () => (await events('alpha', 'project/second-master')).length === 1)
  expect((await projects()).find(p => p.id === 'alpha')!.master).toBe('a-master')
  await sb.waitFor('第二个总管收到说明', async () => JSON.stringify(await sb.get('/dsh-master-debug/history?sessionId=a-master2')).includes('不会'))
  await sb.post('/dsh-master-debug/create', { id: 'a-plain', cwd: alpha })
  await sb.waitFor('未入编', async () => (await events('alpha', 'session/unenrolled')).some((e: any) => e.session === 'a-plain'))

  // ── 重启：两个项目都还在，花名册照旧，还能派活 ──
  await sb.restart(); await sleep(2000)
  expect((await sb.get('/dsh-master-debug/projects')).units.sort()).toEqual(['alpha', 'beta', 'legacy'])
  expect((await sb.get('/dsh-master-debug/state?project=beta')).sessions.map((s: any) => s.id).sort()).toEqual(['b-master', 'beta.x', 'beta.y'])
  await prompt('b-master', call('master_dispatch', { task: 'L1106-2', kind: 'light', title: '重启后', to: 'y', text: 'BETA-AFTER-RESTART' })); await quiet()
  await sb.waitFor('重启后派活送到', async () => sees('beta.y', 'BETA-AFTER-RESTART'))
}, 300_000)
