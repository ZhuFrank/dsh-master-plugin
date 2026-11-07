/**
 * G6-3 — 看板与交互（假模型 + 沙盒 + 独立无头 Chrome；不碰 3090 / 3082）：
 * 看板跟着项目切换（只显示本项目的任务、成员、等你定、未入编）；G / Q 编号的标签和卡片（时间线、任务详情、用户消息）；
 * @ 菜单按项目；会话视图补列；左侧入口列出项目；没开张的工作区有提示；1280 / 390 截图。
 * 探针插件 spike/g5g-probe-plugin 只用来在浏览器里打开指定会话（宿主 uiWorkspace.openSession）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, type CdpPage, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'docs/g6-3'); fs.mkdirSync(OUT, { recursive: true })
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const tokenOf = (sb: Sandbox) => [...fs.readFileSync(path.join(sb.logDir, 'dsh.1.log'), 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)![1]!

it('G6-3：看板按项目、G / Q 标签和卡片、@ 菜单、会话视图、入口', async () => {
  const base = path.join(E2E_WORK, `g63-${Date.now()}`)
  const alpha = (() => { const d = path.join(base, 'alpha'); fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) })()
  const other = path.join(base, 'other'); fs.mkdirSync(other, { recursive: true })
  const legacyW = path.join(base, 'legacy-w'); fs.mkdirSync(legacyW, { recursive: true })
  fs.mkdirSync(path.join(alpha, 'out'), { recursive: true }); fs.writeFileSync(path.join(alpha, 'out', 'g1.md'), '# G1 产物\n')
  const sb = await createSandbox({ name: 'g6-3', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master'), path.join(ROOT, 'spike/g5g-probe-plugin')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32 } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  // 旧单元：一个旧任务（看板切到项目后不该出现）
  await prompt('master', call('master_spawn', { name: 'w', cwd: legacyW, title: '旧成员' })); await quiet()
  await prompt('master', call('master_dispatch', { task: 'L1106-9', kind: 'light', title: 'LEGACY-ONLY 旧任务', to: 'w', text: 'x' })); await quiet()
  // 没定义闸门的旧任务：G1 通过、G2 打回（旧看板上 G2 要是红的，不能算已验收）
  await prompt('master', call('master_review', { task: 'L1106-9', verdict: '通过', gate: 'G1', notes: '好' })); await quiet()
  await prompt('master', call('master_review', { task: 'L1106-9', verdict: '打回', gate: 'G2', notes: '缺' })); await quiet()
  // 项目 alpha：开张、成员、重任务带闸门、回报、验收、等你定
  await sb.post('/dsh-master-debug/create', { id: 'a-master', cwd: alpha, preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).units.includes('alpha'))
  await prompt('a-master', call('master_spawn', { name: 'x', title: '成员 X', purpose: '做数据层和看板' })); await quiet()
  await prompt('a-master', call('task_spec_write', { task: 'T013', title: '归因表', expected: '1h', output: path.join(alpha, 'out'), resume: 'r', 目标: 'x', 要读的: 'x', 交付物: 'x', 验收标准: 'x', 红线: 'x',
    gates: [{ id: 'G1', title: '第一步出表', produces: path.join(alpha, 'out', 'g1.md') }, { id: 'G2', title: '第二步核对' }] })); await quiet()
  await prompt('a-master', call('master_dispatch', { task: 'T013', kind: 'heavy', title: '归因表', to: 'x', gate: 'G1', text: '开始' })); await quiet()
  await prompt('a-master', call('master_ask_user', { task: 'T013', question: '归因口径用哪个？', options: ['甲', '乙'] })); await quiet()
  const code = (await sb.get('/dsh-master-debug/events?project=alpha&type=ask/open'))[0].data.code as string
  await prompt('alpha.x', call('master_report', { task: 'T013', state: '就绪', gate: 'G1', action: `G1 出表好了，接着做 G2，等 ${code} 定`, body: `产物：${path.join(alpha, 'out', 'g1.md')}（12 行）\n\n**G1** 的粗体不认；文件 G2_note.md 不认。` })); await quiet()
  await prompt('a-master', call('master_review', { task: 'T013', verdict: '通过', gate: 'G1', notes: '核过 12 行' })); await quiet()
  await prompt('a-master', call('master_review', { task: 'T013', verdict: '打回', gate: 'G2', notes: '核对表缺两列' })); await quiet()
  // 未入编 + 不在任何项目里的会话
  await sb.post('/dsh-master-debug/create', { id: 'a-plain', cwd: alpha })
  await sb.post('/dsh-master-debug/create', { id: 'o-plain', cwd: other })
  await sb.waitFor('未入编记下', async () => (await sb.get('/dsh-master-debug/events?project=alpha&type=session/unenrolled')).length > 0)

  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p: CdpPage = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('探针客户端', `!!window.__g6probe`, 15_000)

  // ── 左侧入口：有项目时列出项目 + 旧总管 ──
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('项目列表', `!!document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]')`, 15_000)
  expect(await p.ev(`[...document.querySelectorAll('[data-testid=dshm-project-picker] [data-project]')].map(e=>e.dataset.project)`)).toEqual(['alpha', '-'])
  await p.shot(path.join(OUT, '1280-project-picker.png'))
  await p.ev(`document.querySelector('[data-testid=dshm-project-picker] [data-project="alpha"]').click()`)

  // ── 看板跟着项目：只有 alpha 的任务、成员、等你定、未入编 ──
  // 切换会话以后，上一个会话的看板可能还在 DOM 里（藏着）⇒ 只认看得见的那个
  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  await p.waitFor('alpha 的看板', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-task="T013"]')`, 20_000)
  expect(await p.ev(`${board}.innerText.includes('LEGACY-ONLY')`)).toBe(false)
  expect(await p.ev<string>(`document.querySelector('[data-testid=dshm-board-meta]').innerText`)).toMatch(/^项目 alpha · 总管/)
  expect(await p.ev(`!!${board}.querySelector('[data-ask]')`)).toBe(true)
  expect(await p.ev<string>(`${board}.querySelector('[data-ask]').innerText`)).toContain(code)
  expect(await p.ev(`!!${board}.querySelector('[data-testid=dshm-unenrolled] [data-unenrolled="a-plain"]')`)).toBe(true)
  await p.shot(path.join(OUT, '1280-project-board.png'))

  // ── 任务详情：闸门格子带标题、点开卡片（状态来自验收事件、产物、看任务书）──
  await p.ev(`${board}.querySelector('[data-task="T013"]').click()`)
  await p.waitFor('任务详情', `!!document.querySelector('[data-testid=dshm-gates] [data-ref="T013/G1"]')`, 10_000)
  expect(await p.ev<string>(`document.querySelector('[data-testid=dshm-gates]').innerText`)).toMatch(/G1 第一步出表[\s\S]*G2 第二步核对/)
  expect(await p.ev<string>(`document.querySelector('[data-testid=dshm-gates] [data-ref="T013/G1"]').title`)).toBe('T013·G1 · 第一步出表（已验收）')
  await p.ev(`document.querySelector('[data-testid=dshm-gates] [data-ref="T013/G1"]').click()`)
  await p.waitFor('闸门卡片', `!!document.querySelector('[data-testid=dshm-ref-card]')`, 5000)
  const card1 = await p.ev<string>(`document.querySelector('[data-testid=dshm-ref-card]').innerText`)
  expect(card1).toMatch(/T013·G1[\s\S]*第一步出表[\s\S]*已验收[\s\S]*产物：/)
  expect(await p.ev(`[...document.querySelectorAll('[data-testid=dshm-ref-card] [data-open-path]')].map(e=>e.dataset.openPath)`)).toEqual([path.join(alpha, 'out', 'g1.md')])
  expect(await p.ev(`!!document.querySelector('[data-testid=dshm-ref-card] [data-card-spec]')`)).toBe(true)
  expect(await p.ev(`(()=>{const c=document.querySelector('[data-testid=dshm-ref-card]').getBoundingClientRect();const g=document.querySelector('[data-testid=dshm-gates] [data-ref="T013/G1"]').getBoundingClientRect();return Math.abs(c.top-g.bottom)<40&&c.left>=g.left-40})()`)).toBe(true)
  await p.shot(path.join(OUT, '1280-gate-card.png'))
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.waitFor('Esc 关卡片', `!document.querySelector('[data-testid=dshm-ref-card]')`, 3000)
  // 打回的闸门：格子是红的，悬停、卡片都写「打回」，不写「已验收」
  const g2 = `document.querySelector('[data-testid=dshm-gates] [data-ref="T013/G2"]')`
  expect(await p.ev<string>(`${g2}.className`)).toMatch(/\brejected\b/)
  expect(await p.ev<string>(`${g2}.title`)).toBe('T013·G2 · 第二步核对（打回）')
  await p.ev(`${g2}.click()`)
  await p.waitFor('打回闸门的卡片', `document.querySelector('[data-testid=dshm-ref-card]')?.innerText.includes('第二步核对')`, 5000)
  const card2 = await p.ev<string>(`document.querySelector('[data-testid=dshm-ref-card]').innerText`)
  expect(card2).toMatch(/打回/); expect(card2).not.toMatch(/已验收/)
  expect(await p.ev(`!!document.querySelector('[data-testid=dshm-ref-card] .dshm-chip.bad')`)).toBe(true)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.waitFor('Esc 关卡片（G2）', `!document.querySelector('[data-testid=dshm-ref-card]')`, 3000)
  // 时间线：回报那一行里的 G1 / G2（本任务）和 Q 编号是标签；粗体、文件名里的不是
  const report = `[...document.querySelectorAll('[data-testid=dshm-timeline] [data-kind=event]')].find(e=>e.innerText.includes('出表好了'))`
  await p.waitFor('回报那一行', `!!${report}`, 5000)
  expect(await p.ev(`[...${report}.querySelectorAll('[data-ref]')].map(e=>e.dataset.ref)`)).toEqual(['T013/G1', 'T013/G2', code])
  await p.ev(`[...${report}.querySelectorAll('[data-ref]')].find(e=>e.dataset.ref===${JSON.stringify(code)}).click()`)
  await p.waitFor('Q 卡片', `document.querySelector('[data-testid=dshm-ref-card]')?.innerText.includes('归因口径用哪个？')`, 5000)
  expect(await p.ev<string>(`document.querySelector('[data-testid=dshm-ref-card]').innerText`)).toMatch(/待定/)
  await p.ev(`document.querySelector('[data-testid=dshm-timeline]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
  await p.waitFor('点外面关卡片', `!document.querySelector('[data-testid=dshm-ref-card]')`, 3000)
  // 展开全文：G1 是链接；粗体里的 G1、文件名 G2_note.md 不是
  await p.ev(`${report}.querySelector('[data-expand]').click()`)
  await p.waitFor('回报全文', `!!${report}.querySelector('.dshm-full')`, 5000)
  const fullBtns = await p.ev<string[]>(`[...${report}.querySelectorAll('.dshm-full button, .dshm-full a')].map(e=>e.textContent.trim())`)
  expect(fullBtns.filter(t => /^G\d/.test(t))).toEqual(['G1', 'G2']) // 状态行里的两个；粗体里的 G1、文件名 G2_note.md 不算
  expect(await p.ev<string>(`${report}.querySelector('.dshm-full').innerText`)).toMatch(/G1 的粗体不认；文件 G2_note\.md 不认/)

  // ── 会话视图：汇总、负责什么、状态、未结任务可点、最近回报（时间 + 状态）、工作区 ──
  await p.ev(`${board}?.querySelector('.dshm-link')?.click()`) // ← 任务列表
  await p.waitFor('回到列表', `!!${board}.querySelector('[data-testid=dshm-board-tools]')`, 5000)
  await p.ev(`[...${board}.querySelectorAll('[data-testid=dshm-board-tools] button')].find(b=>/^会话（\\d+）$/.test(b.textContent.trim())).click()`)
  await p.waitFor('会话视图', `!!${board}.querySelector('[data-session="alpha.x"]')`, 5000)
  const row = `${board}.querySelector('[data-session="alpha.x"]')`
  expect(await p.ev<string>(`${board}.querySelector('[data-testid=dshm-sessions-summary]').innerText`)).toMatch(/管辖的会话：1 个 · 总管 .* · 状态取自宿主.*未入编 1/)
  expect(await p.ev<string>(`${row}.innerText`)).toMatch(/成员 X · 做数据层和看板[\s\S]*在线|成员 X · 做数据层和看板[\s\S]*未加载/)
  expect(await p.ev<string>(`${row}.querySelector('[data-last-report]').innerText`)).toMatch(/^最近回报：\d{2}:\d{2} 就绪 · T013$/)
  expect(await p.ev<string>(`${row}.innerText`)).toContain('工作区 ')
  // 未入编的会话：汇总里数了 1 个，列表里单独一组列出来，能打开
  const unen = `${board}.querySelector('[data-testid=dshm-unenrolled] [data-unenrolled="a-plain"]')`
  expect(await p.ev(`!!${unen}`)).toBe(true)
  expect(await p.ev<string>(`${board}.querySelector('[data-testid=dshm-unenrolled]').innerText`)).toMatch(/未入编的会话 · 1[\s\S]*a-plain[\s\S]*打开 ↗/)
  await p.shot(path.join(OUT, '1280-sessions-view.png'))
  await p.ev(`${row}.querySelector('[data-task-link="T013"]').click()`)
  await p.waitFor('点未结任务跳到详情', `!!document.querySelector('[data-testid=dshm-gates]')`, 5000)

  // ── @ 菜单按项目：总管会话里 @ 只列 alpha 的任务 ──
  const editor = `document.querySelector('[contenteditable=true]')`
  const typeAt = async (s: string) => { await p.ev(`${editor}.focus()`); await p.send('Input.insertText', { text: s }); await sleep(1500) }
  await typeAt('@')
  const menu = await p.ev<string[]>(`[...document.querySelectorAll('[role=option]')].map(e=>e.innerText.replace(/\\s+/g,' '))`)
  expect(menu.some(t => t.includes('T013'))).toBe(true); expect(menu.some(t => t.includes('L1106-9'))).toBe(false)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300)
  await p.ev(`(()=>{const e=${editor};e.focus();document.execCommand('selectAll');document.execCommand('delete')})()`)
  // ── 用户消息里的标签：发一句带 T013·G1 和 Q 编号的话 ──
  await prompt('a-master', `看一下 T013·G1 和 ${code} REFMSG`); await quiet()
  await p.waitFor('用户消息里的标签', `[...document.querySelectorAll('[data-testid=dshm-refchip]')].length >= 2`, 15_000)
  expect(await p.ev(`[...document.querySelectorAll('[data-testid=dshm-refchip]')].map(e=>e.textContent)`)).toEqual(['◇ T013·G1', `◇ ${code}`])
  await p.ev(`document.querySelector('[data-testid=dshm-refchip]').click()`)
  await p.waitFor('从用户消息弹出卡片', `document.querySelector('[data-testid=dshm-ref-card]')?.innerText.includes('第一步出表')`, 8000)
  await p.shot(path.join(OUT, '1280-usermsg-chip-card.png'))
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.waitFor('时间线里那一轮的摘句也有标签', `[...document.querySelectorAll('[data-testid=dshm-timeline] [data-kind=turn]')].some(e=>e.innerText.includes('REFMSG')&&e.querySelector('[data-ref="T013/G1"]'))`, 15_000)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })

  // ── 旧单元的总管会话：看板是旧的（有 LEGACY-ONLY，没有 T013）──
  await p.ev(`window.__g6probe.openSession('master')`); await sleep(2000)
  await p.ev(`[...document.querySelectorAll('[data-testid=dshm-header-board]')].find(e=>e.offsetParent!==null)?.click()`)
  await p.waitFor('旧看板', `${board}?.dataset.project === undefined && ${board}?.innerText.includes('LEGACY-ONLY')`, 15_000)
  expect(await p.ev(`${board}.innerText.includes('T013')`)).toBe(false)
  // 旧任务没定义闸门：格子按事件来，G1 绿、G2 红
  await p.ev(`${board}.querySelector('[data-task="L1106-9"]').click()`)
  await p.waitFor('旧任务详情', `!!document.querySelector('[data-testid=dshm-gates]')`, 10_000)
  expect(await p.ev(`[...document.querySelectorAll('[data-testid=dshm-gates] .dshm-gate')].map(e=>[e.textContent.trim(), ['passed','rejected','current','seen'].find(c=>e.classList.contains(c))])`)).toEqual([['G1', 'passed'], ['G2', 'rejected']])
  // ── 不在任何项目里的会话：提示还没开张，列出已开张的项目 ──
  await prompt('o-plain', '你好'); await quiet() // 一条消息都没有的会话显示欢迎页、没有标题栏按钮
  await p.ev(`window.__g6probe.openSession('o-plain')`); await sleep(2000)
  await p.ev(`[...document.querySelectorAll('[data-testid=dshm-header-board]')].find(e=>e.offsetParent!==null)?.click()`)
  await p.waitFor('没开张提示', `!!document.querySelector('[data-testid=dshm-not-opened]')`, 15_000)
  expect(await p.ev<string>(`document.querySelector('[data-testid=dshm-not-opened]').innerText`)).toMatch(/还没开张[\s\S]*alpha/)
  await p.shot(path.join(OUT, '1280-not-opened.png'))

  // ── 390：项目看板、闸门卡片、会话视图都能用，不横向溢出 ──
  await p.size(390, 844); await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.waitFor('探针客户端', `!!window.__g6probe`, 15_000)
  await p.ev(`window.__g6probe.openSession('a-master')`); await sleep(2000)
  await p.ev(`[...document.querySelectorAll('[data-testid=dshm-header-board]')].find(e=>e.offsetParent!==null)?.click()`)
  await p.waitFor('手机项目看板', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-task="T013"]')`, 20_000)
  await p.shot(path.join(OUT, '390-project-board.png'))
  expect(await p.ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  await p.ev(`${board}.querySelector('[data-task="T013"]').click()`)
  await p.waitFor('手机任务详情', `!!document.querySelector('[data-testid=dshm-gates] [data-ref="T013/G1"]')`, 10_000)
  await p.ev(`(()=>{const b=document.querySelector('[data-testid=dshm-gates] [data-ref="T013/G1"]');const r=b.getBoundingClientRect();b.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+5,clientY:r.top+5}))})()`)
  await p.waitFor('手机闸门卡片', `!!document.querySelector('[data-testid=dshm-ref-card]')`, 5000)
  expect(await p.ev(`(()=>{const r=document.querySelector('[data-testid=dshm-ref-card]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`)).toBe(true)
  await p.shot(path.join(OUT, '390-gate-card.png'))
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.ev(`${board}?.querySelector('.dshm-link')?.click()`); await sleep(500)
  await p.ev(`[...${board}.querySelectorAll('[data-testid=dshm-board-tools] button')].find(b=>/^会话（\\d+）$/.test(b.textContent.trim())).click()`)
  await p.waitFor('手机会话视图', `!!${board}.querySelector('[data-session="alpha.x"]')`, 5000)
  expect(await p.ev(`!!${board}.querySelector('[data-testid=dshm-unenrolled] [data-unenrolled="a-plain"]')`)).toBe(true)
  await p.ev(`${board}.querySelector('[data-testid=dshm-unenrolled]').scrollIntoView({block:'end'})`); await sleep(300)
  expect(await p.ev(`(()=>{const r=${board}.querySelector('[data-unenrolled="a-plain"] button').getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight&&r.top>=0})()`)).toBe(true)
  await p.shot(path.join(OUT, '390-sessions-view.png'))
  expect(await p.ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  await p.close()
}, 300_000)
