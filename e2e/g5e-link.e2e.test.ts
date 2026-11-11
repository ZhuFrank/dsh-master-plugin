/**
 * G5-E ⑥ 端到端（假模型 + 沙盒 + 独立无头 Chrome；不碰 3090）：
 * - 按话题推送降噪：只说「单文件 html」这类泛标签不推；说到具体标签（snake）照推、写出命中的标签与权重；
 * - 跨任务关联：巡检报出 L1104-1 ↔ L1104-2 候选（共同标签 snake，不含单文件 / html）；
 *   总管 master_link 后两边时间线各一条「关联 @另一个」，点 @ 跳到那个任务；巡检不再报。
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
const PUSH = '[dsh-master 相关前情（自动推送'

it('G5-E ⑥：话题推送降噪 + 跨任务关联', async () => {
  const base = path.join(E2E_WORK, `g5el-${Date.now()}`)
  const wDir = path.join(base, 'w'); fs.mkdirSync(wDir, { recursive: true })
  const sb = await createSandbox({ name: 'g5e-link', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32 } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const dstate = () => sb.get('/dsh-master-debug/state')
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  await prompt('master', call('master_spawn', { name: 'w', cwd: wDir, title: '执行 W' }))
  await sb.waitFor('exec-w', async () => (await dstate()).sessions.find((x: any) => x.id === 'exec-w'))
  await prompt('master', call('master_dispatch', { task: 'L1104-1', kind: 'light', title: '贪吃蛇加暂停', to: 'w', text: '做' }))
  await prompt('master', call('master_dispatch', { task: 'L1104-2', kind: 'light', title: '贪吃蛇换皮肤', to: 'w', text: '做' }))
  await sb.waitFor('两个任务', async () => (await dstate()).tasks.length >= 2)
  await quiet()
  const dl = (slug: string, task: string, tags: string[]) => prompt('exec-w', call('devlog_add', { slug, hook: slug, tags, files_touched: [path.join(wDir, `${slug}.html`)], depth: '琐碎', sections: { 改了什么: 'x' }, task, no_related_reason: '测试' }))
  await dl('snake-pause', 'L1104-1', ['snake', 'pause', '单文件', 'html'])
  await quiet()
  await dl('snake-skin', 'L1104-2', ['snake', 'skin', '单文件', 'html'])
  await sb.waitFor('两条 devlog', async () => (await sb.get('/dsh-master-debug/mem')).devlog.length >= 2)
  await quiet()

  // ── 按话题推送：泛标签不推，具体标签推（只对花名册里的会话推；用一个新建、没收到过推送的执行会话；同一会话同一条只推一次） ──
  fs.mkdirSync(path.join(base, 'v'), { recursive: true })
  // G11-1 起：上面 dl() 是用户直接对 exec-w 说的话，那两轮不再发空闲提醒叫醒总管，两条「用户直接指示」inject（正文是用户原话 CALL devlog_add）
  // 会攒到总管下一步；假模型会把同一步里的 CALL 行当工具调用，spawn 就被挤掉了。先让总管走一步把它们消化掉（等同于以前空闲提醒那次叫醒）。
  await prompt('master', '收到，继续'); await quiet()
  await prompt('master', call('master_spawn', { name: 'v', cwd: path.join(base, 'v'), title: '执行 V' }))
  await sb.waitFor('exec-v', async () => (await dstate()).sessions.find((x: any) => x.id === 'exec-v'))
  await quiet()
  const reqsWith = (marker: string) => sb.mock.requests().filter(r => r.messages.some(m => m.text.includes(marker)))
  const pushesIn = (marker: string) => reqsWith(marker).flatMap(r => r.messages).filter(m => m.role === 'user' && m.text.startsWith(PUSH))
  await prompt('exec-v', '再做一个单文件 html 页面 GENERIC-ONLY')
  await sb.waitFor('那一轮进模型', async () => reqsWith('GENERIC-ONLY').length > 0)
  await quiet()
  expect(pushesIn('GENERIC-ONLY')).toEqual([])
  await prompt('exec-v', 'snake 太慢了 SPECIFIC-TAG')
  await sb.waitFor('具体标签被推送', async () => pushesIn('SPECIFIC-TAG').length > 0)
  const push = pushesIn('SPECIFIC-TAG').map(m => m.text).join('\n')
  expect(push).toContain('snake-pause'); expect(push).toContain('snake-skin')
  expect(push).toMatch(/提到了 tag「snake」（权重 \d/)
  expect(push).not.toMatch(/「单文件」|「html」/)
  await quiet()

  // ── 跨任务关联：巡检报候选 → master_link → 两边时间线 ──
  const f1 = (await sb.get('/dsh-master-debug/patrol')).findings.filter((f: any) => f.key.startsWith('link:'))
  expect(f1.map((f: any) => f.text)).toEqual([expect.stringMatching(/^跨任务关联候选：L1104-1 ↔ L1104-2（共同标签 「snake」，得分/)])
  await prompt('master', call('master_link', { task: 'L1104-1', with: 'L1104-2', why: '都在改贪吃蛇' }))
  await sb.waitFor('关联写入', async () => (await sb.get('/dsh-master-debug/patrol')).findings.every((f: any) => !f.key.startsWith('link:')))
  await quiet()

  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p: CdpPage = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('看板', `!!document.querySelector('[data-testid=dsh-master-board] [data-task="L1104-1"]')`, 15_000)
  await p.ev(`document.querySelector('[data-testid=dsh-master-board] [data-task="L1104-1"]').click()`)
  await p.waitFor('L1104-1 的关联条目', `!!document.querySelector('[data-testid=dshm-timeline] [data-link-task="L1104-2"]')`, 10_000)
  const row = await p.ev<string>(`document.querySelector('[data-link-task="L1104-2"]').closest('[data-item-no]').innerText`)
  expect(row).toMatch(/关联\s*@L1104-2\s*都在改贪吃蛇/)
  await p.shot(path.join(OUT, '1280-task-linked.png'))
  await p.ev(`document.querySelector('[data-link-task="L1104-2"]').click()`)
  await p.waitFor('跳到 L1104-2，那边也有一条', `!!document.querySelector('[data-testid=dshm-timeline] [data-link-task="L1104-1"]') && document.body.innerText.includes('贪吃蛇换皮肤')`, 10_000)
  await p.size(390, 844); await sleep(800)
  await p.shot(path.join(OUT, '390-task-linked.png'))
  expect(await p.ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  await p.close()
}, 240_000)
