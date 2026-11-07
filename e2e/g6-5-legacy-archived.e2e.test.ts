/**
 * G6-5 — 旧单元已存档（假模型 + 沙盒 + 独立无头 Chrome；不碰 3090 / 3082）：
 * 先在旧单元（master / exec-）和一个项目（alpha）里都干点活，旧单元留一条投不出去的派活（故障开关）；
 * 再在状态目录里放标记文件 legacy-archived、重启。之后：
 * - 旧单元：待投的那条不投（还在库里）；旧会话不再装 master_* 工具；旧成员一轮结束不提醒；旧总管的定时保底删掉；
 *   旧看板能看旧任务，顶上写「已存档（只读）」，没有写操作，接口拒绝写（409）；
 * - 项目 alpha 完全不受影响：工具、派活投递、回报、空闲提醒、定时保底、看板都照常。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, type CdpPage, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'docs/g6-5'); fs.mkdirSync(OUT, { recursive: true })
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const tokenOf = (sb: Sandbox) => [...fs.readFileSync(path.join(sb.logDir, 'dsh.2.log'), 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)![1]!

it('G6-5：旧单元存档后只读、不投递不提醒；项目单元照常', async () => {
  const base = path.join(E2E_WORK, `g65-${Date.now()}`)
  const alpha = (() => { const d = path.join(base, 'alpha'); fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) })()
  const legacyW = path.join(base, 'legacy-w'); fs.mkdirSync(legacyW, { recursive: true })
  const faultFile = path.join(base, 'FAULT')
  // 旧总管的工作目录单独做成一个 git 仓库：万一把存档后的旧总管当成新总管去开张，开在这里（测得出来），不会找到外面的 ~/dsh_master
  const legacyMasterCwd = (() => { const d = path.join(base, 'legacy-master'); fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) })()
  const sb = await createSandbox({ name: 'g6-5', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master'), path.join(ROOT, 'spike/g5g-probe-plugin')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, faultFile, masterCwd: legacyMasterCwd, fakeScheduleDelayMs: 5000, rate: { backoffMs: 1000, maxAttempts: 1000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await prompt(sid, text); await quiet() }
  const mine = (sid: string) => sb.mock.requests().filter(r => r.messages.some(m => m.text.includes(`你是执行会话（${sid}）`) || m.text.includes(`# 你是总管（会话 ${sid}）`)) || r.messages.some(m => m.role === 'user' && m.text.includes(`SID=${sid}`)))
  const sees = (sid: string, mark: string) => mine(sid).some(r => r.messages.some(m => m.text.includes(mark)))
  const events = (pj: string | null, type: string) => sb.get(`/dsh-master-debug/events?type=${encodeURIComponent(type)}${pj ? `&project=${pj}` : ''}`) as Promise<any[]>
  const schedules = async () => ((await sb.get('/dsh-master-debug/schedules')) ?? []) as any[]
  // 存档后旧会话没有角色守则了，不能靠守则认会话：认插件转来的消息抬头「发给 exec-w」
  const delivered = (to: string, mark: string) => sb.mock.requests().some(r => r.messages.some(m => m.text.includes(mark) && m.text.includes(`发给 ${to}`)))

  // ── 存档前：旧单元和项目都在干活 ──
  await run('master', call('master_spawn', { name: 'w', cwd: legacyW, title: '旧成员' }))
  await run('master', call('master_dispatch', { task: 'L1106-9', kind: 'light', title: 'LEGACY 旧任务', to: 'w', text: 'OLD-TASK-MARK' }))
  await sb.waitFor('旧成员收到派活', async () => delivered('exec-w', 'OLD-TASK-MARK'))
  await run('master', call('master_ask_user', { task: 'L1106-9', question: '旧问题？', options: ['是', '否'] }))
  await sb.post('/dsh-master-debug/create', { id: 'a-master', cwd: alpha, preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).units.includes('alpha'))
  await run('a-master', call('master_spawn', { name: 'x', title: '成员 X' }))
  await sb.waitFor('两个总管都有定时保底', async () => { const s = await schedules(); return ['master', 'a-master'].every(id => s.some(c => c.sessionId === id && String(c.title).startsWith('dsh-master 定时巡检保底'))) })
  // 旧单元留一条投不出去的派活
  fs.writeFileSync(faultFile, 'on')
  await run('master', call('master_dispatch', { task: 'L1106-8', kind: 'light', title: '存档前没投出去的', to: 'w', text: 'STUCK-MARK' }))
  // 项目里也留一条投不出去的：存档后它必须靠投递泵重试送到（项目单元不受影响）
  await run('a-master', call('master_dispatch', { task: 'L1106-2', kind: 'light', title: 'alpha 存档前没投出去的', to: 'x', text: 'ALPHA-STUCK-MARK' }))
  await sleep(3000)
  expect(delivered('exec-w', 'STUCK-MARK')).toBe(false)
  expect(delivered('alpha.x', 'ALPHA-STUCK-MARK')).toBe(false)
  expect((await sb.get('/dsh-master-debug/state')).deliveries.pending).toBe(1)
  expect((await sb.get('/dsh-master-debug/state?project=alpha')).deliveries.pending).toBe(1)

  // ── 存档：放标记文件，重启 ──
  fs.writeFileSync(path.join(sb.home, 'dsh-master', 'legacy-archived'), `archived for test\n`)
  fs.rmSync(faultFile)
  await sb.restart(); await sleep(4000)
  const arch = await events(null, 'legacy/archived')
  expect(arch).toHaveLength(1)
  expect(arch[0].data.scheduleRemoved).toHaveLength(1)
  expect(arch[0].data.scheduleService).toBe(true) // 宿主的定时服务晚 5 秒才就绪（fakeScheduleDelayMs），插件要等到它
  const s2 = await schedules()
  expect(s2.some(c => c.sessionId === 'master')).toBe(false)
  expect(s2.some(c => c.sessionId === 'a-master' && String(c.title).startsWith('dsh-master 定时巡检保底'))).toBe(true)

  // ── 旧单元：不投递（那条还在库里）、不装工具、不提醒 ──
  await sleep(6000)
  expect(delivered('exec-w', 'STUCK-MARK')).toBe(false)
  expect((await sb.get('/dsh-master-debug/state')).deliveries.pending).toBe(1) // 还在库里，没丢、也没投
  const nBefore = sb.mock.requests().length
  await run('master', '你好 SID=master LEGACY-PING')
  const legacyReq = sb.mock.requests().slice(nBefore).find(r => r.messages.some(m => m.text.includes('LEGACY-PING')))!
  expect(legacyReq.tools.filter(t => t?.startsWith('master_'))).toEqual([])
  expect(legacyReq.messages.some(m => m.text.includes('# 你是总管'))).toBe(false)
  const n1 = sb.mock.requests().length
  await run('exec-w', '随便说一句 SID=exec-w LEGACY-W-PING')
  await sleep(4000); await quiet()
  // 请求里带着整段历史（存档前的提醒也在里面），所以看「旧总管有没有被叫起来再跑一轮」：有提醒投过去它就会跑
  expect(sb.mock.requests().slice(n1).some(r => r.messages.some(m => m.text.includes('LEGACY-PING')))).toBe(false)
  expect((await events(null, 'message/queued')).filter(e => Date.parse(e.at) > Date.parse(arch[0].at))).toEqual([])
  // 存档后的旧总管（用总管预设建的）被宿主重新加载时，不能被当成新总管去开张
  expect((await sb.get('/dsh-master-debug/projects')).registry.map((p: any) => p.id)).toEqual(['alpha'])
  expect(fs.existsSync(path.join(legacyMasterCwd, '.dsh-master'))).toBe(false)
  expect((await events(null, 'project/owned-elsewhere')).concat(await events(null, 'project/second-master'))).toEqual([])
  // G7 ⑤ 起旧总管会收到「已存档」说明（里面教用户怎么开张），所以只认开张消息本身
  expect(JSON.stringify(await sb.get('/dsh-master-debug/history?sessionId=master'))).not.toContain('这个工作区已开张为项目')

  // ── 项目 alpha 完全照常：存档前投不出去的那条由投递泵送到；工具、派活、回报、空闲提醒 ──
  await sb.waitFor('alpha 存档前那条重试送到', async () => delivered('alpha.x', 'ALPHA-STUCK-MARK'), 30_000)
  expect((await sb.get('/dsh-master-debug/state?project=alpha')).deliveries.pending).toBe(0)
  await quiet()
  const n2 = sb.mock.requests().length
  await run('a-master', call('master_dispatch', { task: 'L1106-1', kind: 'light', title: 'alpha 的活', to: 'x', text: 'ALPHA-AFTER-ARCHIVE' }))
  await sb.waitFor('alpha 成员收到派活', async () => sees('alpha.x', 'ALPHA-AFTER-ARCHIVE'))
  expect(sb.mock.requests().slice(n2).some(r => r.tools.includes('master_dispatch'))).toBe(true)
  // 成员处理派活那一轮没回报就结束了 ⇒ 总管收到空闲提醒（项目单元照常提醒）
  await sb.waitFor('alpha 空闲提醒照常', async () => sees('a-master', 'alpha.x 一轮结束了'), 30_000)
  await run('alpha.x', call('master_report', { task: 'L1106-1', state: '完成', action: 'ALPHA-REPORT-MARK' }))
  await sb.waitFor('alpha 总管收到回报', async () => sees('a-master', 'ALPHA-REPORT-MARK'))

  // ── 看板：旧看板只读、项目看板照常 ──
  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p: CdpPage = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('探针客户端', `!!window.__g6probe`, 15_000)
  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  const openBoard = async (sid: string) => {
    await p.ev(`window.__g6probe.openSession(${JSON.stringify(sid)})`); await sleep(2000)
    await p.ev(`[...document.querySelectorAll('[data-testid=dshm-header-board]')].find(e=>e.offsetParent!==null)?.click()`)
  }
  await openBoard('master')
  await p.waitFor('旧看板', `!!${board}?.querySelector('[data-testid=dshm-archived]') && ${board}.innerText.includes('LEGACY 旧任务')`, 20_000)
  expect(await p.ev<string>(`${board}.querySelector('[data-testid=dshm-archived]').innerText`)).toMatch(/^旧单元已存档（只读）/)
  expect(await p.ev(`[...${board}.querySelectorAll('button')].some(b=>b.textContent.includes('新任务'))`)).toBe(false)
  expect(await p.ev(`!!${board}.querySelector('[data-ask] .dshm-acts')`)).toBe(false) // 等你定看得到，没有回答按钮
  expect(await p.ev<string>(`${board}.querySelector('[data-ask]').innerText`)).toContain('旧问题？')
  const post = await p.ev<any>(`fetch('/api/dsh-master/action?session=master',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-dsh-master':'1'},body:JSON.stringify({action:'done',task:'L1106-9'})}).then(async r=>({status:r.status, body:await r.json()}))`)
  expect(post).toMatchObject({ status: 409, body: { code: 'archived' } })
  await p.shot(path.join(OUT, '1280-legacy-archived.png'))
  await p.ev(`${board}.querySelector('[data-task="L1106-9"]').click()`)
  await p.waitFor('旧任务详情', `!!document.querySelector('[data-testid=dshm-timeline]')`, 10_000)
  expect(await p.ev(`[...document.querySelectorAll('.dshm-foot button')].length`)).toBe(0)
  await openBoard('a-master')
  await p.waitFor('alpha 看板', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-task="L1106-1"]')`, 20_000)
  expect(await p.ev(`!!${board}.querySelector('[data-testid=dshm-archived]')`)).toBe(false)
  expect(await p.ev(`[...${board}.querySelectorAll('button')].some(b=>b.textContent.includes('新任务'))`)).toBe(true)
  await p.shot(path.join(OUT, '1280-project-after-archive.png'))
  await p.close()
}, 400_000)
