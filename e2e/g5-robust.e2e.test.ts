/**
 * G5 B 稳健性端到端（假模型 + 沙盒；不碰 3090）：
 * ① kill -9 强杀 DSH 后重启：卡在重试里的投递不丢不重，任务状态与归属完整，旧锁被接管；
 * ② 模型接口断网（连接断开 / HTTP 500）：插件不崩、巡检与自检不误报；恢复后上下文接上、派活照常；
 * ③ 备份恢复：用每日备份恢复出一个新实例，任务、归属、记忆、devlog、手册逐项对得上；恢复脚本在实例运行时拒绝；
 * ④ 自检命令（lib/doctor.js）：干净时不报；带外改动能列出、不自动修。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, type Sandbox, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const DOCTOR = path.join(ROOT, 'packages/dsh-master/lib/doctor.js')
const RESTORE = path.join(ROOT, 'scripts/restore-backup.sh')
const q = <T,>(file: string, sql: string): T[] => { const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare(sql).all() as T[] } finally { d.close() } }
const doctorCli = (stateDir: string) => { const r = spawnSync('node', [DOCTOR, '--state', stateDir, '--json'], { encoding: 'utf8' }); return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr } }
const filesUnder = (dir: string, sub: string) => { const d = path.join(dir, sub); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.md')).sort().map(f => [`${sub}/${f}`, fs.readFileSync(path.join(d, f), 'utf8')] as const) : [] }

it('恢复脚本：备份就在状态目录里也能原地恢复；复制中途失败时原目录不动', () => {
  const t = path.join(E2E_WORK, `restore-${Date.now()}`)
  const mk = (p: string, c: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c) }
  const st = path.join(t, 'state'); const bk = path.join(st, 'backups', '20261104')
  mk(path.join(st, 'master.db'), 'A'); mk(path.join(st, 'memory.db'), 'MA'); mk(path.join(st, 'docs/x.md'), 'x')
  mk(path.join(bk, 'master.db'), 'B'); mk(path.join(bk, 'memory.db'), 'MB'); mk(path.join(bk, 'docs/y.md'), 'y')
  // ① 原地恢复（备份在状态目录里面）
  const r = spawnSync('bash', [RESTORE, bk, st], { encoding: 'utf8' })
  expect(r.status, r.stdout + r.stderr).toBe(0)
  expect(fs.readFileSync(path.join(st, 'master.db'), 'utf8')).toBe('B'); expect(fs.readFileSync(path.join(st, 'memory.db'), 'utf8')).toBe('MB')
  expect(fs.existsSync(path.join(st, 'docs/y.md'))).toBe(true); expect(fs.existsSync(path.join(st, 'docs/x.md'))).toBe(false)
  expect(fs.existsSync(path.join(st, 'backups/20261104/master.db'))).toBe(true) // 旧的 backups 带回来了
  const old = fs.readdirSync(t).find(d => d.startsWith('state.before-restore-'))!
  expect(fs.readFileSync(path.join(t, old, 'master.db'), 'utf8')).toBe('A')
  // ② 复制中途失败（备份放在状态目录外面，失败只可能出在复制 docs 这一步）：原目录原样，不留临时目录
  const bk2 = path.join(t, 'outside-backup'); mk(path.join(bk2, 'master.db'), 'C'); mk(path.join(bk2, 'docs/ok.md'), 'ok')
  const bad = path.join(bk2, 'docs', 'locked'); fs.mkdirSync(bad); fs.writeFileSync(path.join(bad, 'z.md'), 'z'); fs.chmodSync(bad, 0o000)
  try {
    const r2 = spawnSync('bash', [RESTORE, bk2, st], { encoding: 'utf8' })
    expect(r2.status, r2.stdout + r2.stderr).toBe(1)
    expect(fs.readFileSync(path.join(st, 'master.db'), 'utf8')).toBe('B')
    expect(fs.readdirSync(t).filter(d => d.includes('.restoring-'))).toEqual([])
    expect(fs.readdirSync(t).filter(d => d.startsWith('state.before-restore-'))).toHaveLength(1)
  } finally { fs.chmodSync(bad, 0o755) }
  // ③ 备份里没有 master.db：拒绝，目录不动
  expect(spawnSync('bash', [RESTORE, path.join(t, 'nope'), st], { encoding: 'utf8' }).status).toBe(2)
})

it('G5 B：强杀恢复 / 模型断网 / 备份恢复 / 自检', async () => {
  const base = path.join(E2E_WORK, `g5b-${Date.now()}`)
  const wDir = path.join(base, 'w'); fs.mkdirSync(wDir, { recursive: true })
  const fault = path.join(base, 'fault')
  const sb: Sandbox = await createSandbox({ name: 'g5-robust', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, faultFile: fault, patrol: { intervalMs: 3_600_000, firstBackupMs: 3000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const stateDir = path.join(sb.home, 'dsh-master'); const db = path.join(stateDir, 'master.db')
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const dstate = () => sb.get('/dsh-master-debug/state')
  const history = (sid: string) => sb.get<any[]>(`/dsh-master-debug/history?sessionId=${encodeURIComponent(sid)}`)
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  // 启动后（这里 3 秒，默认 60 秒）插件自己做了当天备份——必须在任何巡检之前查（巡检本身也会备份）
  await sb.waitFor('启动后自动备份', () => fs.existsSync(path.join(stateDir, 'backups')) && fs.readdirSync(path.join(stateDir, 'backups')).some(d => /^\d{8}$/.test(d)) || undefined, 20_000)
  expect(q<any>(db, `SELECT count(*) n FROM events WHERE type = 'patrol/report'`)[0].n).toBe(0)
  const userTexts = (from: number, sid?: string) => sb.mock.requests().slice(from).filter(r => !sid || r.messages.some(m => m.role === 'system' && m.text.includes(sid))).flatMap(r => r.messages.filter(m => m.role === 'user').map(m => m.text))

  // 准备：执行会话 + 轻任务 + 回报 + @任务 归属 + devlog / 记忆 / 手册
  await prompt('master', call('master_spawn', { name: 'w', cwd: wDir, title: '执行 W' }))
  await sb.waitFor('exec-w', async () => (await dstate()).sessions.find((x: any) => x.id === 'exec-w'))
  await prompt('master', call('master_dispatch', { task: 'L1104-1', kind: 'light', title: '稳健性样例', to: 'w', text: '写个样例' }))
  await sb.waitFor('任务', async () => (await dstate()).tasks.find((t: any) => t.id === 'L1104-1'))
  await prompt('exec-w', call('master_report', { task: 'L1104-1', state: '进展', action: '做了一半' }))
  await prompt('exec-w', call('devlog_add', { slug: 'robust-sample', hook: '稳健性样例：写了一个样例文件', tags: ['稳健性', '样例文件', '强杀恢复'], files_touched: [path.join(wDir, 'x.txt')], depth: '实质',
    sections: { 改了什么: '写样例', 为什么: '测试', 坑与教训: '强杀后要能接上' }, lesson: { rule: '强杀后先看投递', why: '可能卡在重试', how: '看 deliveries' } }))
  await prompt('exec-w', call('handbook_add', { section: '坑', line: '强杀后先看投递', source: 'robust-sample' }))
  await quiet()
  await prompt('master', '@L1104-1 进度？')
  await quiet()
  const attribBefore = q<any>(db, 'SELECT session, turn, task, layer FROM turn_attrib ORDER BY session, turn, task')
  expect(attribBefore.some(r => r.task === 'L1104-1' && r.layer === 1 && r.session === 'master')).toBe(true)

  // ① kill -9：先让一条投递卡在重试里，再强杀
  fs.writeFileSync(fault, 'x')
  await prompt('master', call('master_send', { to: 'w', task: 'L1104-1', text: '强杀测试：这条在重启前一直投不出去' }))
  await sb.waitFor('投递在重试', () => q<any>(db, `SELECT * FROM deliveries WHERE state = 'pending' AND attempts > 0 AND text LIKE '%强杀测试%'`)[0])
  const tasksBefore = q<any>(db, 'SELECT id, state, owner, gate FROM tasks ORDER BY id')
  const starts = q<any>(db, `SELECT count(*) n FROM events WHERE type = 'plugin/start'`)[0].n
  const oldPid = sb.pid()
  await sb.stop('SIGKILL')
  expect(fs.existsSync(path.join(stateDir, '.lock'))).toBe(true) // 强杀留下了旧锁
  fs.rmSync(fault)
  await sb.start()
  expect(sb.pid()).not.toBe(oldPid)
  expect(q<any>(db, `SELECT count(*) n FROM events WHERE type = 'plugin/start'`)[0].n).toBe(starts + 1) // 旧锁被接管，插件起来了
  await sb.waitFor('重启后投出去', () => q<any>(db, `SELECT * FROM deliveries WHERE text LIKE '%强杀测试%' AND state = 'delivered'`)[0], 30_000)
  await quiet()
  const got = (await history('exec-w')).filter(e => e.type === 'user/message' && JSON.stringify(e).includes('强杀测试'))
  expect(got).toHaveLength(1) // 不丢不重
  expect(q<any>(db, 'SELECT id, state, owner, gate FROM tasks ORDER BY id')).toEqual(tasksBefore)
  const attribAfter = q<any>(db, 'SELECT session, turn, task, layer FROM turn_attrib ORDER BY session, turn, task')
  for (const r of attribBefore) expect(attribAfter).toContainEqual(r) // 归属一条不少

  // ② 模型接口断网：连接断开 / HTTP 500
  for (const mode of ['refuse', 'error'] as const) {
    const f0 = sb.mock.failures()
    sb.mock.fail(mode)
    await prompt('exec-w', `断网期间（${mode}）收到的消息：读数 42`)
    await prompt('master', call('master_send', { to: 'w', task: 'L1104-1', text: `断网期间（${mode}）想转交的话` }))
    await sb.waitFor(`模型请求失败（${mode}）`, () => sb.mock.failures() > f0 || undefined, 30_000)
    await sleep(4000)
    expect((await dstate()).sessions.length).toBeGreaterThan(0) // 插件没崩
    const patrol = await sb.get<any>('/dsh-master-debug/patrol')
    expect(patrol.findings.filter((x: any) => ['delivery-error'].includes(x.kind ?? x.key?.split(':')[0]))).toEqual([])
    const doc = doctorCli(stateDir)
    expect(doc.out.problems.filter((p: any) => p.kind.startsWith('delivery'))).toEqual([])
    sb.mock.fail(null)
    // 恢复后：执行会话下一轮接得上断网期间的消息；总管重新转交，照常投到
    const n = sb.mock.requests().length
    await prompt('exec-w', '网络恢复了，继续')
    await sb.waitFor(`恢复后接上（${mode}）`, () => userTexts(n).some(t => t.includes(`断网期间（${mode}）收到的消息`)) || undefined, 30_000)
    await quiet()
    // 总管：断网那一轮没跑成的转交，恢复后被叫醒时自动补上（投到执行会话）
    await prompt('master', '网络恢复了')
    await sb.waitFor(`断网期间的转交恢复后补投（${mode}）`, async () => (await history('exec-w')).some(e => e.type === 'user/message' && JSON.stringify(e).includes(`断网期间（${mode}）想转交的话`)) || undefined, 30_000)
    await quiet()
    await prompt('master', call('master_send', { to: 'w', task: 'L1104-1', text: `恢复后（${mode}）转交的话` }))
    await sb.waitFor(`恢复后新的转交照常投到（${mode}）`, async () => (await history('exec-w')).some(e => e.type === 'user/message' && JSON.stringify(e).includes(`恢复后（${mode}）转交的话`)) || undefined, 30_000)
    await quiet()
    const dup = (await history('exec-w')).filter(e => e.type === 'user/message' && JSON.stringify(e).includes(`断网期间（${mode}）想转交的话`))
    expect(dup).toHaveLength(1)
  }

  // ③ 备份恢复
  fs.rmSync(path.join(stateDir, 'backups'), { recursive: true, force: true }) // 删掉之前那份（太早，没有后面的数据），让巡检按当天重做
  await sb.get('/dsh-master-debug/patrol') // 巡检一次 ⇒ 每日备份
  const day = fs.readdirSync(path.join(stateDir, 'backups')).filter(d => /^\d{8}$/.test(d)).sort().at(-1)!
  const bk = path.join(stateDir, 'backups', day)
  expect(fs.existsSync(path.join(bk, 'master.db')) && fs.existsSync(path.join(bk, 'memory.db')) && fs.existsSync(path.join(bk, 'docs'))).toBe(true)
  expect(spawnSync('bash', [RESTORE, bk, stateDir], { encoding: 'utf8' }).status).toBe(3) // 实例在跑：拒绝
  const sb2: Sandbox = await createSandbox({ name: 'g5-restored', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb2.dispose())
  const state2 = path.join(sb2.home, 'dsh-master')
  const r = spawnSync('bash', [RESTORE, bk, state2], { encoding: 'utf8' })
  expect(r.status, r.stdout + r.stderr).toBe(0)
  await sb2.start()
  const same = (sql: string) => expect(q(path.join(state2, 'master.db'), sql)).toEqual(q(path.join(bk, 'master.db'), sql))
  same('SELECT id, state, owner, gate, title FROM tasks ORDER BY id')
  same('SELECT session, turn, task, layer FROM turn_attrib ORDER BY session, turn, task')
  same(`SELECT key, state FROM deliveries ORDER BY key`)
  const sameMem = (sql: string) => expect(q(path.join(state2, 'memory.db'), sql)).toEqual(q(path.join(bk, 'memory.db'), sql))
  sameMem('SELECT slug, file FROM devlog ORDER BY slug'); sameMem('SELECT name, file FROM memories ORDER BY name'); sameMem('SELECT * FROM decisions ORDER BY rowid')
  expect(q<any>(path.join(state2, 'memory.db'), 'SELECT slug FROM devlog').map(x => x.slug)).toContain('robust-sample')
  for (const sub of ['devlog', 'memory', 'handbooks', 'tasks']) expect(filesUnder(state2 + '/docs', sub), sub).toEqual(filesUnder(bk + '/docs', sub))
  expect(fs.readFileSync(path.join(state2, 'docs/handbooks/exec-w.md'), 'utf8')).toContain('强杀后先看投递')
  const doc2 = doctorCli(state2)
  expect(doc2.out.problems.filter((p: any) => p.kind !== 'backup' && p.kind !== 'owner-missing')).toEqual([]) // 恢复出来的实例：只可能缺备份、执行会话没在新 DSH 里重建
  await sb2.dispose()

  // ④ 自检命令：干净时不报；带外改动列出、不修
  const clean = doctorCli(stateDir)
  expect(clean.code, JSON.stringify(clean.out)).toBe(0)
  const hb = path.join(stateDir, 'docs/handbooks/exec-w.md')
  fs.appendFileSync(hb, '\n- 手改的一行（带外改动）\n')
  const dirty = doctorCli(stateDir)
  expect(dirty.code).toBe(1)
  expect(dirty.out.problems).toContainEqual(expect.objectContaining({ kind: 'drift', text: expect.stringContaining('handbooks/exec-w.md') }))
  expect(fs.readFileSync(hb, 'utf8')).toContain('手改的一行') // 不自动修
  expect(spawnSync('node', [DOCTOR, '--state', path.join(base, 'nope')], { encoding: 'utf8' }).status).toBe(2)
}, 400_000)
