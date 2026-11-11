/**
 * G11-1 消息直送（沙盒 + 假模型 + 无头 Chrome；不碰 3080 / 3090）。验收标准（任务书 T005 G11-1）：
 * 1. 用户直接在成员会话里问一句普通追问、成员只回答不回报 ⇒ 总管的模型请求数 +0（L1107-2 基线是 +1：空闲提醒）；
 *    同一个项目里，派活开的一轮不回报照旧提醒总管（对照，证明提醒机制没被整个关掉）；
 * 2. 看板「回答等你定」⇒ 答案直接到负责的成员（成员多一次请求、里面有答案），总管请求数 +0；
 * 3. 任务卡片 talkTo 指向负责的成员（看板「在对话里提到」打开它）。
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

it('G11-1：直接对话、看板回答等你定，总管请求数都是 +0；派活开的一轮照旧提醒', async () => {
  const base = path.join(E2E_WORK, `g11-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g11-direct', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 0, patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }
  const events = (type: string) => sb.get(`/dsh-master-debug/events?project=alpha&type=${encodeURIComponent(type)}`) as Promise<any[]>
  const masterReqs = () => sb.mock.requests().filter(r => r.messages.some(m => m.text?.includes('# 你是总管（会话 ui-m）')))
  const memberReqs = () => sb.mock.requests().filter(r => r.messages.some(m => m.text?.includes('# 你是执行会话（alpha.x）')))
  /** 等过宽限期（2 秒）再多等，确认没有迟到的提醒 */
  const settle = async () => { await quiet(); await sleep(8000); await quiet() }

  // ── 开张、建成员、派一件轻任务 ──
  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  await run('ui-m', call('master_spawn', { name: 'x', title: '成员 X' }))
  await run('ui-m', call('master_dispatch', { task: 'L1107-9', kind: 'light', title: '演示', to: 'x', text: '做点事' }))
  await settle()

  // ── 1. 用户直接在成员会话里追问（成员只回答、不调 master_report）⇒ 总管 +0 ──
  const m0 = masterReqs().length
  await run('alpha.x', '这个演示任务现在做到哪了？G11-DIRECT-Q')
  await settle()
  expect(memberReqs().some(r => r.messages.some(m => m.role === 'user' && m.text.includes('G11-DIRECT-Q')))).toBe(true)
  const d1 = masterReqs().length - m0
  expect(d1).toBe(0)
  expect((await events('reminder/user-turn')).length).toBe(1)
  expect((await events('user/direct')).length).toBe(1)
  // 「用户直接指示」那条 inject 还在（方案 §2.3 第 5 条选 A）：总管下一次请求里会带上它（下面派活时验）

  // ── 对照：总管再派一次（派活开的一轮），成员不回报 ⇒ 照旧提醒总管 ──
  // 基准要在派活之前取：run() 会等到假模型安静，宽限 2 秒后的提醒可能已经在里面了（第一次跑就是这样漏掉的）
  const m1 = masterReqs().length
  await run('ui-m', call('master_send', { to: 'x', text: '顺便看一下 README，不用回报' }))
  await settle()
  // 只数「这次请求是被提醒叫醒的」：最后一条 user 消息就是提醒（后面的请求带着整段历史，不能 some）
  const lastUser = (r: any) => String([...r.messages].reverse().find((m: any) => m.role === 'user')?.text ?? '')
  const reminders = masterReqs().slice(m1).filter(r => lastUser(r).includes('没有用 master_report 回报'))
  expect(reminders.length).toBeGreaterThanOrEqual(1)
  // 选 A：用户直接说的那句，作为「用户直接指示」进了总管的上下文（夹在这次请求里，没有单独叫醒）
  expect(masterReqs().some(r => r.messages.some(m => m.text?.includes('用户直接指示') && m.text.includes('G11-DIRECT-Q')))).toBe(true)

  // ── 2. 看板「回答等你定」⇒ 直投成员，总管 +0 ──
  await run('ui-m', call('master_ask_user', { task: 'L1107-9', question: '用 A 还是 B？', options: ['A', 'B'] }))
  await settle()
  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  const api = (pathq: string, body?: unknown) => p.ev<any>(body === undefined
    ? `fetch('${pathq}',{credentials:'same-origin'}).then(r=>r.json())`
    : `fetch('${pathq}',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-dsh-master':'1'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status, body:await r.json()}))`)
  const st = await api('/api/dsh-master/state?session=ui-m')
  // 3. talkTo
  expect(st.tasks.find((t: any) => t.id === 'L1107-9')?.talkTo).toBe('alpha.x')
  const ask = st.asks.find((a: any) => a.task === 'L1107-9')
  expect(ask).toBeDefined()
  const m2 = masterReqs().length; const x2 = memberReqs().length
  const res = await api('/api/dsh-master/action?session=ui-m', { action: 'answer', ask: Number(ask.id), answer: 'B' })
  expect(res).toMatchObject({ status: 200, body: { ok: true, to: 'alpha.x' } })
  await settle()
  const toMember = memberReqs().slice(x2).filter(r => r.messages.some(m => m.role === 'user' && m.text.includes('回答等你定') && m.text.includes('回答：B')))
  expect(toMember.length).toBeGreaterThanOrEqual(1)
  for (const r of masterReqs().slice(m2)) { const last = [...r.messages].reverse().find(m => m.role === 'user'); console.log('看板回答后总管多出的请求，最后一条 user 消息：', String(last?.text ?? '').slice(0, 200).replace(/\n/g, ' ')) }
  expect(masterReqs().length - m2).toBe(0)
  const answered = (await events('ask/answered')).at(-1)
  expect(answered?.data).toMatchObject({ answer: 'B', to: 'alpha.x' })
  // ── 3'. 看板任务详情里「在对话里提到」按钮指向负责的成员（接口有 talkTo 不够，要看按钮真用了它）──
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`, 15_000)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('项目列表', `!!document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]')`, 15_000)
  await p.ev(`document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]').click()`)
  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  await p.waitFor('alpha 看板', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-task="L1107-9"]')`, 20_000)
  await p.ev(`${board}.querySelector('[data-task="L1107-9"]').click()`)
  await p.waitFor('任务详情', `!!document.querySelector('[data-testid=dshm-mention-task]')`, 10_000)
  // 详情还没加载完时按钮先指向总管（退回值）——第 6 次跑就是读早了；等它加载完、指向成员（等不到就失败）
  await p.waitFor('按钮指向负责的成员', `document.querySelector('[data-testid=dshm-mention-task]')?.dataset.talkTo === 'alpha.x'`, 15_000)
  expect(await p.ev<string>(`document.querySelector('[data-testid=dshm-mention-task]').dataset.talkTo`)).toBe('alpha.x')
  console.log(`G11-1 实测：直接对话后总管 +${d1}，看板回答后总管 +${masterReqs().length - m2}，对照（派活开的一轮）被提醒叫醒 ${reminders.length} 次`)
}, 300_000)
