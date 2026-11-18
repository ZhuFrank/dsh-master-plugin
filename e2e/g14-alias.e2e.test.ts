/**
 * G14 ⑩ 任务叫法（沙盒 + 假模型 + 无头 Chrome；不碰 3080 / 3090）：看板上改叫法 ⇒ 行里显示叫法、原标题灰字；
 * 总管下一次请求里有「叫作「…」」的说明；之后总管给成员发话，成员收到的消息里写「L1118-1（你叫它：…）」。
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

it('G14 ⑩：看板改叫法，总管和成员都认', async () => {
  const base = path.join(E2E_WORK, `g14alias-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g14-alias', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 0, patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }
  const masterReqs = () => sb.mock.requests().filter(r => r.messages.some(m => m.text?.includes('# 你是总管（会话 ui-m）')))
  const memberReqs = () => sb.mock.requests().filter(r => r.messages.some(m => m.text?.includes('# 你是执行会话（alpha.x）')))

  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  await run('ui-m', call('master_spawn', { name: 'x', title: '成员 X' }))
  await run('ui-m', call('master_dispatch', { task: 'L1118-1', kind: 'light', title: '整理脚本', to: 'x', text: '做' }))
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
  await p.waitFor('alpha 看板', `!!${board}?.querySelector('[data-alias-edit="L1118-1"]')`, 20_000)
  await p.ev(`${board}.querySelector('[data-alias-edit="L1118-1"]').click()`)
  await p.waitFor('叫法输入框', `!!${board}.querySelector('[data-alias-input="L1118-1"]')`, 5000)
  await p.ev(`(()=>{const el=${board}.querySelector('[data-alias-input="L1118-1"]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,'下载整理');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const m0 = masterReqs().length
  await p.ev(`${board}.querySelector('[data-alias-save="L1118-1"]').click()`)
  await p.waitFor('行里显示叫法', `${board}.querySelector('button[data-task="L1118-1"] [data-alias]')?.dataset.alias === '下载整理'`, 8000)
  expect(await p.ev<string>(`${board}.querySelector('button[data-task="L1118-1"] .dshm-rt').textContent`)).toBe('下载整理 · 整理脚本')

  // 总管下一轮带着说明；总管给成员发话，成员收到的消息里写叫法
  const x0 = memberReqs().length
  await run('ui-m', call('master_send', { to: 'x', task: 'L1118-1', text: 'L1118-1 记得加单元测试' }))
  await quiet()
  expect(masterReqs().slice(m0).some(r => r.messages.some(m => m.role === 'user' && m.text?.includes('叫作「下载整理」')))).toBe(true)
  expect(memberReqs().slice(x0).some(r => r.messages.some(m => m.role === 'user' && m.text?.includes('L1118-1（你叫它：下载整理）')))).toBe(true)
  // 审稿 SHOULD 7 ⑩：总管守则里有叫法对照表；用户直接说叫法 ⇒ 总管收到的用户消息里叫法后面带「（= L1118-1）」
  expect(masterReqs().at(-1)!.messages.some(m => m.text?.includes('「下载整理」= L1118-1'))).toBe(true)
  const m1 = masterReqs().length
  await run('ui-m', '下载整理先停一下')
  expect(masterReqs().slice(m1).some(r => r.messages.some(m => m.role === 'user' && m.text?.includes('下载整理（= L1118-1）先停一下')))).toBe(true)
}, 300_000)
