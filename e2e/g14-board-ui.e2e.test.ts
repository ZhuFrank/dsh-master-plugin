/**
 * G14 看板界面（沙盒 + 假模型 + 无头 Chrome；不碰 3080 / 3090）：
 * ⑦ 搜索框按编号 / 标题筛、「显示 n / m 个」、清除；
 * ⑨ 收起 ⇒ 行没了、出现「撤销」；撤销 ⇒ 行回来；再收起 ⇒ 「已收起（1）」视图里有；已结束的「归档」⇒ 「已归档」视图里有、「恢复」⇒ 回到列表；
 * ③c / ⑤ 状态栏：等你定计数、下次提醒。
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

it('G14 看板：搜索、收起 / 撤销 / 已收起、归档 / 恢复、状态栏下次提醒', async () => {
  const base = path.join(E2E_WORK, `g14ui-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g14-board-ui', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
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
  await run('ui-m', call('master_dispatch', { task: 'L1118-1', kind: 'light', title: '整理脚本', to: 'x', text: '做' }))
  await run('ui-m', call('master_dispatch', { task: 'L1118-2', kind: 'light', title: '改 README', to: 'x', text: '做' }))
  await run('ui-m', call('master_dispatch', { task: 'L1118-3', kind: 'light', title: 'Release 打包', to: 'x', text: '做' }))
  await run('alpha.x', call('master_report', { task: 'L1118-2', state: '完成', action: 'README 改完了' }))
  await run('ui-m', call('master_remind', { at: '2h', text: 'G14-UI 下次提醒', task: 'L1118-3' }))
  await quiet()

  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p = await chrome.page(); await p.size(1280, 900)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`, 15_000)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('项目列表', `!!document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]')`, 15_000)
  await p.ev(`document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]').click()`)
  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  await p.waitFor('alpha 看板三件任务', `${board}?.querySelectorAll('[data-task]').length === 3`, 20_000)
  const rows = () => p.ev<string[]>(`[...${board}.querySelectorAll('button[data-task]')].map(e=>e.dataset.task).sort()`)
  const setQ = (v: string) => p.ev(`(()=>{const el=${board}.querySelector('[data-testid=dshm-search-q]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)

  // 状态栏：下次提醒
  await p.waitFor('状态栏下次提醒', `!!${board}.querySelector('[data-testid=dshm-sb-reminder]')`, 10_000)
  expect(await p.ev<string>(`${board}.querySelector('[data-testid=dshm-sb-reminder]').title`)).toBe('G14-UI 下次提醒')

  // ⑦ 搜索
  await setQ('readme')
  await p.waitFor('搜到一件', `${board}.querySelectorAll('button[data-task]').length === 1`, 5000)
  expect(await rows()).toEqual(['L1118-2'])
  expect(await p.ev<string>(`${board}.querySelector('[data-testid=dshm-search-count]').textContent`)).toMatch(/显示 1 \/ 3 个/)
  await setQ('')
  await p.waitFor('清空后三件', `${board}.querySelectorAll('button[data-task]').length === 3`, 5000)

  // ⑨ 收起 → 撤销 → 再收起 → 已收起视图
  await p.ev(`${board}.querySelector('[data-view-act=hide][data-view-task="L1118-1"]').click()`)
  await p.waitFor('收起后两件', `${board}.querySelectorAll('button[data-task]').length === 2`, 8000)
  await p.waitFor('出现撤销', `!!${board}.querySelector('[data-testid=dshm-undo-btn]')`, 3000)
  await p.ev(`${board}.querySelector('[data-testid=dshm-undo-btn]').click()`)
  await p.waitFor('撤销后三件', `${board}.querySelectorAll('button[data-task]').length === 3`, 8000)
  await p.ev(`${board}.querySelector('[data-view-act=hide][data-view-task="L1118-1"]').click()`)
  await p.waitFor('再收起后两件', `${board}.querySelectorAll('button[data-task]').length === 2`, 8000)
  await p.waitFor('已收起（1）', `${board}.querySelector('[data-testid=dshm-view-hidden]')?.textContent.includes('已收起（1）')`, 8000)
  await p.ev(`${board}.querySelector('[data-testid=dshm-view-hidden]').click()`)
  await p.waitFor('已收起视图里有 L1118-1', `${board}.querySelectorAll('button[data-task]').length === 1 && !!${board}.querySelector('button[data-task="L1118-1"]')`, 8000)

  // ⑨ 归档 / 恢复（回到近 7 天）
  await p.ev(`[...${board}.querySelectorAll('[data-testid=dshm-board-tools] button')].find(b=>b.textContent==='近 7 天').click()`)
  await p.waitFor('回到列表', `!!${board}.querySelector('[data-view-act=archive][data-view-task="L1118-2"]')`, 8000)
  expect(await p.ev<boolean>(`!!${board}.querySelector('[data-view-act=archive][data-view-task="L1118-3"]')`)).toBe(false) // 没结束的没有「归档」
  await p.ev(`${board}.querySelector('[data-view-act=archive][data-view-task="L1118-2"]').click()`)
  await p.waitFor('归档后只剩 L1118-3', `${board}.querySelectorAll('button[data-task]').length === 1`, 8000)
  await p.ev(`[...${board}.querySelectorAll('[data-testid=dshm-board-tools] button')].find(b=>b.textContent==='已归档').click()`)
  await p.waitFor('已归档里有 L1118-2', `!!${board}.querySelector('[data-view-act=restore][data-view-task="L1118-2"]')`, 8000)
  await p.ev(`${board}.querySelector('[data-view-act=restore][data-view-task="L1118-2"]').click()`)
  await p.waitFor('恢复后已归档空了', `${board}.querySelectorAll('button[data-task]').length === 0`, 8000)

  // 审稿 SHOULD 7 ⑤：任务详情里显示挂着的提醒
  await p.ev(`[...${board}.querySelectorAll('[data-testid=dshm-board-tools] button')].find(b=>b.textContent==='近 7 天').click()`)
  await p.waitFor('回到列表', `!!${board}.querySelector('button[data-task="L1118-3"]')`, 8000)
  await p.ev(`${board}.querySelector('button[data-task="L1118-3"]').click()`)
  await p.waitFor('任务详情里的提醒', `${board}.querySelector('[data-testid=dshm-reminders]')?.textContent.includes('G14-UI 下次提醒')`, 10_000)
}, 300_000)
