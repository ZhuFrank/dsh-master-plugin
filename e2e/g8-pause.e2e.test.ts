/**
 * G8 暂停 / 恢复项目总管（假模型 + 沙盒 + 真定时服务 60 秒 + 独立无头 Chrome；不碰 3090 / 3082）：
 * - 看板「暂停总管」⇒ 这个总管的定时保底没了；有新发现（等你定）也不再叫醒模型；成员一轮结束没回报不提醒；
 *   用户直接找总管：照常有工具，守则里写着已暂停；看板顶上有「已暂停」；重启后仍是暂停、不重建定时保底；
 * - 看板「恢复」⇒ 定时保底回来且只有一条（再点一次恢复也不多建）；保底照常因为新发现叫醒模型；
 * - 总管自己调 master_pause ⇒ 同样暂停（by = 总管会话），恢复仍由用户点。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, type CdpPage, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const gitRepo = (d: string) => { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) }
const tokenOf = (sb: Sandbox) => [...fs.readdirSync(sb.logDir).filter(f => /^dsh\.\d+\.log$/.test(f)).sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
  .flatMap(f => [...fs.readFileSync(path.join(sb.logDir, f), 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].map(m => m[1]!))].at(-1)!
const MARK = '定时巡检保底消息'

it('G8：看板暂停 / 恢复项目总管，master_pause，重启后仍暂停', async () => {
  const base = path.join(E2E_WORK, `g8-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g8', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master'), path.join(ROOT, 'spike/g5g-probe-plugin')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, masterCwd: gitRepo(path.join(base, 'legacy-master')), scheduleEverySeconds: 60, patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }
  const events = (type: string) => sb.get(`/dsh-master-debug/events?project=alpha&type=${encodeURIComponent(type)}`) as Promise<any[]>
  const mySchedules = async () => (((await sb.get('/dsh-master-debug/schedules')) ?? []) as any[]).filter(c => c.sessionId === 'ui-m' && String(c.title).startsWith('dsh-master 定时巡检保底') && c.status !== 'inactive')
  const schedReqs = () => sb.mock.requests().filter(r => r.messages.some(m => m.role === 'user' && m.text.includes(MARK)) && r.messages.some(m => m.text.includes('# 你是总管（会话 ui-m）')))

  // ── 开张、建成员、等定时保底建好 ──
  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  await run('ui-m', call('master_spawn', { name: 'x', title: '成员 X' }))
  await sb.waitFor('定时保底建好', async () => (await mySchedules()).length === 1 || undefined)
  // 制造一个新发现：没暂停的话，下一次保底会因为它叫醒模型
  await run('ui-m', call('master_ask_user', { task: 'L1107-9', question: '要不要继续？', options: ['要', '不要'] }))

  // ── 看板上点「暂停总管」──
  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  const openBoard = async (p: CdpPage) => {
    await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
    await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
    await p.waitFor('探针客户端', `!!window.__g6probe`, 15_000)
    await p.ev(`window.__g6probe.openSession('ui-m')`); await sleep(2000)
    await p.ev(`[...document.querySelectorAll('[data-testid=dshm-header-board]')].find(e=>e.offsetParent!==null)?.click()`)
    await p.waitFor('alpha 看板', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-testid=dshm-pause]')`, 20_000)
  }
  let p: CdpPage = await chrome.page(); await p.size(1280, 860)
  await openBoard(p)
  expect(await p.ev<string>(`${board}.querySelector('[data-testid=dshm-pause]').innerText`)).toBe('暂停总管')
  await p.ev(`${board}.querySelector('[data-testid=dshm-pause]').click()`)
  await p.waitFor('已暂停横幅', `!!${board}.querySelector('[data-testid=dshm-paused]') && ${board}.querySelector('[data-testid=dshm-pause]').innerText === '恢复'`, 15_000)
  expect(await p.ev<string>(`${board}.querySelector('[data-testid=dshm-paused]').innerText`)).toMatch(/^项目已暂停/)
  expect((await events('project/paused')).map((e: any) => e.data.by)).toEqual(['user'])
  expect(await mySchedules()).toEqual([])

  // ── 暂停中：保底不来、不叫醒模型（等过一个保底周期还多）；成员一轮结束不提醒 ──
  const before = schedReqs().length
  await run('ui-m', call('master_dispatch', { task: 'L1107-1', kind: 'light', title: '暂停中派的活', to: 'x', text: 'PAUSED-DISPATCH-MARK' }))
  await sb.waitFor('成员收到派活（投递照常）', () => sb.mock.requests().some(r => r.messages.some(m => m.text.includes('PAUSED-DISPATCH-MARK') && m.text.includes('发给 alpha.x'))) || undefined, 30_000)
  await sleep(75_000); await quiet()
  expect(schedReqs().length, '暂停中保底消息不该进模型').toBe(before)
  expect(sb.mock.requests().some(r => r.messages.some(m => m.role === 'user' && m.text.includes('alpha.x 一轮结束了'))), '暂停中不该提醒总管').toBe(false)
  expect((await events('reminder/paused')).length).toBeGreaterThanOrEqual(1)

  // ── 用户直接找总管：照常有工具，守则里写着已暂停 ──
  await run('ui-m', '你好 PAUSED-HI')
  const hi = sb.mock.requests().find(r => r.messages.some(m => m.role === 'user' && m.text.includes('PAUSED-HI')))!
  expect(hi.tools).toEqual(expect.arrayContaining(['master_dispatch', 'master_review', 'master_sessions']))
  expect(hi.messages.some(m => m.text.includes('## 这个项目已暂停'))).toBe(true)

  // ── 重启后仍是暂停：不重建定时保底 ──
  await p.close()
  await sb.restart(); await sleep(6000)
  expect(await mySchedules()).toEqual([])
  p = await chrome.page(); await p.size(1280, 860)
  await openBoard(p)
  expect(await p.ev(`!!${board}.querySelector('[data-testid=dshm-paused]')`)).toBe(true)

  // ── 看板上点「恢复」：定时保底回来且只有一条；再恢复一次也不多建 ──
  await p.ev(`${board}.querySelector('[data-testid=dshm-pause]').click()`)
  await p.waitFor('恢复了', `!${board}.querySelector('[data-testid=dshm-paused]') && ${board}.querySelector('[data-testid=dshm-pause]').innerText === '暂停总管'`, 15_000)
  await sb.waitFor('定时保底回来', async () => (await mySchedules()).length === 1 || undefined)
  const again = await p.ev<any>(`fetch('/api/dsh-master/action?session=ui-m',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-dsh-master':'1'},body:JSON.stringify({action:'resume'})}).then(r=>r.json())`)
  expect(again).toMatchObject({ ok: true, resumed: false, notPaused: true })
  expect(await mySchedules()).toHaveLength(1)
  expect((await events('project/resumed')).map((e: any) => e.data.by)).toEqual(['user'])
  // 恢复后保底照常：还没见过的发现（等你定）让它叫醒模型
  const n0 = schedReqs().length
  await sb.waitFor('恢复后保底叫醒了模型', () => schedReqs().length > n0 || undefined, 150_000)

  // ── 总管自己调 master_pause：同样暂停（by = 总管），没有 master_resume ──
  await quiet()
  await run('ui-m', call('master_pause', { reason: '用户说先停一下' }))
  await sb.waitFor('总管暂停了', async () => (await events('project/paused')).length === 2 || undefined)
  expect((await events('project/paused')).at(-1).data).toMatchObject({ by: 'ui-m', reason: '用户说先停一下' })
  expect(await mySchedules()).toEqual([])
  expect(sb.mock.requests().at(-1)!.tools).not.toContain('master_resume')
  await p.close()
}, 420_000)
