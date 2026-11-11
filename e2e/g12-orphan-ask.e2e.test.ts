/**
 * G12「先问后派」（沙盒 + 假模型 + 无头 Chrome；不碰 ~/.dsh、3080 / 3081 / 3090 / 3095 / 3096）：
 * 总管还没建任务就 master_ask_user（task 指向一个还不存在的任务）⇒
 * 1. 看板默认视图和「只看等我」里都能看到这张卡片（在「还没建任务的提问」那块）；
 * 2.「只看等我」里卡片的张数 = 状态栏「等你定」的计数（两处数字对得上）；
 * 3. 在看板上点选项就能答：问题结案，状态栏计数归零。
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

it('G12：先问后派——没有任务的「等你定」在看板上能看到、计数对得上、能答', async () => {
  const base = path.join(E2E_WORK, `g12o-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g12-orphan', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }

  await sb.post('/dsh-master-debug/create', { id: 'o-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'o-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  // 对照：一件真任务、挂在它下面的提问（老路径，照旧显示在任务下面）
  await run('o-m', call('master_spawn', { name: 'x', title: '成员 X' }))
  await run('o-m', call('master_dispatch', { task: 'L1111-7', kind: 'light', title: '已有的活', to: 'x', text: '做' }))
  await run('o-m', call('master_ask_user', { task: 'L1111-7', question: 'G12-UNDER-TASK 挂在任务下面的问题？', options: ['是', '否'] }))
  // 先问后派：L1111-8 还没建
  await run('o-m', call('master_ask_user', { task: 'L1111-8', question: 'G12-ORPHAN 语气要口语还是书面？', options: ['口语', '书面'] }))
  await sleep(2000)

  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p = await chrome.page(); await p.size(1280, 900)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  const st = await p.ev<any>(`fetch('/api/dsh-master/state?session=o-m',{credentials:'same-origin'}).then(r=>r.json())`)
  expect(st.statusBar.counts.asks).toBe(2)
  expect(st.tasks.some((t: any) => t.id === 'L1111-8')).toBe(false) // 前提：这个任务确实还不存在

  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`, 15_000)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('项目列表', `!!document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]')`, 15_000)
  await p.ev(`document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]').click()`)
  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  await p.waitFor('状态栏', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-testid=dshm-status-bar]')`, 20_000)
  const cards = () => p.ev<string[]>(`[...${board}.querySelectorAll('[data-ask]')].map(e=>e.innerText.replace(/\\s+/g,' '))`)

  // 1. 默认视图：两张卡片都在，孤立的那张在「还没建任务的提问」里
  await p.waitFor('默认视图出现孤立的提问', `[...${board}.querySelectorAll('[data-ask]')].some(e=>e.innerText.includes('G12-ORPHAN'))`, 10_000)
  expect((await cards()).some(c => c.includes('G12-UNDER-TASK'))).toBe(true)
  expect(await p.ev<boolean>(`!!${board}.querySelector('[data-group="orphan-asks"]') && [...${board}.querySelectorAll('[data-group="orphan-asks"] ~ [data-ask]')].some(e=>e.innerText.includes('G12-ORPHAN'))`)).toBe(true)

  // 2.「只看等我」：卡片张数 = 状态栏「等你定」计数
  await p.ev(`${board}.querySelector('[data-testid=dshm-sb-counts] [data-count=asks]').click()`)
  await p.waitFor('只看等我', `[...${board}.querySelectorAll('button')].some(b=>b.innerText.startsWith('只看等我') && b.getAttribute('aria-pressed')==='true')`, 10_000)
  await sleep(800)
  const inMine = await cards()
  const barText = await p.ev<string>(`${board}.querySelector('[data-testid=dshm-status-bar]').innerText`)
  console.log('G12 只看等我：', inMine, '| 状态栏：', barText.replace(/\n/g, ' | '))
  expect(inMine.some(c => c.includes('G12-ORPHAN'))).toBe(true)
  expect(barText).toContain(`等你定 ${inMine.length}`)
  expect(inMine.length).toBe(2)

  // 3. 在看板上答孤立的那张
  await p.ev(`[...${board}.querySelectorAll('[data-ask]')].find(e=>e.innerText.includes('G12-ORPHAN')).querySelector('button').click()`)
  await sb.waitFor('孤立的提问结案', async () => (await sb.get('/dsh-master-debug/events?type=ask/answered&project=alpha')).some((e: any) => String(e.data?.answer ?? '').includes('口语')) || undefined, 20_000)
  await p.waitFor('卡片消失、计数变 1', `![...${board}.querySelectorAll('[data-ask]')].some(e=>e.innerText.includes('G12-ORPHAN')) && ${board}.querySelector('[data-testid=dshm-status-bar]').innerText.includes('等你定 1')`, 15_000)
}, 300_000)
