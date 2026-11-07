/**
 * G5-F 打磨轮端到端（假模型 + 沙盒 + 独立无头 Chrome；不碰 3090 / 3082）：
 * ② 等你点补扫：记录器清空（等同插件刚启动）后补扫，把还挂着的审批 / 提问补回来；在宿主里答完，补进来的那条消失；
 *    宿主正常重启会把挂着的取消，重启后启动补扫一条都不补；
 * ③ 轻任务验收：回报完成 → 总管 master_review → 时间线「只看回报 / 验收」里有「验收」；
 * ④ 产物：路径后紧跟全角括号也认得出；
 * ⑥ 横幅不露 session-<长 ID>；
 * ⑧ 390 宽时看板顶部按钮全部在屏幕内。
 */
import fs from 'node:fs'
import path from 'node:path'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, type CdpPage, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'docs/g5f'); fs.mkdirSync(OUT, { recursive: true })
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const tokenOf = (sb: Sandbox) => {
  const logs = fs.readdirSync(sb.logDir).filter(f => f.startsWith('dsh.')).map(f => path.join(sb.logDir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
  return [...fs.readFileSync(logs.at(-1)!, 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)![1]!
}
const QID = 'session-5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

it('G5-F：补扫 / 轻任务验收 / 产物 / 横幅名字 / 窄屏按钮', async () => {
  const base = path.join(E2E_WORK, `g5f-${Date.now()}`)
  const wDir = path.join(base, 'w'); for (const d of ['w', 'q', 'a']) fs.mkdirSync(path.join(base, d), { recursive: true })
  fs.writeFileSync(path.join(wDir, 'stats.md'), '# 统计\n')
  const sb = await createSandbox({ name: 'g5f', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, patrol: { rescanMs: 500 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const dstate = () => sb.get('/dsh-master-debug/state')
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const waitingDbg = () => sb.get('/dsh-master-debug/waiting') as Promise<any[]>

  // ── ③ ④ 轻任务：回报完成（路径后紧跟全角括号）→ 总管验收 ──
  await prompt('master', call('master_spawn', { name: 'w', cwd: wDir, title: '执行 W' }))
  await sb.waitFor('exec-w', async () => (await dstate()).sessions.find((x: any) => x.id === 'exec-w'))
  await prompt('master', call('master_dispatch', { task: 'L1105-1', kind: 'light', title: '统计 md', to: 'w', text: '统计' }))
  await sb.waitFor('任务', async () => (await dstate()).tasks.find((t: any) => t.id === 'L1105-1'))
  await quiet()
  await prompt('exec-w', call('master_report', { task: 'L1105-1', state: '完成', action: '统计写好了', body: `产物：${path.join(wDir, 'stats.md')}（601B，16 行；该目录下唯一文件）` }))
  await sb.waitFor('结案', async () => (await dstate()).tasks.find((t: any) => t.id === 'L1105-1' && t.state === '完成'))
  await quiet()
  await prompt('master', call('master_review', { task: 'L1105-1', verdict: '通过', notes: '自己数过 16 行，对' }))
  // 验收是否写进时间线，下面在看板里看
  await quiet()

  // ── ② 挂着一个提问（没命名的会话 ID）+ 一个审批 ──
  await sb.post('/dsh-master-debug/create', { id: QID, cwd: path.join(base, 'q') })
  await sb.post('/dsh-master-debug/create', { id: 'plain-a', cwd: path.join(base, 'a') })
  await prompt(QID, call('ask_user_question', { questions: [{ id: 'q1', question: '补扫测试：选哪个？', options: [{ label: '方案A' }, { label: '方案B' }] }] }))
  await prompt('plain-a', call('bash', { description: 'touch outside', command: `touch /tmp/g5f-${Date.now()}`, sandbox_permissions: 'danger-full-access', justification: '补扫测试' }))
  await sb.waitFor('两条等你点', async () => (await waitingDbg()).length === 2)
  // 记录器清空（等同插件刚启动、没看到这两次 waterfall）→ 补扫补回来
  await sb.post('/dsh-master-debug/waiting-forget', {})
  expect(await waitingDbg()).toEqual([])
  const rs = await sb.post('/dsh-master-debug/waiting-rescan', {})
  expect(rs.result).toMatchObject({ added: 2 })
  expect(rs.waiting.map((w: any) => [w.session, w.kind, w.backfilled]).sort()).toEqual([['plain-a', 'approval', true], [QID, 'question', true]])
  expect(rs.waiting.find((w: any) => w.kind === 'question').label).toBe('补扫测试：选哪个？')
  // 再扫一次不会重复
  expect((await sb.post('/dsh-master-debug/waiting-rescan', {})).waiting).toHaveLength(2)

  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p: CdpPage = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('补扫进来的横幅', `document.querySelectorAll('[data-testid=dshm-waiting] [data-wait-session]').length === 2`, 20_000)
  // ⑥ 横幅不露 session-<长 ID>
  const banner = await p.ev<string>(`document.querySelector('[data-testid=dshm-waiting]').innerText`)
  expect(banner).not.toContain('session-5a1b2c3d')
  expect(banner).toMatch(/等你回答 \d+ 分钟：补扫测试：选哪个？/)
  await p.shot(path.join(OUT, '1280-backfilled-banner.png'))

  // ③ 时间线「只看回报 / 验收」里有验收；④ 产物认出 stats.md
  await p.waitFor('看板任务', `!!document.querySelector('[data-testid=dsh-master-board] [data-task="L1105-1"]')`, 15_000)
  await p.ev(`document.querySelector('[data-testid=dsh-master-board] [data-task="L1105-1"]').click()`)
  await p.waitFor('任务详情', `document.querySelectorAll('[data-testid=dshm-timeline] [data-item-no]').length >= 2`)
  expect(await p.ev<string>(`document.querySelector('[data-testid=dsh-master-board]').innerText`)).toMatch(/产物[\s\S]{0,40}stats\.md/)
  await p.ev(`[...document.querySelectorAll('[data-testid=dsh-master-board] button')].find(b=>b.textContent.trim()==='只看回报 / 验收').click()`); await sleep(500)
  const kinds = await p.ev<string[]>(`[...document.querySelectorAll('[data-testid=dshm-timeline] [data-kind=event] .k')].map(e=>e.textContent.trim())`)
  expect(kinds).toEqual(['验收', '回报'])
  expect(await p.ev<string>(`document.querySelector('[data-testid=dshm-timeline]').innerText`)).toContain('自己数过 16 行，对')
  await p.shot(path.join(OUT, '1280-light-reviewed.png'))

  // ② 在宿主里回答补扫进来的提问 → 那条消失（没有 waterfall 的 finally，靠宿主事件）
  await p.ev(`(()=>{const b=[...document.querySelectorAll('[data-wait-session]')].find(b=>b.dataset.waitSession===${JSON.stringify(QID)});b.click()})()`)
  await p.waitFor('跳到提问的会话', `[...document.querySelectorAll('button,[role=option],[role=radio]')].some(b=>b.textContent.includes('方案A'))`, 15_000)
  await p.ev(`(()=>{const c=[...document.querySelectorAll('button,[role=option],[role=radio],label,div')].filter(e=>e.textContent.trim().endsWith('方案A')&&e.textContent.trim().length<=6);const b=c.sort((x,y)=>x.textContent.length-y.textContent.length||y.querySelectorAll('*').length-x.querySelectorAll('*').length)[0];(b.closest('button,[role=option],[role=radio],label')||b).click()})()`); await sleep(600)
  await p.waitFor('提交可点', `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='提交'&&!b.disabled)`, 5000)
  await p.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='提交').click()`)
  await sb.waitFor('补扫进来的提问答完就消失', async () => (await waitingDbg()).every((w: any) => w.session !== QID))
  expect((await waitingDbg()).map((w: any) => w.session)).toEqual(['plain-a'])

  // ⑧ 390：顶部按钮全部在屏幕内
  await p.size(390, 844); await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('手机看板', `!!document.querySelector('[data-testid=dshm-board-tools]')`, 15_000)
  const off = await p.ev<string[]>(`[...document.querySelectorAll('[data-testid=dshm-board-tools] button')].filter(b=>{const r=b.getBoundingClientRect();return r.right>innerWidth+0.5||r.left<-0.5}).map(b=>b.textContent.trim())`)
  expect(off).toEqual([])
  expect(await p.ev(`[...document.querySelectorAll('[data-testid=dshm-board-tools] button')].some(b=>/^会话（\\d+）$/.test(b.textContent.trim()))`)).toBe(true)
  await p.shot(path.join(OUT, '390-board-tools.png'))
  expect(await p.ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  await p.close()

  // ② 宿主正常重启：挂着的审批被宿主取消，启动补扫一条都不补
  await sb.restart()
  await sb.waitFor('启动补扫跑过', async () => { try { return (await sb.get('/dsh-master-debug/state')) && true } catch { return false } })
  await sleep(2500)
  expect(await waitingDbg()).toEqual([])
  // 手动再扫一次也一样：两个会话的记录里都已经有结果（审批 cancelled、提问已答）
  expect((await sb.post('/dsh-master-debug/waiting-rescan', {})).result).toMatchObject({ added: 0 })

  // ② 宿主被强杀：记录里审批「问了没结果」，但宿主说这个会话没在跑（再打开时宿主自己修）⇒ 启动补扫不补
  fs.mkdirSync(path.join(base, 'k'), { recursive: true })
  await sb.post('/dsh-master-debug/create', { id: 'plain-k', cwd: path.join(base, 'k') })
  await prompt('plain-k', call('bash', { description: 'touch outside', command: `touch /tmp/g5f-k-${Date.now()}`, sandbox_permissions: 'danger-full-access', justification: '强杀测试' }))
  await sb.waitFor('强杀前在等', async () => (await waitingDbg()).some((w: any) => w.session === 'plain-k'))
  await sb.stop('SIGKILL'); await sb.start()
  await sleep(2500)
  expect(await waitingDbg()).toEqual([])
  const r2 = (await sb.post('/dsh-master-debug/waiting-rescan', {})).result
  expect(r2.added).toBe(0); expect(r2.notRunning).toBeGreaterThan(0)
}, 300_000)
