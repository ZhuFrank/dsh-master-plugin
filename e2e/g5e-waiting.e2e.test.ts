/**
 * G5-E ⑤ 等你点提醒（假模型 + 沙盒 + 独立无头 Chrome；不碰 3090）：
 * 会话调 ask_user_question / bash 申请提权 ⇒ 宿主在等用户 ⇒ 侧栏顶部出现「⏳ … 等你回答 / 等你批准」，点了跳到那个会话；
 * 侧栏里没有任何「允许 / 批准」按钮；在那个会话里回答后提醒消失。
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

it('G5-E ⑤：等你点提醒（只提醒、不代批）', async () => {
  const base = path.join(E2E_WORK, `g5ew-${Date.now()}`)
  for (const d of ['q', 'a']) fs.mkdirSync(path.join(base, d), { recursive: true })
  const sb = await createSandbox({ name: 'g5e-wait', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32 } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  await prompt('master', '你好') // 让总管会话有一轮，侧栏能列出来
  await sb.post('/dsh-master-debug/create', { id: 'plain-q', cwd: path.join(base, 'q') })
  await sb.post('/dsh-master-debug/create', { id: 'plain-a', cwd: path.join(base, 'a') })
  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p: CdpPage = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  const waitingApi = () => p.ev<any[]>(`fetch('/api/dsh-master/state',{credentials:'same-origin'}).then(r=>r.json()).then(v=>v.waiting)`)

  await prompt('plain-q', call('ask_user_question', { questions: [{ id: 'q1', question: '选 A 还是 B？', options: [{ label: '方案A' }, { label: '方案B' }] }] }))
  await prompt('plain-a', call('bash', { description: 'touch a file outside', command: `touch /tmp/g5e-outside-${Date.now()}`, sandbox_permissions: 'danger-full-access', justification: '测试提权审批' }))
  const ws = await (async () => { for (let i = 0; i < 30; i++) { const w = await waitingApi(); if (w.length >= 2) return w; await sleep(1000) } return await waitingApi() })()
  expect(ws.map((w: any) => [w.session, w.kind]).sort()).toEqual([['plain-a', 'approval'], ['plain-q', 'question']])
  expect(ws.find((w: any) => w.kind === 'question').label).toBe('选 A 还是 B？')

  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('等你点横幅', `document.querySelectorAll('[data-testid=dshm-waiting] [data-wait-session]').length === 2`, 20_000)
  const banner = await p.ev<string>(`document.querySelector('[data-testid=dshm-waiting]').innerText`)
  // G5-F ⑥：不在花名册的会话用宿主自己的标题（这里是假模型起的 ECHO…），不露会话 ID
  expect(banner).toMatch(/⏳ .+ 等你回答 \d+ 分钟：选 A 还是 B？/); expect(banner).toMatch(/⏳ .+ 等你批准 \d+ 分钟：bash/)
  // 只提醒：侧栏里没有任何允许 / 批准 / 拒绝 / 选项按钮
  expect(await p.ev(`[...document.querySelectorAll('[data-testid=dsh-master-board] button')].some(b=>/^(允许|批准|拒绝|同意|方案A|方案B)$/.test(b.textContent.trim()))`)).toBe(false)
  await p.shot(path.join(OUT, '1280-waiting-banner.png'))
  await p.size(390, 844); await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('手机横幅', `document.querySelectorAll('[data-testid=dshm-waiting] [data-wait-session]').length === 2`, 20_000)
  await p.shot(path.join(OUT, '390-waiting-banner.png'))
  expect(await p.ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  await p.size(1280, 860); await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('回到桌面横幅', `document.querySelectorAll('[data-testid=dshm-waiting] [data-wait-session]').length === 2`, 20_000)
  // 点一下 → 跳到那个会话（宿主在那里显示提问，可以真的去点）
  await p.ev(`document.querySelector('[data-wait-session="plain-q"]').click()`)
  await p.waitFor('跳到提问的会话', `document.body.innerText.includes('选 A 还是 B？') && [...document.querySelectorAll('button,[role=option],[role=radio]')].some(b=>b.textContent.includes('方案A'))`, 15_000)
  await p.shot(path.join(OUT, '1280-waiting-question-ui.png'))
  // 在那个会话里回答 → 提醒消失
  // 宿主的提问面板：选项前面带编号（「1 方案A」），选中后「提交」才可点
  await p.ev(`(()=>{const c=[...document.querySelectorAll('button,[role=option],[role=radio],label,div')].filter(e=>e.textContent.trim().endsWith('方案A')&&e.textContent.trim().length<=6);const b=c.sort((x,y)=>x.textContent.length-y.textContent.length||y.querySelectorAll('*').length-x.querySelectorAll('*').length)[0];(b.closest('button,[role=option],[role=radio],label')||b).click()})()`); await sleep(600)
  await p.waitFor('提交可点', `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='提交'&&!b.disabled)`, 5000)
  await p.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='提交').click()`)
  await (async () => { for (let i = 0; i < 20; i++) { if (!(await waitingApi()).some((w: any) => w.session === 'plain-q')) return; await sleep(1000) } })()
  expect((await waitingApi()).map((w: any) => w.session)).toEqual(['plain-a'])

  // 浏览器通知：替身 Notification 记下弹了什么；创建时不调 focus（不抢焦点），点了通知才切回来并跳到那个会话
  await p.ev(`(()=>{window.__notes=[];window.__focus=0;window.focus=()=>{window.__focus++};window.Notification=class{static permission='granted';static requestPermission(){return Promise.resolve('granted')}constructor(t,o){this.title=t;this.body=o&&o.body;window.__notes.push(this)}close(){}}})()`)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('通知按钮', `[...document.querySelectorAll('[data-testid=dsh-master-board] button')].some(b=>b.textContent.trim()==='通知：关')`, 15_000)
  await p.ev(`[...document.querySelectorAll('[data-testid=dsh-master-board] button')].find(b=>b.textContent.trim()==='通知：关').click()`)
  await p.waitFor('通知已开', `[...document.querySelectorAll('[data-testid=dsh-master-board] button')].some(b=>b.textContent.trim()==='通知：开')`, 5000)
  await prompt('plain-q', call('ask_user_question', { questions: [{ id: 'q2', question: '第二问：要不要继续？', options: [{ label: '继续' }, { label: '停' }] }] }))
  await p.waitFor('弹了等你点的通知', `window.__notes.some(n=>String(n.body).includes('第二问'))`, 30_000)
  expect(await p.ev(`window.__focus`)).toBe(0)
  await p.ev(`window.__notes.find(n=>String(n.body).includes('第二问')).onclick()`)
  expect(await p.ev(`window.__focus`)).toBe(1)
  await p.waitFor('点通知跳到那个会话', `[...document.querySelectorAll('*')].some(e=>e.children.length===0&&e.textContent.includes('第二问：要不要继续？'))&&[...document.querySelectorAll('button,[role=option],[role=radio]')].some(b=>b.textContent.includes('继续'))`, 15_000)
  await p.close()
}, 180_000)
