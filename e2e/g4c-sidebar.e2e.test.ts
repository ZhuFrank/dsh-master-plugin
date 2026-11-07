/**
 * G4c 端到端（假模型 + 沙盒 DSH_HOME + 独立无头 Chrome；不装 pocket、不碰 3090/3082）：
 * 右侧栏看板 → @任务 发出 → 模型收到摘要 → 这一轮归到任务 → 侧栏时间线出现且依据正确、就地展开全文（从会话记录读）
 * → 每轮末尾小标签点开侧栏 → 产物预览 → @执行会话 附回报 + 第 3 层归属 → 执行会话互 @ 提醒 → 候选只列自己的
 * → master_tag 兜底 → 等你定卡片 → 取消要确认 → 删掉的接口 404 → 三种宽度截图无横向溢出、手机顶部工具一行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, type CdpPage, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'docs/g4c-shots'); fs.mkdirSync(OUT, { recursive: true })
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const sref = (id: string) => `dsh-session:${Buffer.from(JSON.stringify(id)).toString('base64url')}`
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const tokenOf = (sb: Sandbox) => (fs.readFileSync(path.join(sb.logDir, 'dsh.1.log'), 'utf8').match(/token=([A-Za-z0-9_-]+)/) ?? [])[1]!
const pageFetch = (p: CdpPage, pathname: string, init: Record<string, unknown>, bodyJs = 'undefined') =>
  p.ev<{ status: number; body: any }>(`(async()=>{const init=${JSON.stringify(init)};init.body=${bodyJs};init.credentials='same-origin';let r;try{r=await fetch(${JSON.stringify(pathname)},init)}catch(e){return {status:0,body:String(e)}}let b;try{b=await r.json()}catch{b=null}return {status:r.status,body:b}})()`)
const H = { 'content-type': 'application/json', 'x-dsh-master': '1' }

it('G4c：右侧栏看板 + @任务 + 自动归属 + 就地展开全文', async () => {
  const base = path.join(E2E_WORK, `g4c-${Date.now()}`)
  const wDir = path.join(base, 'w'); const vDir = path.join(base, 'v'); fs.mkdirSync(wDir, { recursive: true }); fs.mkdirSync(vDir, { recursive: true })
  const product = path.join(wDir, 'result.md'); fs.writeFileSync(product, '# 产物标题 G4C\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
  const sb = await createSandbox({ name: 'g4c', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32 } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const dstate = () => sb.get('/dsh-master-debug/state')
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const userTexts = (from: number) => sb.mock.requests().slice(from).flatMap(r => r.messages.filter(m => m.role === 'user').map(m => m.text))

  // 准备：两个执行会话，L1103-1 派给 w（带产物路径的回报），L1103-2 派给 v
  await prompt('master', call('master_spawn', { name: 'w', cwd: wDir, title: '执行 W' }))
  await sb.waitFor('exec-w', async () => (await dstate()).sessions.find((x: any) => x.id === 'exec-w'))
  await prompt('master', call('master_spawn', { name: 'v', cwd: vDir, title: '执行 V' }))
  await sb.waitFor('exec-v', async () => (await dstate()).sessions.find((x: any) => x.id === 'exec-v'))
  await prompt('master', call('master_dispatch', { task: 'L1103-1', kind: 'light', title: '写 result.md', to: 'w', text: '写一个 result.md' }))
  await prompt('master', call('master_dispatch', { task: 'L1103-2', kind: 'light', title: '查 B 站数据', to: 'v', text: '查一下' }))
  await sb.waitFor('两个任务', async () => (await dstate()).tasks.length >= 2 || undefined)
  await prompt('exec-w', call('master_report', { task: 'L1103-1', state: '进展', action: `写好了 ${product}`, body: '## 读数\n\n跑了 `wc -l`，**行数 5**。<script>window.__pwned=1</script>', next: '等验收' }))
  await sb.waitFor('回报进库', async () => (await dstate()).tasks.find((t: any) => t.id === 'L1103-1' && t.state === '进行中'))
  await quiet()

  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)

  // ① 左侧「总管看板」→ 打开总管会话 + 右侧栏看板；列表里有任务
  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('右侧栏看板', `!!document.querySelector('[data-testid=dsh-master-board]')`, 15_000)
  await p.waitFor('任务行', `!!document.querySelector('[data-testid=dsh-master-board] [data-task="L1103-1"]')`)
  expect(await p.ev(`!!document.querySelector('[data-testid=dshm-header-board]')`)).toBe(true)
  expect(await p.ev(`!!document.querySelector('[data-testid=dsh-master-board] textarea')`)).toBe(false) // 看板里没有聊天输入框
  await p.shot(path.join(OUT, '1280-1-list.png'))

  // ② @ 菜单里的「任务」组 → 选中 → 发出
  const editor = `[...document.querySelectorAll('[contenteditable=true]')].find(e=>e.offsetParent)`
  const type = async (s: string) => { await p.ev(`${editor}.focus()`); await p.send('Input.insertText', { text: s }); await sleep(900) }
  const enter = async () => { for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(600) }
  await type('@L1103')
  await p.waitFor('任务组候选', `[...document.querySelectorAll('[role=option]')].some(e=>e.innerText.includes('L1103-1 写 result.md'))`)
  expect(await p.ev(`document.body.innerText.includes('进行中 · exec-w')`)).toBe(true)
  await p.shot(path.join(OUT, '1280-2-at-menu.png'))
  // 「任务」组排在最上面，第一个候选就是 L1103-1：回车选中（spike 里点击行不触发选中，回车可以）
  expect(await p.ev(`[...document.querySelectorAll('[role=option]')][0]?.innerText ?? ''`)).toContain('L1103-1 写 result.md')
  await enter()
  await p.waitFor('草稿里是引用块', `!!${editor}.querySelector('[data-composer-chip]')`)
  await type(' 进度怎么样？')
  const n0 = sb.mock.requests().length
  await enter()
  // ③ 模型收到：@任务 已改写成 @L1103-1，后面附着库里的摘要（标明不是用户说的）
  await sb.waitFor('总管收到 @任务', () => userTexts(n0).some(t => t.includes('@L1103-1') && t.includes('进度怎么样')) || undefined)
  const got = userTexts(n0)
  expect(got.some(t => t.includes('dsh-master-task:'))).toBe(false)
  const brief = got.find(t => t.startsWith('[dsh-master 附上的信息（插件附上的，不是用户说的）]'))
  expect(brief).toContain('L1103-1 写 result.md｜状态 进行中'); expect(brief).toContain('写好了')
  await quiet()
  // ④ 这一轮归到 L1103-1（第 1 层）；历史消息里 @任务 是小标签；每轮末尾有「归到 L1103-1 · @任务」
  const turns = await pageFetch(p, '/api/dsh-master/turns?session=master', { method: 'GET' })
  const myTurn = turns.body.turns.find((x: any) => x.primary?.task === 'L1103-1' && x.primary.layer === 1)
  expect(myTurn).toBeTruthy()
  await p.waitFor('消息里的任务小标签', `!!document.querySelector('[data-testid=dshm-taskref]')`)
  await p.waitFor('每轮末尾小标签', `[...document.querySelectorAll('[data-testid=dshm-turntag]')].some(e=>e.dataset.task==='L1103-1'&&e.innerText.includes('@任务'))`, 15_000)
  await p.shot(path.join(OUT, '1280-3-conversation.png'))
  // ⑤ 点小标签 → 侧栏打开这个任务；时间线里有这一轮，依据正确；展开读全文（从会话记录读）
  await p.ev(`[...document.querySelectorAll('[data-testid=dshm-turntag]')].find(e=>e.dataset.task==='L1103-1').click()`)
  await p.waitFor('任务时间线', `!!document.querySelector('[data-testid=dshm-timeline] [data-kind=turn][data-role=primary]')`, 15_000)
  expect(await p.ev(`document.querySelector('[data-testid=dshm-timeline] [data-kind=turn][data-role=primary]').innerText`)).toMatch(new RegExp(`第 ${myTurn.turn} 轮[\\s\\S]*@任务[\\s\\S]*进度怎么样`))
  await p.ev(`document.querySelector('[data-testid=dshm-timeline] [data-kind=turn][data-role=primary] [data-expand]').click()`)
  await p.waitFor('一轮全文', `(()=>{const r=document.querySelector('[data-testid=dshm-timeline] [data-kind=turn][data-role=primary]');return !!r.querySelector('[data-part=user]')&&!!r.querySelector('[data-part=assistant]')&&r.querySelector('[data-part=assistant]').innerText.includes('ECHO')})()`)
  // 回报展开：Markdown 全文（标题、行内代码、粗体），<script> 不执行
  await p.ev(`[...document.querySelectorAll('[data-testid=dshm-timeline] [data-kind=event]')].find(e=>e.innerText.includes('写好了')).querySelector('[data-expand]').click()`)
  await p.waitFor('回报全文', `(()=>{const r=[...document.querySelectorAll('[data-testid=dshm-timeline] [data-kind=event]')].find(e=>e.innerText.includes('写好了'));const f=r&&r.querySelector('.dshm-full');return f&&f.innerText.includes('行数 5')&&!!f.querySelector('code')&&!!f.querySelector('strong')})()`)
  expect(await p.ev(`!!window.__pwned || !!document.querySelector('.dshm-full script')`)).toBe(false)
  // 顶部固定：产物列表 + 打开执行会话
  expect(await p.ev(`[...document.querySelectorAll('[data-testid=dshm-products] [data-open-path]')].map(e=>e.dataset.openPath)`)).toEqual([product])
  expect(await p.ev(`document.querySelector('[data-testid=dshm-open-exec]')?.innerText`)).toContain('exec-w')
  await p.shot(path.join(OUT, '1280-4-task-expanded.png'))
  // 产物点开 → 宿主预览
  await p.ev(`document.querySelector('[data-testid=dshm-products] [data-open-path]').click()`)
  await p.waitFor('宿主预览产物', `document.body.innerText.includes('产物标题 G4C')`, 15_000)

  // ⑥ @执行会话（总管会话里）：附上库里的状态 + 第 3 层归属（exec-w 只有 L1103-1 在途）
  const n1 = sb.mock.requests().length
  await prompt('master', `@[执行 W](${sref('exec-w')}) 做到哪了？`)
  await sb.waitFor('总管收到 @执行会话 附带的状态', () => userTexts(n1).find(t => t.includes('宿主附的快照里看不到回报') && t.includes('exec-w（执行 W）：在途任务 L1103-1')) || undefined)
  await quiet()
  const t2 = (await pageFetch(p, '/api/dsh-master/turns?session=master', { method: 'GET' })).body.turns
  expect(t2.some((x: any) => x.primary?.task === 'L1103-1' && x.primary.layer === 3)).toBe(true)

  // ⑦ 执行会话里 @ 别的执行会话：提醒「不直接协作，回报总管」
  const n2 = sb.mock.requests().length
  await prompt('exec-w', `你去问问 @[执行 V](${sref('exec-v')})`)
  await sb.waitFor('exec-w 收到提醒', () => userTexts(n2).some(t => t.includes('执行会话之间不直接协作')) || undefined)
  await quiet()
  // ⑧ @ 候选：总管看全部，执行会话只看派给自己的
  expect((await pageFetch(p, '/api/dsh-master/candidates?session=master', { method: 'GET' })).body.tasks.map((t: any) => t.id)).toEqual(['L1103-1', 'L1103-2'])
  expect((await pageFetch(p, '/api/dsh-master/candidates?session=exec-v', { method: 'GET' })).body.tasks.map((t: any) => t.id)).toEqual(['L1103-2'])
  // ⑨ master_tag 兜底
  await prompt('master', '嗯，记一下')
  await quiet()
  // 「嗯，记一下」是第几轮：逐轮从会话记录读（也测了 /turn 接口），找原话
  let plainTurn = 0
  for (let k = 1; k <= 60 && !plainTurn; k++) {
    const r = await pageFetch(p, `/api/dsh-master/turn?session=master&turn=${k}`, { method: 'GET' })
    if (r.status === 200 && r.body.parts.some((x: any) => x.role === 'user' && x.text === '嗯，记一下')) plainTurn = k
  }
  expect(plainTurn).toBeGreaterThan(0)
  expect((await pageFetch(p, '/api/dsh-master/turns?session=master', { method: 'GET' })).body.turns.find((x: any) => x.turn === plainTurn)).toBeUndefined() // 没有任何任务信号
  await prompt('master', call('master_tag', { turn: plainTurn, task: 'L1103-2' }))
  await quiet()
  const t3 = (await pageFetch(p, '/api/dsh-master/turns?session=master', { method: 'GET' })).body.turns
  expect(t3.find((x: any) => x.turn === plainTurn)?.primary).toMatchObject({ task: 'L1103-2', layer: 5 })
  expect((await pageFetch(p, '/api/dsh-master/turn?session=nobody&turn=1', { method: 'GET' })).status).toBe(404)

  // ⑩ 删掉的接口：upload 404，send / new_task 400
  expect((await pageFetch(p, '/api/dsh-master/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-dsh-master': '1' } }, `new Uint8Array([1,2,3])`)).status).toBe(404)
  for (const action of ['send', 'new_task']) expect((await pageFetch(p, '/api/dsh-master/action', { method: 'POST', headers: H }, JSON.stringify(JSON.stringify({ action, text: 'x', title: 't' })))).body.code).toBe('bad_action')

  // ⑪ 等你定卡片：点选项 → 总管收到回答
  await prompt('master', call('master_ask_user', { task: 'L1103-1', question: '用方案 A 还是 B？', options: ['方案A', '方案B'] }))
  await quiet()
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`); await sleep(1500)
  await p.ev(`[...document.querySelectorAll('[data-testid=dsh-master-board] .dshm-link')].find(b=>b.textContent.includes('任务列表'))?.click()`); await sleep(800)
  await p.waitFor('等你定卡片', `!!document.querySelector('[data-testid=dsh-master-board] [data-ask]')`, 15_000)
  const n3 = sb.mock.requests().length
  await p.ev(`[...document.querySelectorAll('[data-ask] button')].find(b=>b.textContent==='方案B').click()`)
  await sb.waitFor('总管收到回答', () => userTexts(n3).some(t => t.includes('回答：方案B')) || undefined)
  await quiet()

  // ⑫ 取消要确认
  await p.ev(`document.querySelector('[data-testid=dsh-master-board] [data-task="L1103-2"]').click()`)
  await p.waitFor('任务详情', `[...document.querySelectorAll('.dshm-btn')].some(b=>b.textContent==='不做了')`)
  await p.ev(`[...document.querySelectorAll('.dshm-btn')].find(b=>b.textContent==='不做了').click()`)
  await p.waitFor('确认条', `document.body.innerText.includes('确认把 L1103-2 标为「取消」')`)
  await p.ev(`[...document.querySelectorAll('.dshm-btn')].find(b=>b.textContent==='算了').click()`); await sleep(800)
  expect((await dstate()).tasks.find((t: any) => t.id === 'L1103-2').state).not.toBe('取消')
  await p.ev(`[...document.querySelectorAll('.dshm-btn')].find(b=>b.textContent==='不做了').click()`)
  await p.ev(`[...document.querySelectorAll('.dshm-btn')].find(b=>b.textContent==='确认').click()`)
  await sb.waitFor('L1103-2 取消', async () => (await dstate()).tasks.find((t: any) => t.id === 'L1103-2' && t.state === '取消'))

  // ⑬ 截图：1920、390（iPhone UA）；无横向溢出；手机顶部工具压成一行
  await p.ev(`[...document.querySelectorAll('[data-testid=dsh-master-board] .dshm-link')].find(b=>b.textContent.includes('任务列表'))?.click()`); await sleep(600)
  await p.size(1920, 1080); await sleep(1200); await p.shot(path.join(OUT, '1920-list.png'))
  expect(await p.ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  await p.size(390, 844); await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.waitFor('手机左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('手机看板', `!!document.querySelector('[data-testid=dsh-master-board]')`, 15_000); await sleep(1000)
  await p.shot(path.join(OUT, '390-list.png'))
  // G5-F ⑧ 取代 G4c 的「一行、横向滑」：窄屏折行，每个按钮都完整落在屏幕内（最多两行）
  const m = await p.ev<any>(`(()=>{const tb=document.querySelector('[data-testid=dsh-master-board] .dshm-tools');const bs=[...tb.querySelectorAll('button')];return {sw:document.documentElement.scrollWidth,w:innerWidth,off:bs.filter(b=>{const r=b.getBoundingClientRect();return r.right>innerWidth+0.5||r.left<-0.5}).length,rows:new Set(bs.map(b=>b.offsetTop)).size}})()`)
  expect(m.sw).toBeLessThanOrEqual(m.w); expect(m.off).toBe(0); expect(m.rows).toBeLessThanOrEqual(2)
  await p.ev(`document.querySelector('[data-testid=dsh-master-board] [data-task="L1103-1"]').click()`)
  await p.waitFor('手机任务详情', `!!document.querySelector('[data-testid=dshm-timeline]')`); await sleep(800)
  // G5 A①：详情页那排按钮换行，每个都完整落在屏幕内（不被右边截掉）
  const clip = await p.ev<any>(`(()=>{const bs=[...document.querySelectorAll('[data-testid=dshm-detail-tools] button')];return {n:bs.length,out:bs.filter(b=>{const r=b.getBoundingClientRect();return r.right>innerWidth+0.5||r.left<-0.5}).map(b=>b.textContent),rows:new Set(bs.map(b=>Math.round(b.getBoundingClientRect().top))).size}})()`)
  expect(clip.n).toBeGreaterThanOrEqual(4); expect(clip.out, '手机详情页被截掉的按钮').toEqual([]); expect(clip.rows).toBeGreaterThan(1)
  await p.ev(`document.querySelector('[data-testid=dshm-timeline] [data-kind=turn] [data-expand]')?.click()`); await sleep(1500)
  await p.shot(path.join(OUT, '390-task.png'))
  expect(await p.ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  await p.close()
}, 300_000)
