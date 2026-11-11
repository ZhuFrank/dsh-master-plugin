/**
 * G11-2 总管状态栏（沙盒 + 假模型 + 无头 Chrome；不碰 ~/.dsh、3080 / 3090）：
 * 1. 总管跑一条命令里带 Authorization / 令牌的 bash（description「查询接口状态」）⇒ 状态栏只有「bash · 查询接口状态」，
 *    接口返回和看板页面上都没有命令全文（echo、Authorization、Bearer、令牌）；
 * 2. 下次保底有时间（宿主定时服务 scheduledAt）；三个计数：等你定 1 / 等你点 0 / 受阻 1；成员块列出 alpha.x 和它手上的任务；
 * 3. 计数能点：受阻 ⇒ 打开那件任务；等你定 ⇒「只看等我」。
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
const SECRET_WORDS = ['echo', 'Authorization', 'Bearer', 'sk-test-G112SECRET', '/dev/null']

it('G11-2：总管状态栏——正在什么（不漏命令）、下次保底、三个计数、成员块、计数能点', async () => {
  const base = path.join(E2E_WORK, `g11s-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g11-status', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 600, patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }

  // ── 开张、建成员、两件轻任务（一件成员回报受阻）、一件等你定 ──
  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  await run('ui-m', call('master_spawn', { name: 'x', title: '成员 X' }))
  await run('ui-m', call('master_dispatch', { task: 'L1107-21', kind: 'light', title: '整理目录', to: 'x', text: '整理一下' }))
  await run('ui-m', call('master_dispatch', { task: 'L1107-22', kind: 'light', title: '要权限的活', to: 'x',
    text: `做这个\n${call('master_report', { task: 'L1107-22', state: '受阻', action: '缺写权限' })}` }))
  await sleep(4000); await quiet() // 成员回报受阻（后面看板接口的计数会核）
  await run('ui-m', call('master_ask_user', { task: 'L1107-21', question: '目录按日期还是按类型？', options: ['日期', '类型'] }))
  await sleep(6000); await quiet()
  // 成员要提权跑命令 ⇒ 宿主弹审批 ⇒ 一件「等你点」（测入口把等你点的条数传给状态栏）
  // 走总管派活，不让用户直接对成员说：用户直接说的话会以「用户直接指示」inject 转给总管，假模型会把里面的 CALL 行当总管自己的调用（G11-1 g5e-link 同一个坑）
  await run('ui-m', call('master_dispatch', { task: 'L1107-23', kind: 'light', title: '写项目外的文件', to: 'x',
    text: `做\n${call('bash', { description: '往项目外写文件', command: `touch /tmp/g112-outside-${Date.now()}`, sandbox_permissions: 'danger-full-access', justification: '测试提权审批' })}` }))
  await sb.waitFor('等你点出现', async () => ((await sb.get('/dsh-master-debug/waiting')) ?? []).length > 0 || undefined, 30_000)
  // 最后一步：总管跑一条命令里带令牌的 bash
  await run('ui-m', call('bash', { command: "echo 'Authorization: Bearer sk-test-G112SECRET' > /dev/null", description: '查询接口状态' }))
  await sleep(4000); await quiet()

  // ── 看板接口 ──
  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p = await chrome.page(); await p.size(1280, 900)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  const st = await p.ev<any>(`fetch('/api/dsh-master/state?session=ui-m',{credentials:'same-origin'}).then(r=>r.json())`)
  const bar = st.statusBar
  console.log('G11-2 状态栏：', JSON.stringify(bar))
  expect(bar.master.doing).toBe('bash · 查询接口状态')
  for (const w of SECRET_WORDS) expect(JSON.stringify(bar)).not.toContain(w)
  expect(String(bar.nextSchedule)).toMatch(/^\d{4}-\d\d-\d\d \d{4}$/) // null 也要报成断言失败，不是 TypeError
  expect(bar.counts).toEqual({ asks: 1, waiting: 1, blocked: 1 })
  const x = bar.members.find((m: any) => m.id === 'alpha.x')
  expect(x.tasks.map((t: any) => `${t.id}[${t.state}]`).sort()).toEqual(['L1107-21[进行中]', 'L1107-22[受阻]', 'L1107-23[进行中]'])

  // ── 看板页面 ──
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`, 15_000)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('项目列表', `!!document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]')`, 15_000)
  await p.ev(`document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]').click()`)
  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  await p.waitFor('状态栏', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-testid=dshm-status-bar]')`, 20_000)
  const text = await p.ev<string>(`${board}.querySelector('[data-testid=dshm-status-bar]').innerText`)
  console.log('G11-2 状态栏文字：', text.replace(/\n/g, ' | '))
  expect(text).toContain('bash · 查询接口状态')
  expect(text).toMatch(/下次保底 \S+/)
  expect(text).not.toMatch(/下次保底 —/)
  expect(text).toContain('等你定 1'); expect(text).toContain('等你点 1'); expect(text).toContain('受阻 1')
  expect(text).toMatch(/alpha\.x .*L1107-2[12]/)
  for (const w of SECRET_WORDS) expect(await p.ev<string>(`${board}.innerText`)).not.toContain(w)
  // 给人看的截图：只截看板那一栏（沙盒数据，没有本机路径）
  const rect = await p.ev<any>(`(()=>{const r=${board}.getBoundingClientRect();return {x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.width,1280),height:Math.min(r.height,420)}})()`)
  fs.mkdirSync(path.join(ROOT, '.tmp/g11'), { recursive: true }); await p.shot(path.join(ROOT, '.tmp/g11/g11-2-statusbar.png'), rect)
  // 计数能点：等你点 ⇒ 打开那个会话。看板以外的审批按钮：总管会话里没有，跳到在等审批的 alpha.x 才出现（点之前先确认没有，做对照）
  const approvalBtn = `[...document.querySelectorAll('button')].some(b=>!b.closest('[data-testid=dsh-master-board]') && /^(允许|批准|拒绝|同意|Allow|Deny|Approve|Reject)/.test(b.textContent.trim()))`
  expect(await p.ev<boolean>(approvalBtn)).toBe(false)
  await p.ev(`${board}.querySelector('[data-testid=dshm-sb-counts] [data-count=waiting]').click()`)
  await p.waitFor('打开等你点的会话（出现审批按钮）', approvalBtn, 15_000)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('项目列表', `!!document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]')`, 15_000)
  await p.ev(`document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]').click()`)
  await p.waitFor('状态栏', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-testid=dshm-status-bar]')`, 20_000)
  // 计数能点：受阻 ⇒ 打开那件任务
  await p.ev(`${board}.querySelector('[data-testid=dshm-sb-counts] [data-count=blocked]').click()`)
  await p.waitFor('打开受阻的任务', `!!document.querySelector('[data-testid=dshm-mention-task]') && document.body.innerText.includes('L1107-22')`, 10_000)
  // 回列表，等你定 ⇒「只看等我」
  await p.ev(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='← 任务列表')?.click()`)
  await p.waitFor('回到列表', `!!${board}.querySelector('[data-testid=dshm-status-bar]')`, 10_000)
  await p.ev(`${board}.querySelector('[data-testid=dshm-sb-counts] [data-count=asks]').click()`)
  await p.waitFor('只看等我', `[...${board}.querySelectorAll('button')].some(b=>b.innerText.startsWith('只看等我') && b.getAttribute('aria-pressed')==='true')`, 10_000)
}, 300_000)
