/**
 * G14 ③a（T005 待评估第 7 项 ①）：结案任务上的「等你定」在看板上答了 ⇒ 交给总管并叫醒它（总管请求数 ≥ +1，带着答案），
 * 不再直送成员。0.2.0 里答案直送成员、成员接着干、回报成了迟到回报，总管不醒（G12 彩排、T018 11-17 21:29 各碰到一次）。
 * 沙盒 + 假模型 + 无头 Chrome；不碰 3080 / 3090。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const gitRepo = (d: string) => { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) }
const tokenOf = (sb: Sandbox) => [...fs.readdirSync(sb.logDir).filter(f => /^dsh\.\d+\.log$/.test(f)).sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
  .flatMap(f => [...fs.readFileSync(path.join(sb.logDir, f), 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].map(m => m[1]!))].at(-1)!

it('G14 ③a：结案任务上的等你定答了 ⇒ 交给总管并叫醒，不直送成员', async () => {
  const base = path.join(E2E_WORK, `g14ask-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g14-ask-closed', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 0, patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }
  const masterReqs = () => sb.mock.requests().filter(r => r.messages.some(m => m.text?.includes('# 你是总管（会话 ui-m）')))
  const memberReqs = () => sb.mock.requests().filter(r => r.messages.some(m => m.text?.includes('# 你是执行会话（alpha.x）')))
  const settle = async () => { await quiet(); await sleep(8000); await quiet() }

  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  await run('ui-m', call('master_spawn', { name: 'x', title: '成员 X' }))
  await run('ui-m', call('master_dispatch', { task: 'L1118-9', kind: 'light', title: '整理清单', to: 'x', text: '做' }))
  await run('ui-m', call('master_ask_user', { task: 'L1118-9', question: '清单用表格还是一行一个？', options: ['表格', '一行一个'] }))
  await run('alpha.x', call('master_report', { task: 'L1118-9', state: '完成', action: '做完了，先用一行一个' }))
  await settle()

  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  const api = (pathq: string, body?: unknown) => p.ev<any>(body === undefined
    ? `fetch('${pathq}',{credentials:'same-origin'}).then(r=>r.json())`
    : `fetch('${pathq}',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-dsh-master':'1'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status, body:await r.json()}))`)
  const st = await api('/api/dsh-master/state?session=ui-m')
  expect(st.tasks.find((t: any) => t.id === 'L1118-9')?.state).toBe('完成')
  expect(st.tasks.find((t: any) => t.id === 'L1118-9')?.talkTo).toBe('ui-m')
  const ask = st.asks.find((a: any) => a.task === 'L1118-9')
  expect(ask).toBeDefined()
  const m0 = masterReqs().length; const x0 = memberReqs().length
  const res = await api('/api/dsh-master/action?session=ui-m', { action: 'answer', ask: Number(ask.id), answer: '表格' })
  expect(res).toMatchObject({ status: 200, body: { ok: true, to: 'ui-m' } })
  await settle()
  const woke = masterReqs().slice(m0).filter(r => r.messages.some(m => m.role === 'user' && m.text?.includes('回答等你定') && m.text.includes('表格')))
  expect(woke.length).toBeGreaterThanOrEqual(1)
  expect(memberReqs().slice(x0).filter(r => r.messages.some(m => m.role === 'user' && m.text?.includes('回答：表格')))).toHaveLength(0)
}, 300_000)
