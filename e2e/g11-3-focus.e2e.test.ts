/**
 * G11-3 Focus 区 + 按日期折叠（沙盒 + 假模型 + 无头 Chrome；不碰 ~/.dsh、3080 / 3090）：
 * 1. 默认视图按日期分组（今天）；点任务行的 ☆ ⇒ 移进「★ Focus」组，接口 focus=true；
 * 2. 换一个全新用户目录的 Chrome（= 另一台设备）打开，Focus 还在 ⇒ 存的是项目库，不是浏览器；
 * 3. 点「今天」组标题收起 ⇒ 行不见了、aria-expanded=false；刷新后还收着（同一个浏览器的显示偏好）；
 * 4. 再点 ★ 取消置顶 ⇒ 回到日期组。
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

it('G11-3：Focus 置顶（存项目库，换设备还在）、按日期分组、组可折叠（刷新后保持）、取消置顶', async () => {
  const base = path.join(E2E_WORK, `g11f-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g11-focus', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 0, patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }
  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  await run('ui-m', call('master_spawn', { name: 'x', title: '成员 X' }))
  await run('ui-m', call('master_dispatch', { task: 'L1107-31', kind: 'light', title: '第一件', to: 'x', text: '做' }))
  await run('ui-m', call('master_dispatch', { task: 'L1107-32', kind: 'light', title: '第二件', to: 'x', text: '做' }))
  await sleep(4000); await quiet()

  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  const openBoard = async (p: CdpPage) => {
    await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
    await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
    await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`, 15_000)
    await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
    await p.waitFor('项目列表', `!!document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]')`, 15_000)
    await p.ev(`document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]').click()`)
    await p.waitFor('alpha 看板', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-task="L1107-31"]')`, 20_000)
  }
  /** 每个组标题后面跟着哪些任务行（直到下一个组标题） */
  const groupsOf = (p: CdpPage) => p.ev<Record<string, string[]>>(`(()=>{const out={};let cur=null;for(const el of ${board}.querySelectorAll('[data-group],[data-task]')){if(el.dataset.group){cur=el.dataset.group;out[cur]=[]}else if(cur&&el.matches('.dshm-row'))out[cur].push(el.dataset.task)}return out})()`)
  const api = (p: CdpPage) => p.ev<any>(`fetch('/api/dsh-master/state?session=ui-m',{credentials:'same-origin'}).then(r=>r.json())`)

  const chrome1 = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome1') })
  cleanups.push(() => chrome1.kill())
  const p = await chrome1.page(); await p.size(1280, 900)
  await openBoard(p)
  const today = String((await api(p)).now).slice(0, 10)
  const dayKey = `day:${today}`
  // 1. 默认：两件都在「今天」组；没有 Focus 组
  let g = await groupsOf(p)
  console.log('G11-3 初始分组：', JSON.stringify(g))
  expect(Object.keys(g)).not.toContain('focus')
  expect(g[dayKey]?.sort()).toEqual(['L1107-31', 'L1107-32'])
  expect(await p.ev<string>(`${board}.querySelector('[data-group="${dayKey}"]').innerText`)).toMatch(/今天 · 2$/)
  // 点 L1107-32 的 ☆ ⇒ 进 Focus 组；接口 focus=true
  await p.ev(`${board}.querySelector('[data-focus-task="L1107-32"]').click()`)
  await p.waitFor('进了 Focus 组', `!!${board}.querySelector('[data-group="focus"]')`, 10_000)
  g = await groupsOf(p)
  expect(g.focus).toEqual(['L1107-32'])
  expect(g[dayKey]).toEqual(['L1107-31'])
  expect((await api(p)).tasks.find((t: any) => t.id === 'L1107-32').focus).toBe(true)
  expect(await p.ev<string>(`${board}.querySelector('[data-focus-task="L1107-32"]').getAttribute('aria-pressed')`)).toBe('true')

  // 2. 另一台设备（全新用户目录的 Chrome）：Focus 还在 ⇒ 存在项目库
  const chrome2 = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome2') })
  cleanups.push(() => chrome2.kill())
  const p2 = await chrome2.page(); await p2.size(390, 844)
  await openBoard(p2)
  expect((await groupsOf(p2)).focus).toEqual(['L1107-32'])
  await chrome2.kill()

  // 3. 折叠「今天」组 ⇒ 行不见、aria-expanded=false；刷新后还收着
  await p.ev(`${board}.querySelector('[data-group="${dayKey}"]').click()`)
  await p.waitFor('收起了', `${board}.querySelector('[data-group="${dayKey}"]').getAttribute('aria-expanded') === 'false' && !${board}.querySelector('[data-task="L1107-31"]')`, 5000)
  expect(await p.ev<string>(`${board}.querySelector('[data-group="${dayKey}"]').innerText`)).toMatch(/^▸/)
  await openBoard(p).catch(() => {}) // 刷新：L1107-31 收着看不到，openBoard 等它会超时，下面单独等
  await p.waitFor('刷新后看板', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-group="${dayKey}"]')`, 20_000)
  expect(await p.ev<string>(`${board}.querySelector('[data-group="${dayKey}"]').getAttribute('aria-expanded')`)).toBe('false')
  expect(await p.ev<boolean>(`!!${board}.querySelector('[data-task="L1107-31"]')`)).toBe(false)
  // 展开回来
  await p.ev(`${board}.querySelector('[data-group="${dayKey}"]').click()`)
  await p.waitFor('展开了', `!!${board}.querySelector('[data-task="L1107-31"]')`, 5000)

  // 4. 取消置顶 ⇒ 回到日期组，Focus 组没了
  await p.ev(`${board}.querySelector('[data-focus-task="L1107-32"]').click()`)
  await p.waitFor('Focus 组没了', `!${board}.querySelector('[data-group="focus"]')`, 10_000)
  expect((await groupsOf(p))[dayKey]?.sort()).toEqual(['L1107-31', 'L1107-32'])
  expect((await api(p)).tasks.find((t: any) => t.id === 'L1107-32').focus).toBe(false)
  // 截图（干净代码那一轮给人看；沙盒数据）：先置顶一件再拍
  await p.ev(`${board}.querySelector('[data-focus-task="L1107-31"]').click()`)
  await p.waitFor('置顶 L1107-31', `!!${board}.querySelector('[data-group="focus"]')`, 10_000)
  const rect = await p.ev<any>(`(()=>{const r=${board}.getBoundingClientRect();return {x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.width,1280),height:Math.min(r.height,520)}})()`)
  fs.mkdirSync(path.join(ROOT, '.tmp/g11'), { recursive: true }); await p.shot(path.join(ROOT, '.tmp/g11/g11-3-focus.png'), rect)
}, 300_000)
