/**
 * G10：README 用的截图（沙盒 + 假模型 + 演示数据，不用任何真实会话）。只在 DSHM_SHOTS=1 时跑，产物写到 public/docs/images/。
 * Screenshots for the README, made in a throw-away sandbox with a mock model and demo data. Runs only with DSHM_SHOTS=1.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, type CdpPage, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = fs.existsSync(path.join(ROOT, 'public')) ? path.join(ROOT, 'public/docs/images') : path.join(ROOT, 'docs/images') // 开发仓库写 public/，公开仓库写 docs/
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const tokenOf = (sb: Sandbox) => [...fs.readdirSync(sb.logDir).filter(f => /^dsh\.\d+\.log$/.test(f)).sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
  .flatMap(f => [...fs.readFileSync(path.join(sb.logDir, f), 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].map(m => m[1]!))].at(-1)!

it.runIf(process.env.DSHM_SHOTS === '1')('G10 截图：演示项目的看板与任务详情', async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const base = path.join(E2E_WORK, `g10shots-${Date.now()}`)
  const proj = path.join(base, 'todo-api'); fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
  execFileSync('git', ['init', '-q', proj]); const root = fs.realpathSync(proj)
  const sb = await createSandbox({ name: 'g10-shots', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master'), path.join(ROOT, 'spike/g5g-probe-plugin')],
    pluginConfig: { idleGraceMs: 600_000, fakeFreeGb: 32, scheduleEverySeconds: 21600, patrol: { intervalMs: 3_600_000 }, legacy: undefined, projectMasterPreset: undefined } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await prompt(sid, text); await quiet() }

  // 开张演示项目 todo-api
  await sb.post('/dsh-master-debug/create', { id: 'lead', cwd: root, preset: 'dsh-master-master' })
  await sb.waitFor('开张', async () => (await sb.get('/dsh-master-debug/projects')).units.includes('todo-api'))
  await quiet()
  await run('lead', call('master_spawn', { name: 'api', title: '接口', purpose: '登录与会话接口' }))
  await run('lead', call('master_spawn', { name: 'web', title: '前端', purpose: '登录页与表单' }))
  await run('lead', call('master_spawn', { name: 'docs', title: '文档', purpose: 'README 与接口文档' }))
  const out = path.join(root, '.dsh-master', 'out', 'T001'); fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'login-api.md'), '# POST /login\n\n- 200：返回会话令牌\n- 401：用户名或密码错误\n- 429：失败次数过多\n')
  fs.writeFileSync(path.join(out, 'test-report.txt'), 'auth.test.ts  12 passed\nsession.test.ts  7 passed\n')
  await run('lead', call('task_spec_write', { task: 'T001', title: '用户登录接口', expected: '3h', output: out, resume: '从最后一道没过的闸门接着做',
    目标: '实现 POST /login 和会话续期', 要读的: 'src/server.ts', 交付物: '接口、单测、接口文档', 验收标准: '单测全过；错误码与文档一致', 红线: '不改数据库结构',
    gates: [{ id: 'G1', title: '接口与单测', produces: path.join(out, 'test-report.txt') }, { id: 'G2', title: '接口文档', produces: path.join(out, 'login-api.md') }] }))
  await run('lead', call('master_dispatch', { task: 'T001', kind: 'heavy', title: '用户登录接口', to: 'api', gate: 'G1', text: '按任务书做，G1 停下等验收', claims: ['src/auth'] }))
  await run('lead', call('task_spec_write', { task: 'T002', title: '登录页', expected: '2h', output: path.join(root, '.dsh-master', 'out', 'T002'), resume: '接着做',
    目标: '登录表单与错误提示', 要读的: '接口文档', 交付物: '登录页', 验收标准: '三种错误都有提示', 红线: '不引入新依赖', gates: [{ id: 'G1', title: '表单与校验' }] }))
  await run('lead', call('master_dispatch', { task: 'T002', kind: 'heavy', title: '登录页', to: 'web', gate: 'G1', text: '等 T001 的接口文档', claims: ['src/web'] }))
  await run('lead', call('master_dispatch', { task: 'L1107-1', kind: 'light', title: 'README 补安装说明', to: 'docs', text: '补「安装」一节' }))
  await run('todo-api.api', call('master_report', { task: 'T001', state: '进展', action: '接口写好，正在补单测' }))
  await run('todo-api.api', call('master_report', { task: 'T001', state: '就绪', gate: 'G1', action: 'G1：接口与单测完成，19 个全过', body: `产物：${path.join(out, 'test-report.txt')}` }))
  await run('lead', call('master_review', { task: 'T001', verdict: '通过', gate: 'G1', notes: '核过测试报告，19 个全过；错误码和任务书一致' }))
  await run('lead', call('master_ask_user', { task: 'T001', question: '登录失败几次后暂时锁定账号？', options: ['5 次', '10 次', '不锁定'] }))
  await run('todo-api.web', call('master_report', { task: 'T002', state: '受阻', action: '等 T001 的接口文档（G2）再接错误提示' }))
  await run('todo-api.docs', call('master_report', { task: 'L1107-1', state: '完成', action: 'README 加了「安装」一节（3 段）' }))
  await run('lead', call('master_review', { task: 'L1107-1', verdict: '通过', notes: '看过，步骤能照着走' }))

  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p: CdpPage = await chrome.page(); await p.size(1440, 900)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('探针客户端', `!!window.__g6probe`, 15_000)
  await p.ev(`window.__g6probe.openSession('lead')`); await sleep(2500)
  await p.ev(`[...document.querySelectorAll('[data-testid=dshm-header-board]')].find(e=>e.offsetParent!==null)?.click()`)
  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  await p.waitFor('看板', `${board}?.dataset.project === 'todo-api' && !!${board}.querySelector('[data-task="T001"]') && !!${board}.querySelector('[data-ask]')`, 20_000)
  await sleep(1500)
  // 只截右侧看板那一栏（中间是假模型的对话，侧栏标题也是假模型起的，不进 README）
  const clip = async () => p.ev<{ x: number; y: number; width: number; height: number }>(`(()=>{const r=${board}.getBoundingClientRect();return {x:Math.max(0,r.left-8),y:Math.max(0,r.top-8),width:Math.min(innerWidth-r.left+8,r.width+16),height:Math.min(innerHeight-r.top+8,r.height+16)}})()`)
  await p.shot(path.join(OUT, 'board.png'), await clip())
  await p.ev(`${board}.querySelector('[data-task="T001"]').click()`); await sleep(2500)
  // 只看回报 / 验收：时间线里不显示假模型的对话原文（CALL …）
  await p.ev(`(()=>{const b=[...${board}.querySelectorAll('button')].find(e=>e.innerText.trim().startsWith('只看回报'));b&&b.click()})()`); await sleep(1500)
  await p.shot(path.join(OUT, 'task.png'), await clip())
  for (const f of ['board.png', 'task.png']) expect(fs.statSync(path.join(OUT, f)).size).toBeGreaterThan(20_000)
}, 400_000)
