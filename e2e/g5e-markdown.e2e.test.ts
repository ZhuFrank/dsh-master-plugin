/**
 * G5-E 端到端（假模型 + 沙盒 + 独立无头 Chrome；不装 pocket、不碰 3090/3082）：
 * ① 时间线正文里的 Markdown 链接：https 新标签 + noopener；javascript: 不成链接；相对路径按作者工作目录打开宿主预览；
 *    隐藏路径、.. 越界不打开、给出提示；
 * ② 宿主斜体行为钉子：*斜* 是斜体，5*3*2 原样显示（插件预处理），代码里的不动；
 * ④ 时间线每条显示 #编号；正文 / 一行摘要里属于本时间线的 #编号能点，点了滚过去并高亮；不存在的编号不可点。
 */
import fs from 'node:fs'
import path from 'node:path'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, type CdpPage, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'docs/g5e'); fs.mkdirSync(OUT, { recursive: true })
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const tokenOf = (sb: Sandbox) => (fs.readFileSync(path.join(sb.logDir, 'dsh.1.log'), 'utf8').match(/token=([A-Za-z0-9_-]+)/) ?? [])[1]!

it('G5-E：Markdown 链接 / 单星号 / 时间线编号', async () => {
  const base = path.join(E2E_WORK, `g5e-${Date.now()}`)
  const wDir = path.join(base, 'w'); fs.mkdirSync(path.join(wDir, '.hidden'), { recursive: true })
  fs.writeFileSync(path.join(wDir, 'result.md'), '# 产物标题 G5E\n\n内容\n')
  fs.writeFileSync(path.join(wDir, '.hidden', 'x.md'), '# HIDDEN-SECRET\n')
  const sb = await createSandbox({ name: 'g5e', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32 } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const dstate = () => sb.get('/dsh-master-debug/state')
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  await prompt('master', call('master_spawn', { name: 'w', cwd: wDir, title: '执行 W' }))
  await sb.waitFor('exec-w', async () => (await dstate()).sessions.find((x: any) => x.id === 'exec-w'))
  await prompt('master', call('master_dispatch', { task: 'L1104-1', kind: 'light', title: 'Markdown 样例', to: 'w', text: '写个样例' }))
  await sb.waitFor('任务', async () => (await dstate()).tasks.find((t: any) => t.id === 'L1104-1'))
  await quiet()

  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p: CdpPage = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  // 派活那条事件的编号（events seq），回报里引用它
  const th0 = await p.ev<any>(`fetch('/api/dsh-master/thread?task=L1104-1',{credentials:'same-origin'}).then(r=>r.json())`)
  const dispNo = th0.items.find((x: any) => x.kind === 'event' && x.type === 'task/dispatched').no
  expect(dispNo).toBeGreaterThan(0)
  const body = [`见 #${dispNo}，不存在的 #99999 不可点。`, '[外链](https://example.com/x) [明文](http://example.com/y) [坏链](javascript:window.__pwned3=1) [相对](result.md) [隐藏](.hidden/x.md) [越界](../../etc/passwd)',
    '斜体 *斜* 乘法 5*3*2 代码 `5*3*2`'].join('\n\n')
  await prompt('exec-w', call('master_report', { task: 'L1104-1', state: '进展', action: `写好了，参照 #${dispNo}`, body }))
  await sb.waitFor('回报进库', async () => (await dstate()).tasks.find((t: any) => t.id === 'L1104-1' && t.state === '进行中'))
  await quiet()

  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('看板', `!!document.querySelector('[data-testid=dsh-master-board] [data-task="L1104-1"]')`, 15_000)
  await p.ev(`document.querySelector('[data-testid=dsh-master-board] [data-task="L1104-1"]').click()`)
  await p.waitFor('时间线', `document.querySelectorAll('[data-testid=dshm-timeline] [data-item-no]').length >= 2`)
  // 再打开一次看板（标题栏按钮、自动打开、左侧入口的延时都走 openBoard()，不带任务号）：不能把点开的任务弹回列表
  await p.ev(`[...document.querySelectorAll('[data-testid=dshm-header-board]')].find(e=>e.offsetParent!==null)?.click()`); await sleep(1200)
  expect(await p.ev(`!!document.querySelector('[data-testid=dshm-timeline]')`)).toBe(true)
  // ④ 每条显示自己的编号
  expect(await p.ev(`[...document.querySelectorAll('[data-testid=dshm-timeline] [data-item-no]')].every(e=>e.innerText.includes('· #'+e.dataset.itemNo))`)).toBe(true)
  const report = `[...document.querySelectorAll('[data-testid=dshm-timeline] [data-kind=event]')].find(e=>e.innerText.includes('写好了'))`
  // 一行摘要里的 #编号可点（NoText）
  expect(await p.ev(`!!${report}.querySelector('[data-jump-no="${dispNo}"]')`)).toBe(true)
  await p.ev(`${report}.querySelector('[data-expand]').click()`)
  await p.waitFor('回报全文', `!!${report}.querySelector('.dshm-full')`)
  const full = `${report}.querySelector('.dshm-full')`
  // ① 链接
  const ext = await p.ev<any>(`(()=>{const a=${full}.querySelector('a[href="https://example.com/x"]');return a&&{t:a.target,rel:a.rel}})()`)
  expect(ext).toEqual({ t: '_blank', rel: expect.stringContaining('noopener') })
  expect(await p.ev(`[...${full}.querySelectorAll('a')].some(a=>(a.getAttribute('href')||'').startsWith('javascript'))`)).toBe(false)
  // ② 斜体钉子 + 5*3*2 原样
  expect(await p.ev(`[...${full}.querySelectorAll('em')].map(e=>e.textContent)`)).toEqual(['斜'])
  expect(await p.ev(`${full}.innerText`)).toMatch(/乘法 5\*3\*2 代码 5\*3\*2/)
  // ④ 不存在的编号不可点；存在的可点、点了滚过去并高亮
  expect(await p.ev(`[...${full}.querySelectorAll('button')].some(b=>b.textContent.includes('#99999'))`)).toBe(false)
  await p.shot(path.join(OUT, '1280-report-expanded.png'))
  const clickBtn = (scope: string, text: string) => p.ev(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`)
  expect(await clickBtn(full, `#${dispNo}`)).toBe(true)
  await p.waitFor('点编号后目标高亮', `document.querySelector('[data-testid=dshm-timeline] [data-item-no="${dispNo}"]').classList.contains('flash')`, 5000)
  expect(await p.ev(`(()=>{const r=document.querySelector('[data-item-no="${dispNo}"]').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`)).toBe(true)
  await sleep(1900)
  await p.ev(`${report}.querySelector('[data-jump-no="${dispNo}"]').click()`) // 一行摘要里的也能点
  await p.waitFor('摘要里的编号也能跳', `document.querySelector('[data-item-no="${dispNo}"]').classList.contains('flash')`, 5000)
  // ① 隐藏路径、越界：不打开，给提示
  expect(await clickBtn(full, '隐藏')).toBe(true)
  await p.waitFor('隐藏路径被拒', `document.querySelector('[data-testid=dshm-notice]')?.innerText.includes('含隐藏目录')`, 5000)
  expect(await clickBtn(full, '越界')).toBe(true)
  await p.waitFor('越界被拒', `document.querySelector('[data-testid=dshm-notice]')?.innerText.includes('含 ..')`, 5000)
  // http（不是 https）：宿主生成了链接，但插件不打开，给提示
  await p.ev(`(()=>{window.__opened=[];window.__o=window.open;window.open=(...a)=>{window.__opened.push(a[0]);return null}})()`)
  await p.ev(`${full}.querySelector('a[href="http://example.com/y"]').click()`)
  await p.waitFor('http 被拒', `document.querySelector('[data-testid=dshm-notice]')?.innerText.includes('只打开 https')`, 5000)
  await p.ev(`${full}.querySelector('a[href="https://example.com/x"]').click()`); await sleep(300)
  expect(await p.ev(`window.__opened`)).toEqual(['https://example.com/x'])
  await p.ev(`window.open=window.__o`)
  await sleep(1500)
  expect(await p.ev(`document.body.innerText.includes('HIDDEN-SECRET')`)).toBe(false)
  // ① 相对路径：按作者（exec-w）工作目录解析 → 宿主预览
  expect(await clickBtn(full, '相对')).toBe(true)
  await p.waitFor('相对路径打开宿主预览', `document.body.innerText.includes('产物标题 G5E')`, 15_000)
  // 手机宽度截图
  await p.size(390, 844); await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('手机看板', `!!document.querySelector('[data-testid=dsh-master-board] [data-task="L1104-1"]')`, 15_000)
  await p.ev(`document.querySelector('[data-testid=dsh-master-board] [data-task="L1104-1"]').click()`)
  await p.waitFor('手机时间线', `!!${report}`)
  await p.ev(`${report}.querySelector('[data-expand]').click()`); await sleep(800)
  await p.shot(path.join(OUT, '390-report-expanded.png'))
  expect(await p.ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  await p.close()
}, 240_000)
