/**
 * G2 端到端（假模型 + 沙盒 DSH_HOME）：
 * 角色限制 → 建执行会话 → 轻任务一次走完 → 重任务 G1（先不回报触发空闲兜底，再回报就绪）→ 守卫 →
 * 投递故障中途重启 DSH、重启后重试 → 验收完成 → 核对每条消息恰好到达一次 → 用户 ~/.dsh 与 dsh web 未动。
 *
 * 假模型的「脑子」写在消息里：用户消息或转来的消息里有一行 `CALL <工具> <json>`，假模型就调这个工具。
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

function userDshFingerprint() {
  const home = path.join(os.homedir(), '.dsh')
  const list = (d: string) => fs.existsSync(d) ? fs.readdirSync(d).sort().map(n => { const st = fs.statSync(path.join(d, n)); return `${n}:${st.mtimeMs}` }) : []
  return { sessions: list(path.join(home, 'sessions')), storages: list(path.join(home, 'storages')), profiles: list(path.join(home, 'profiles')) }
}
async function userWebStatus(): Promise<string> {
  try { return String((await fetch('http://127.0.0.1:3080/', { signal: AbortSignal.timeout(3000) })).status) } catch (e) { return `down: ${String(e)}` }
}

it('G2：派活 / 回报 / 验收全流程，中途重启不丢不重', async () => {
  const before = userDshFingerprint(); const webBefore = await userWebStatus()
  const base = path.join(E2E_WORK, `g2-${Date.now()}`)
  const workerDir = path.join(base, 'worker'); const plainDir = path.join(base, 'plain'); fs.mkdirSync(workerDir, { recursive: true }); fs.mkdirSync(plainDir, { recursive: true })
  const faultFile = path.join(base, 'FAULT')
  sb = await createSandbox({ name: 'g2-flow', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 3000, faultFile, rate: { backoffMs: 1000, maxAttempts: 10 } } })
  const s = sb
  await s.start()
  const stateDir = path.join(s.home, 'dsh-master')
  const state = () => s.get('/dsh-master-debug/state')
  const history = (sid: string) => s.get<any[]>(`/dsh-master-debug/history?sessionId=${encodeURIComponent(sid)}`)
  const prompt = (sid: string, text: string) => s.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const task = async (id: string) => (await state()).tasks.find((t: any) => t.id === id)
  const reqWith = (needle: string) => s.waitFor(`假模型收到含「${needle}」的请求`, () => s.mock.requests().find(r => r.messages.some(m => m.text.includes(needle))))
  const toolResult = (sid: string, needle: string) => s.waitFor(`${sid} 的工具结果含「${needle}」`, async () => (await history(sid)).find(e => e.type === 'tool/result' && e.data.includes(needle)))

  // 1. 角色限制：不在花名册的普通会话一个 dsh-master 工具都没有
  await s.post('/dsh-master-debug/create', { id: 'plain-1', cwd: plainDir })
  await prompt('plain-1', 'plain hello')
  const plainReq = await reqWith('plain hello')
  expect(plainReq.tools.filter(t => t.startsWith('master_'))).toEqual([])

  // 2. 总管建执行会话；执行会话只有 master_report，没有给别人发消息的内置工具
  await prompt('master', call('master_spawn', { name: 'worker', cwd: workerDir, title: '执行 W' }))
  await s.waitFor('exec-worker 进花名册', async () => (await state()).sessions.find((x: any) => x.id === 'exec-worker'))
  await prompt('exec-worker', 'worker hello')
  const workerReq = await reqWith('worker hello')
  expect(workerReq.tools).toContain('master_report')
  for (const t of ['master_dispatch', 'master_send', 'master_review', 'send_message', 'list_agents', 'schedule_create']) expect(workerReq.tools).not.toContain(t)

  // 3. 轻任务：派活 → 执行会话回报完成 → 任务完成，总管收到状态行
  await prompt('master', call('master_dispatch', { task: 'L1103-1', kind: 'light', title: '数文件', to: 'worker',
    text: `数一下工作目录里的文件\n${call('master_report', { task: 'L1103-1', state: '完成', action: '数完了：0 个文件' })}` }))
  await s.waitFor('L1103-1 完成', async () => (await task('L1103-1'))?.state === '完成')
  await s.waitFor('总管收到 L1103-1 的完成回报', async () => (await history('master')).find(e => e.type === 'user/message' && e.source === 'dsh-master' && /\[L1103-1\] 状态=完成 ｜时间：\d{4}-\d\d-\d\d \d{4} ｜当前动作：数完了/.test(e.text)))

  // 4. 重任务 G1：派活说明里没有回报指令 → 执行会话一轮结束没回报 → 3 秒后总管收到空闲提醒
  await prompt('master', call('task_spec_write', { task: 'T001', title: '写 spike', expected: '1 小时', output: workerDir, resume: '读 docs/spike.md 接着写',
    目标: '写 spike 记录', 要读的: '无', 交付物: 'docs/spike.md', 验收标准: '每项有命令和读数', 红线: '不碰 ~/.dsh' , gates: [{ id: 'G1', title: '写 spike' }, { id: 'G2', title: '收尾' }] }))
  await s.waitFor('T001 任务书写好', async () => (await state()).events.find((e: any) => e.type === 'spec/written' && e.task === 'T001'))
  await prompt('master', call('master_dispatch', { task: 'T001', kind: 'heavy', title: '写 spike', to: 'worker', gate: 'G1', text: 'G1：写 spike 记录' }))
  await s.waitFor('T001 进行中', async () => (await task('T001'))?.state === '进行中')
  const idle = await s.waitFor('总管收到空闲没回报的提醒', async () => (await history('master')).find(e => e.type === 'user/message' && e.text.includes('exec-worker 一轮结束了，但没有用 master_report 回报')), 30_000)
  expect(idle.text).toContain('T001[进行中]')

  //    总管追问 → 执行会话回报就绪
  await prompt('master', call('master_send', { to: 'worker', task: 'T001', text: `怎么样了？\n${call('master_report', { task: 'T001', state: '就绪', gate: 'G1', action: 'G1 写完', body: `产物 ${workerDir}` })}` }))
  await s.waitFor('T001 待验收', async () => (await task('T001'))?.state === '待验收')

  // 5. 守卫：执行会话（免审批）用 bash 写状态目录被拒；总管 sleep 被拒
  await prompt('exec-worker', call('bash', { command: `false && echo x >> ${stateDir}/master.db`, description: 'try write state', timeoutMs: 5000 }))
  const denied = await toolResult('exec-worker', '守卫')
  expect(denied.data).toContain('总管状态目录只能通过 dsh-master 工具改')
  await prompt('master', call('bash', { command: 'sleep 40', description: 'wait', timeoutMs: 5000 }))
  await toolResult('master', '总管不等待')

  // 6. 投递故障 → 验收消息投不出去（留在库里待重试）→ 中途重启 DSH → 故障解除 → 重启后投出
  fs.writeFileSync(faultFile, 'on')
  await prompt('master', call('master_review', { task: 'T001', verdict: '通过', gate: 'G1', notes: `G1 通过，做收尾\n${call('master_report', { task: 'T001', state: '完成', gate: 'G2', action: '收尾完成' })}` }))
  const retrying = await s.waitFor('验收消息投递失败、等待重试', async () => (await state()).events.find((e: any) => e.type === 'message/retry' && e.data.includes('review:T001')))
  expect(retrying).toBeTruthy()
  const pidBefore = s.pid()
  await s.stop()
  fs.rmSync(faultFile)
  await s.start()
  expect(s.pid()).not.toBe(pidBefore)
  await s.waitFor('重启后验收消息投出、执行会话回报收尾完成', async () => (await state()).events.find((e: any) => e.type === 'task/report' && e.data.includes('"state":"完成"') && e.task === 'T001'), 60_000)

  // 7. 最终验收：完成
  await prompt('master', call('master_review', { task: 'T001', verdict: '通过', gate: 'G2', notes: '全部完成', final: true }))
  await s.waitFor('T001 完成', async () => (await task('T001'))?.state === '完成')
  await s.waitFor('所有投递都已送达', async () => { const st = await state(); return st.deliveries.pending === 0 && st.deliveries.error.length === 0 ? st : undefined })

  // 8. 不丢不重：库里每条消息在目标会话的持久历史里恰好出现一次，没有多出来的
  const db = new DatabaseSync(path.join(stateDir, 'master.db'), { readOnly: true })
  const msgs = db.prepare('SELECT key, to_id FROM messages ORDER BY seq').all() as Array<{ key: string; to_id: string }>
  const dels = db.prepare(`SELECT state, count(*) AS c FROM deliveries GROUP BY state`).all() as Array<{ state: string; c: number }>
  db.close()
  expect(dels).toEqual([{ state: 'delivered', c: msgs.length }])
  const byTarget = new Map<string, string[]>()
  for (const m of msgs) byTarget.set(m.to_id, [...(byTarget.get(m.to_id) ?? []), `dsh-master:${m.key}`])
  const summary: Record<string, unknown> = {}
  for (const [to, ids] of byTarget) {
    const got = (await history(to)).filter(e => e.type === 'user/message' && e.source === 'dsh-master' && !String(e.id).startsWith('dsh-master:push:')).map(e => e.id)
    summary[to] = { expected: ids.length, got: got.length }
    expect(got.slice().sort(), `${to} 收到的 dsh-master 消息`).toEqual(ids.slice().sort())
  }
  // DSH 侧去重：绕过库把一条已投过的派活再投一次，目标会话里仍只有一条
  const dispatchKey = msgs.find(m => m.key.startsWith('dispatch:T001'))!.key
  expect(await s.post('/dsh-master-debug/redeliver', { key: dispatchKey })).toEqual({ result: 'already' })
  expect((await history('exec-worker')).filter(e => e.id === `dsh-master:${dispatchKey}`)).toHaveLength(1)
  //    重启边界：plugin/start 记了两次（两个不同 pid）
  const db2 = new DatabaseSync(path.join(stateDir, 'master.db'), { readOnly: true })
  const starts = db2.prepare(`SELECT data FROM events WHERE type = 'plugin/start' ORDER BY seq`).all() as Array<{ data: string }>
  db2.close()
  expect(new Set(starts.map(x => JSON.parse(x.data).pid)).size).toBe(2)
  expect(JSON.parse(starts[1]!.data).pending).toBe(1) // 重启时库里正好有那条待重试的验收消息
  console.log('[g2-flow] plugin/start', starts.map(x => x.data).join(' | '))
  console.log('[g2-flow] 消息核对', JSON.stringify(summary), '投递', JSON.stringify(dels))
  for (const key of ['dispatch:L1103-1', 'dispatch:T001', 'review:T001:G1', 'review:T001:G2', 'report:L1103-1', 'report:T001:就绪', 'report:T001:完成', 'idle:exec-worker'])
    expect(msgs.filter(m => m.key.startsWith(key)).length, key).toBe(1)

  // 9. 面板接口：/api 走 DSH owner 认证——不带凭证被拒；用启动 token 换的 cookie 能读到快照
  const unauth = await fetch(`${s.url}/api/dsh-master/state`)
  expect([401, 403]).toContain(unauth.status)
  const token = (fs.readFileSync(path.join(s.logDir, 'dsh.2.log'), 'utf8').match(/token=([A-Za-z0-9_-]+)/) ?? [])[1]
  expect(token).toBeTruthy()
  const login = await fetch(`${s.url}/?token=${token}`, { redirect: 'manual' })
  const cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  expect(cookie).not.toBe('')
  const panel = await fetch(`${s.url}/api/dsh-master/state`, { headers: { cookie, origin: s.url } })
  expect(panel.status).toBe(200)
  const snap = await panel.json()
  expect(snap.tasks.map((t: any) => `${t.id}:${t.state}`).sort()).toEqual(['L1103-1:完成', 'T001:完成'])
  console.log('[g2-flow] 面板接口', unauth.status, '→', panel.status, '任务', snap.tasks.length, '会话', snap.sessions.length)

  // 10. 用户环境未动
  await s.dispose(); sb = undefined
  expect(userDshFingerprint()).toEqual(before)
  expect(await userWebStatus()).toBe(webBefore)
})
