/**
 * G3 端到端（假模型 + 沙盒 DSH_HOME）：
 * 记忆层（devlog + 记忆桥）→ 自动推送回忆 ①按文件（写前拦一次，原样再调放行；受保护目录拦几次都拒）②按话题（模型没主动查也收到）
 * → 守卫两种绕过 → 静默巡检（无变化零投递、有变化只投一次）→ 空闲兜底轮次落库（中途重启不漏）→ 用户直接指示 → heavy_run
 * → 定时巡检保底 → 用户 ~/.dsh 与 dsh web 未动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, type Sandbox, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
let sb: Sandbox | undefined
afterAll(async () => { await sb?.dispose() })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function userDshFingerprint() {
  const home = path.join(os.homedir(), '.dsh')
  const list = (d: string) => fs.existsSync(d) ? fs.readdirSync(d).sort().map(n => `${n}:${fs.statSync(path.join(d, n)).mtimeMs}`) : []
  return { sessions: list(path.join(home, 'sessions')), storages: list(path.join(home, 'storages')), profiles: list(path.join(home, 'profiles')) }
}
async function userWebStatus(): Promise<string> {
  try { return String((await fetch('http://127.0.0.1:3080/', { signal: AbortSignal.timeout(3000) })).status) } catch (e) { return `down: ${String(e)}` }
}

it('G3：记忆层 + 自动推送回忆 + 守卫绕过修复 + 静默巡检 + 重启不漏兜底', async () => {
  const before = userDshFingerprint(); const webBefore = await userWebStatus()
  const base = path.join(E2E_WORK, `g3-${Date.now()}`)
  const workerDir = path.join(base, 'worker'); fs.mkdirSync(workerDir, { recursive: true })
  const PATROL_MS = 1500
  sb = await createSandbox({ name: 'g3-memory', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], slowMs: 8000,
    pluginConfig: { idleGraceMs: 2000, patrol: { intervalMs: PATROL_MS }, fakeFreeGb: 32 } })
  const s = sb
  await s.start()
  const stateDir = path.join(s.home, 'dsh-master'); const docs = path.join(stateDir, 'docs')
  const state = () => s.get('/dsh-master-debug/state')
  const history = (sid: string) => s.get<any[]>(`/dsh-master-debug/history?sessionId=${encodeURIComponent(sid)}`)
  const prompt = (sid: string, text: string) => s.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const db = (file: string) => new DatabaseSync(path.join(stateDir, file), { readOnly: true })
  const q = <T,>(file: string, sql: string, ...a: any[]): T[] => { const d = db(file); try { return d.prepare(sql).all(...a) as T[] } finally { d.close() } }
  const toolResults = async (sid: string) => (await history(sid)).filter(e => e.type === 'tool/result').map(e => e.data as string)
  const waitToolResult = (sid: string, needle: string, after = 0) => s.waitFor(`${sid} 的工具结果含「${needle}」`, async () => (await toolResults(sid)).slice(after).find(d => d.includes(needle)))
  const reqs = () => s.mock.requests()

  // 0. 建执行会话（worker；inner 的工作目录就在状态目录里）
  await prompt('master', call('master_spawn', { name: 'worker', cwd: workerDir, title: '执行 W' }))
  await s.waitFor('exec-worker 进花名册', async () => (await state()).sessions.find((x: any) => x.id === 'exec-worker'))
  await prompt('master', call('master_spawn', { name: 'inner', cwd: docs, title: '状态目录里的会话' }))
  await s.waitFor('exec-inner 进花名册', async () => (await state()).sessions.find((x: any) => x.id === 'exec-inner'))

  // 1. 定时巡检保底：绑在 master 上、6 小时一次、提示写明不是用户
  const sched = await s.get<any[]>('/dsh-master-debug/schedules')
  const mine = sched.filter(x => x.sessionId === 'master' && x.title.startsWith('dsh-master 定时巡检保底'))
  expect(mine).toHaveLength(1)
  expect(mine[0].everySeconds).toBe(21600)
  expect(mine[0].prompt).toContain('不是用户说的')

  // 2. 记忆层：执行会话写一条 devlog（带 lesson → 记忆桥）；files_touched 里故意也放一个状态目录里的文件
  const appFile = path.join(workerDir, 'app.py')
  await prompt('exec-worker', call('devlog_add', { slug: 'app-server-port', hook: 'app.py 端口从 8000 改到 8090，避开总管实例端口', tags: ['app-server', '端口配置', '部署链'],
    files_touched: [appFile, path.join(docs, 'board.md')], depth: '实质', sections: { 改了什么: '改端口', 为什么: '8000 被占', 坑与教训: '改端口前先 lsof 看占用' },
    lesson: { rule: '改端口前先 lsof 看占用', why: '8000 被另一个进程占着，启动静默失败', how: '改 app.py 端口前跑 lsof -i' } }))
  await waitToolResult('exec-worker', 'feedback-app-server-port')
  const memState = await s.get<any>('/dsh-master-debug/mem')
  expect(memState.devlog[0]).toMatch(/^- \[\d{4}-\d\d-\d\d \d{4}\] \[app-server-port\]\(\d{4}-\d\d-\d\d-\d{4}-app-server-port\.md\) — app\.py 端口/)
  expect(memState.memories.map((m: any) => m.name)).toEqual(['feedback-app-server-port'])
  expect(fs.readFileSync(path.join(docs, 'memory', 'feedback-app-server-port.md'), 'utf8')).toContain('[[app-server-port]]')
  expect(fs.readFileSync(path.join(docs, 'memory', 'MEMORY.md'), 'utf8')).toContain('feedback-app-server-port')

  // 3. 自动推送 ①（按文件）：模型没查过，直接写 app.py → 第一次被「前情提醒」拦下（带前情和记忆）→ 原样再调 → 放行；再改同一文件不再拦
  const n0 = (await toolResults('exec-worker')).length
  await prompt('exec-worker', call('write', { file_path: appFile, content: 'PORT = 8090\n' }))
  const pushed = await waitToolResult('exec-worker', '前情提醒', n0)
  expect(pushed).toContain('app-server-port'); expect(pushed).toContain('feedback-app-server-port')
  expect(fs.existsSync(appFile)).toBe(false)
  const pushReq = await s.waitFor('假模型收到前情提醒（工具结果）', () => reqs().find(r => r.messages.some(m => m.role === 'tool' && m.text.includes('[dsh-master 前情提醒') && m.text.includes('app-server-port'))))
  expect(pushReq).toBeTruthy()
  const n1 = (await toolResults('exec-worker')).length
  await prompt('exec-worker', call('write', { file_path: appFile, content: 'PORT = 8090\n' }))
  await s.waitFor('第二次写成功', () => fs.existsSync(appFile))
  await prompt('exec-worker', call('bash', { command: `echo "# note" >> ${appFile}`, description: 'append', timeoutMs: 5000 }))
  await s.waitFor('追加成功', () => fs.readFileSync(appFile, 'utf8').includes('# note'))
  expect((await toolResults('exec-worker')).slice(n1).filter(d => d.includes('前情提醒'))).toHaveLength(0)
  const filePushes = (await state()).events.filter((e: any) => e.type === 'recall/push-file')
  expect(filePushes).toHaveLength(1)

  //    「原样再调就放行」不是守卫的口子：状态目录里的文件（同样在 files_touched 里有前情）调几次都拒
  const boardFile = path.join(docs, 'board.md')
  const boardBefore = fs.readFileSync(boardFile, 'utf8')
  for (let i = 0; i < 3; i++) {
    const n = (await toolResults('exec-worker')).length
    await prompt('exec-worker', call('write', { file_path: boardFile, content: 'hacked' }))
    const r = await waitToolResult('exec-worker', '守卫', n)
    expect(r).not.toContain('前情提醒')
  }
  expect(fs.readFileSync(boardFile, 'utf8')).toBe(boardBefore)

  // 4. 自动推送 ②（按话题）：在一个没收到过这条前情的会话（exec-inner）里，用户随口提到 tag；
  //    这句话第一次进到模型的那个请求里，就插着「相关前情」，而模型从没调过 devlog_recall
  //    （worker 那边在第 3 步写 app.py 时已经按话题推过一次了：指令里提到了文件名）
  await prompt('exec-inner', '帮我看看端口配置还有没有别的问题')
  const isTopicPush = (m: { role: string; text: string }) => m.role === 'user' && m.text.startsWith('[dsh-master 相关前情（自动推送') && m.text.includes('app-server-port')
  const topicReq = await s.waitFor('这句话第一次进模型的请求', () => reqs().find(r => r.messages.some(m => m.text.includes('帮我看看端口配置'))))
  const userIdx = topicReq.messages.findIndex(m => m.text.includes('帮我看看端口配置'))
  const pushIdx = topicReq.messages.findIndex(isTopicPush)
  expect(topicReq.messages.filter(isTopicPush)).toHaveLength(1)
  expect(topicReq.messages[pushIdx]!.text).toContain('提到了 tag「端口配置」')
  expect(pushIdx).toBeGreaterThan(userIdx) // 插在这一步用户消息之后、模型回答之前
  const workerFirstPush = reqs().find(r => r.messages.some(isTopicPush) && r.messages.some(m => m.text.includes('CALL write')))
  expect(workerFirstPush).toBeTruthy()
  const recallCalls = reqs().filter(r => 'tool' in r.plan && r.plan.tool.name === 'devlog_recall')
  expect(recallCalls).toHaveLength(0) // 模型从没主动查过
  expect(topicReq.messages[0]!.text).toContain('记忆层摘要') // ③ 常驻摘要在系统提示里

  // 5. 守卫两种绕过（G2 遗留）：变量写法、cwd 在状态目录里相对写
  let n = (await toolResults('exec-worker')).length
  await prompt('exec-worker', call('bash', { command: 'echo x >> $DSH_HOME/dsh-master/a.md', description: 'var', timeoutMs: 5000 }))
  expect(await waitToolResult('exec-worker', '守卫', n)).toContain('总管状态目录')
  n = (await toolResults('exec-inner')).length
  await prompt('exec-inner', call('bash', { command: 'echo x >> a.md', description: 'rel', timeoutMs: 5000 }))
  expect(await waitToolResult('exec-inner', '守卫', n)).toContain('工作目录就在状态目录里')
  expect(fs.existsSync(path.join(stateDir, 'a.md'))).toBe(false); expect(fs.existsSync(path.join(docs, 'a.md'))).toBe(false)

  // 6. 静默巡检：先让它稳定，然后 4 个周期内零投递；带外改一个受管文件 → 只投一次
  const patrolMsgs = () => q<{ key: string }>('master.db', `SELECT key FROM messages WHERE key LIKE 'patrol:%'`)
  await sleep(PATROL_MS * 2)
  const baseline = patrolMsgs().length
  await sleep(PATROL_MS * 4)
  expect(patrolMsgs().length).toBe(baseline)
  fs.appendFileSync(path.join(docs, 'memory', 'MEMORY.md'), '\n手改的一行\n')
  await s.waitFor('巡检报出带外改动', () => patrolMsgs().length === baseline + 1 ? true : undefined, 20_000)
  await sleep(PATROL_MS * 4)
  expect(patrolMsgs().length).toBe(baseline + 1)
  const report = (await history('master')).find(e => e.type === 'user/message' && e.text.includes('巡检发现') && e.text.includes('memory/MEMORY.md'))
  expect(report.text).toContain('被插件之外的方式改过')

  // 7. 空闲兜底轮次落库：派一件轻任务让执行会话慢慢做（假模型 8 秒），做到一半重启 DSH → 重启后仍提醒总管
  await prompt('master', call('master_dispatch', { task: 'L1103-7', kind: 'light', title: '慢活', to: 'worker', text: 'SLOW 慢慢做，不用回报' }))
  await s.waitFor('exec-worker 开始这一轮', async () => (await s.get<any>('/dsh-master-debug/status'))['exec-worker'] === 'running')
  const turnBefore = q<{ started_ms: number }>('master.db', `SELECT started_ms FROM turns WHERE session = 'exec-worker'`)[0]!.started_ms
  await s.stop()
  await s.start()
  const idle = await s.waitFor('重启后总管收到空闲提醒', async () => (await history('master')).find(e => e.type === 'user/message' && e.text.includes('exec-worker 一轮结束了，但没有用 master_report 回报') && e.text.includes('L1103-7')), 30_000)
  expect(idle).toBeTruthy()
  expect(q<{ key: string }>('master.db', `SELECT key FROM messages WHERE key = ?`, `idle:exec-worker:${turnBefore}`)).toHaveLength(1)

  // 8. 用户直接对执行会话说话（它有在途任务 L1103-7）→ 总管被告知
  await prompt('exec-worker', '先别做了，换成写文档')
  await s.waitFor('总管收到用户直接指示', async () => (await history('master')).find(e => e.type === 'user/message' && e.text.includes('用户直接在 exec-worker 里说了话') && e.text.includes('先别做了')))

  // 9. heavy_run：排队 → 跑完 → 执行会话收到结束消息
  await prompt('exec-worker', call('heavy_run', { label: 'echo', command: 'echo heavy-ok > heavy.txt', min_free_gb: 1 }))
  await s.waitFor('执行会话收到重活结束消息', async () => (await history('exec-worker')).find(e => e.type === 'user/message' && e.text.includes('heavy_run #') && e.text.includes('跑完了')), 30_000)
  expect(fs.readFileSync(path.join(workerDir, 'heavy.txt'), 'utf8')).toBe('heavy-ok\n')

  // 10. 汇总 + 用户环境未动
  const pushes = q<{ type: string; c: number }>('master.db', `SELECT type, count(*) AS c FROM events WHERE type LIKE 'recall/%' GROUP BY type ORDER BY type`)
  console.log('[g3] 推送', JSON.stringify(pushes), '巡检消息', patrolMsgs().length, '前情提醒请求 #', pushReq.n, '话题推送请求 #', topicReq.n)
  await s.dispose(); sb = undefined
  expect(userDshFingerprint()).toEqual(before)
  expect(await userWebStatus()).toBe(webBefore)
})
