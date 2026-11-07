/**
 * G7 打磨轮（假模型 + 沙盒，不起 Chrome；不碰 3090 / 3082）——走宿主那一层真调工具：
 * ⑥ 项目总管调 master_sessions：没有成员、有成员各一次，宿主不报 invalid output，结果里是 { sessions: [...] }；
 * ④ 项目总管的权限预设：默认完全权限（Frank #427），往项目外写得进去；配置 projectMasterPreset: workspace-write 时（第二个测试）往项目外写被沙盒拦、项目里照样能 git 提交；
 * 安全：未入编会话读实例日志目录（$DSH_HOME/logs）被守卫拦，总管能读；
 * ⑤ 旧单元存档后，旧总管第一次收到用户消息时，同一轮里收到「已存档、新总管在哪」的说明；只说一次（第二句话、重启后都不再加）；
 * ⑧ 开张通知用 followup：选了预设没说话也马上看到，不会挂在收件箱里等到定时保底。
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
const gitRepo = (d: string) => { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) }

it('G7：master_sessions 真调、项目总管权限、日志守卫、存档后的旧总管说明', async () => {
  const base = path.join(E2E_WORK, `g7-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside, { recursive: true })
  // 旧总管的工作目录单独做成 git 仓库（防止误开张时找到外面的 ~/dsh_master）
  const legacyMasterCwd = gitRepo(path.join(base, 'legacy-master'))
  const sb = await createSandbox({ name: 'g7', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, masterCwd: legacyMasterCwd } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await prompt(sid, text); await quiet() }
  /** 带记号 mark 的那次调用的工具结果（同一步里插件可能还插了别的消息，所以不能只看最后一条）。 */
  const resultOf = (mark: string) => {
    for (const r of sb.mock.requests()) {
      const i = r.messages.findIndex(m => m.role === 'user' && m.text.includes(mark))
      const t = i >= 0 ? r.messages.slice(i + 1).find(m => m.role === 'tool') : undefined
      if (t) return t.text
    }
    return undefined
  }
  let seq = 0
  /** 让会话调一个工具，返回工具结果的文字。 */
  const tool = async (sid: string, name: string, args: unknown) => { const mark = `G7-MARK-${++seq}`; await run(sid, `${call(name, args)}\n${mark}`); return resultOf(mark) }
  const events = (pj: string | null, type: string) => sb.get(`/dsh-master-debug/events?type=${encodeURIComponent(type)}${pj ? `&project=${pj}` : ''}`) as Promise<any[]>

  // ── 开张（照界面顺序：建 standard 会话 → 选总管预设）──
  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))

  // ── ⑥ 没有成员时调 master_sessions ──
  const t0 = (await tool('ui-m', 'master_sessions', {}))!
  expect(t0).toBeDefined()
  expect(t0).not.toMatch(/invalid output|must be an object/)
  expect(t0).toContain('"sessions"')
  expect(t0).toContain('"ui-m"')
  expect(t0).not.toContain('alpha.x')
  // ── ⑥ 有成员时再调一次 ──
  await run('ui-m', call('master_spawn', { name: 'x', title: '成员 X' }))
  const t1 = (await tool('ui-m', 'master_sessions', {}))!
  expect(t1).not.toMatch(/invalid output|must be an object/)
  expect(t1).toContain('"sessions"')
  expect(t1).toContain('"alpha.x"')
  expect(t1).toContain('"ui-m"')

  // ── ④ 默认：项目总管是完全权限，往项目外写得进去；项目里能 git 提交 ──
  const outFile = path.join(outside, 'master-wrote.txt')
  await run('ui-m', call('bash', { command: `touch ${outFile}`, description: '往项目外写一个文件' }))
  expect(fs.existsSync(outFile)).toBe(true)
  await run('ui-m', call('bash', { command: `git -C ${alpha} -c user.email=t@e -c user.name=t commit -q --allow-empty -m g7-master-commit`, description: '项目里提交' }))
  expect(execFileSync('git', ['-C', alpha, 'log', '--oneline'], { encoding: 'utf8' })).toContain('g7-master-commit')

  // ── 安全：未入编会话读实例日志目录被拦，总管能读 ──
  const logs = path.join(sb.home, 'logs'); fs.mkdirSync(logs, { recursive: true })
  const fake = path.join(logs, 'g7-fake.log'); fs.writeFileSync(fake, 'token=FAKE-G7-TOKEN\n')
  await sb.post('/dsh-master-debug/create', { id: 'ui-p', cwd: alpha })
  await sb.waitFor('ui-p 未入编', async () => (await events('alpha', 'session/unenrolled')).some((e: any) => e.session === 'ui-p'))
  const tp = (await tool('ui-p', 'bash', { command: `cat ${fake}`, description: '读实例日志' }))!
  expect(tp).toContain('实例日志目录')
  expect(tp).not.toContain('FAKE-G7-TOKEN')
  expect((await events(null, 'guard/deny')).some((e: any) => e.session === 'ui-p' && String(e.data.reason).includes('实例日志目录'))).toBe(true)
  expect(await tool('ui-m', 'bash', { command: `cat ${fake}`, description: '总管读实例日志' })).toContain('FAKE-G7-TOKEN')

  // ── ⑧ 开张通知不挂在收件箱：选了总管预设但一句话都没说，也会马上看到「已开张」（以前用 inject，要等它下一步，3090 上挂了 6 小时）──
  const beta = gitRepo(path.join(base, 'beta'))
  await sb.post('/dsh-master-debug/create', { id: 'ui-q', cwd: beta })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-q', preset: 'dsh-master-master' })
  await sb.waitFor('beta 开张后总管自己跑了一轮、看到了开张通知', () => sb.mock.requests().some(r => r.messages.some(m => m.role === 'user' && m.text.includes('这个工作区已开张为项目 beta'))) || undefined, 30_000)
  await quiet()

  // ── ⑤ 旧单元存档：放标记文件、重启 ──
  fs.writeFileSync(path.join(sb.home, 'dsh-master', 'legacy-archived'), 'archived for g7 test\n')
  await sb.restart(); await sleep(4000)
  await sb.waitFor('存档事件', async () => (await events(null, 'legacy/archived')).length === 1)
  const NOTICE = '[dsh-master 消息 · 旧单元已存档]'
  const reqOf = (mark: string) => sb.mock.requests().find(r => r.messages.some(m => m.role === 'user' && m.text.includes(mark)))
  const noticeCount = (mark: string) => reqOf(mark)!.messages.filter(m => m.role === 'user' && m.text.includes(NOTICE)).length
  await run('master', '你这里现在不巡检了吗？LEGACY-1')
  const r1 = reqOf('LEGACY-1')!
  expect(r1.tools.filter(t => t?.startsWith('master_'))).toEqual([])
  const notice = r1.messages.find(m => m.text.includes(NOTICE))!
  expect(notice).toBeDefined()
  expect(notice.text).toContain('不是总管')
  expect(notice.text).toContain(`项目 alpha（根目录 ${alpha}）：总管是会话 ui-m`)
  expect(notice.text).toContain(`项目 beta（根目录 ${beta}）：总管是会话 ui-q`)
  expect(notice.text).toContain('不要建议重启')
  // 说明在用户这句话之后（同一轮、同一步就看得到）
  const idx = (t: string) => r1.messages.findIndex(m => m.text.includes(t))
  expect(idx(NOTICE)).toBeGreaterThan(idx('LEGACY-1'))
  expect((await events(null, 'legacy/notice')).map((e: any) => e.session)).toEqual(['master'])
  // 第二句话：历史里那一条还在，但不再加新的
  await run('master', '再问一句 LEGACY-2')
  expect(noticeCount('LEGACY-2')).toBe(1)
  // 重启后也不重复
  await sb.restart(); await sleep(4000)
  await run('master', '重启后 LEGACY-3')
  expect(noticeCount('LEGACY-3')).toBe(1)
  expect((await events(null, 'legacy/notice')).length).toBe(1)
  // 项目总管不受影响：重启后 master_sessions 照常、权限照旧
  expect(await tool('ui-m', 'master_sessions', {})).toContain('"alpha.x"')
  const outFile2 = path.join(outside, 'master-wrote-after-restart.txt')
  await run('ui-m', call('bash', { command: `touch ${outFile2}`, description: '重启后再往项目外写' }))
  expect(fs.existsSync(outFile2)).toBe(true)
}, 400_000)

it('G7 ④：配置 projectMasterPreset: workspace-write ⇒ 项目总管往项目外写被拦，项目里照样能提交（重启后也一样）', async () => {
  const base = path.join(E2E_WORK, `g7ws-${Date.now()}`)
  const gamma = gitRepo(path.join(base, 'gamma'))
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside, { recursive: true })
  const sb = await createSandbox({ name: 'g7-ws', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, masterCwd: gitRepo(path.join(base, 'legacy-master')), projectMasterPreset: 'workspace-write' } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }
  await sb.post('/dsh-master-debug/create', { id: 'g-m', cwd: gamma })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'g-m', preset: 'dsh-master-master' })
  await sb.waitFor('gamma 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'gamma'))
  await quiet()
  const out1 = path.join(outside, 'ws-1.txt')
  await run('g-m', call('bash', { command: `touch ${out1}`, description: '往项目外写一个文件' }))
  expect(fs.existsSync(out1)).toBe(false)
  await run('g-m', call('bash', { command: `git -C ${gamma} -c user.email=t@e -c user.name=t commit -q --allow-empty -m g7-ws-commit`, description: '项目里提交' }))
  expect(execFileSync('git', ['-C', gamma, 'log', '--oneline'], { encoding: 'utf8' })).toContain('g7-ws-commit')
  await sb.restart(); await sleep(3000)
  const out2 = path.join(outside, 'ws-2.txt')
  await run('g-m', call('bash', { command: `touch ${out2}`, description: '重启后再往项目外写' }))
  expect(fs.existsSync(out2)).toBe(false)
}, 240_000)
