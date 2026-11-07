import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { doctor } from '../src/doctor.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

async function setup() {
  const dir = tmpdir('doctor'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 1000, mem, doctor: () => ({ problems: doctor(store, mem, { now: clock() }) }) })
  await core.ensureMaster(tmpdir('m'))
  await core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
  await core.dispatch({ task: 'L1103-1', kind: 'light', title: 't', to: 'a', text: '做' }, MASTER_ID)
  return { dir, clock, store, mem, core }
}
const kinds = (ps: Array<{ kind: string }>) => [...new Set(ps.map(p => p.kind))].sort()

describe('自检 doctor：只列问题，不修', () => {
  it('干净的状态：没有问题（只开了投递、没备份目录时不报备份）', async () => {
    const s = await setup()
    expect(doctor(s.store, s.mem, { now: s.clock() })).toEqual([])
  })
  it('各类问题都能查出来', async () => {
    const s = await setup()
    const at = new Date(s.clock()).toISOString()
    // 投递卡住 / 出错
    s.store.db.prepare(`INSERT INTO deliveries(key, to_id, from_id, mode, text, summary, state, attempts, next_at_ms, last_error, created_at, updated_at) VALUES('k-stuck','exec-a','master','followup','x','x','pending',3,0,'connect ECONNREFUSED',?,?)`).run(new Date(s.clock() - 3600_000).toISOString(), at)
    s.store.db.prepare(`INSERT INTO deliveries(key, to_id, from_id, mode, text, summary, state, attempts, next_at_ms, last_error, created_at, updated_at) VALUES('k-err','exec-a','master','followup','x','x','error',8,0,'gone',?,?)`).run(at, at)
    // 归属指向不存在的任务 / 会话
    s.store.addAttrib({ session: MASTER_ID, turn: 3, task: 'L9999-9', layer: 1, reason: 'x', at, at_ms: s.clock() })
    s.store.addAttrib({ session: 'exec-ghost', turn: 1, task: 'L1103-1', layer: 2, reason: 'x', at, at_ms: s.clock() })
    // 负责会话关闭但任务还开着；结案任务还挂着等你定
    await s.core.dispatch({ task: 'L1103-2', kind: 'light', title: 't2', to: 'a', text: '做' }, MASTER_ID)
    const { id, code } = await s.core.askUser({ task: 'L1103-2', question: '要吗？' })
    expect(code).toMatch(/^Q\d{4}-1$/); void id
    s.core.userCloseTask('L1103-2', '完成')
    s.store.db.prepare(`UPDATE sessions SET status = 'closed' WHERE id = 'exec-a'`).run()
    // 带外改动 + 记忆层不一致 + 任务书缺失
    s.core.renderBoard(); fs.appendFileSync(path.join(s.dir, 'docs', 'board.md'), '\n手改一行')
    fs.mkdirSync(path.join(s.dir, 'docs', 'devlog'), { recursive: true }); fs.writeFileSync(path.join(s.dir, 'docs', 'devlog', '2026-11-03-0700-stray.md'), 'x')
    s.store.setMeta('spec:T777', JSON.stringify({ file: 'tasks/T777.md', title: 'x', expected: '1h', output: '/o', resume: 'r' }))
    s.store.db.prepare(`INSERT INTO tasks(id, kind, title, owner, state, gate, meta, created_at, updated_at) VALUES('T777','heavy','x','exec-a','完成',NULL,'{}',?,?)`).run(at, at)
    const before = fs.readFileSync(path.join(s.dir, 'master.db')).length
    const ps = doctor(s.store, s.mem, { now: s.clock(), backupDir: path.join(s.dir, 'backups') })
    expect(kinds(ps)).toEqual(['ask-closed', 'attrib-session', 'attrib-task', 'backup', 'delivery-error', 'delivery-stuck', 'drift', 'mem', 'owner-closed', 'spec-missing'].sort())
    expect(ps.find(p => p.kind === 'ask-closed')!.text).toContain(code)
    expect(ps.find(p => p.kind === 'delivery-stuck')!.text).toContain('ECONNREFUSED')
    // 不自动修：再跑一遍问题还在，库没被改动（投递仍 pending）
    expect(doctor(s.store, s.mem, { now: s.clock(), backupDir: path.join(s.dir, 'backups') }).length).toBe(ps.length)
    expect(s.store.deliveriesByState('pending').some(d => d.key === 'k-stuck')).toBe(true)
    expect(fs.readFileSync(path.join(s.dir, 'master.db')).length).toBe(before)
  })
  it('master_doctor 只给总管', async () => {
    const s = await setup()
    expect(s.core.toolsFor(MASTER_ID).some(t => t.name === 'master_doctor')).toBe(true)
    expect(s.core.toolsFor('exec-a').some(t => t.name === 'master_doctor')).toBe(false)
    expect(await s.core.toolsFor(MASTER_ID).find(t => t.name === 'master_doctor')!.run({}, MASTER_ID)).toEqual({ problems: [] })
  })
})
