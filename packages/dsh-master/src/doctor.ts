/**
 * 自检（G5 B④）：只列问题，不自动修。总管工具 master_doctor 和命令行 lib/doctor.js 共用。
 * 查：库与文件不一致、带外改动、投递卡住 / 出错、归属指向不存在的任务或会话、任务负责会话不在花名册或已关闭、
 *     已结案任务还挂着等你定、任务书文件缺失、太久没有备份。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Store } from './store.ts'
import { TERMINAL_TASK_STATES } from './core.ts'

export interface DoctorProblem { key: string; kind: string; text: string }
export interface DoctorMem {
  check(): { problems: string[]; drift: Array<{ path: string; problem: string }> }
  docs: { abs(rel: string): string }
}
export interface DoctorOptions { now: number; stuckMs?: number; backupDir?: string; backupMaxAgeMs?: number }

export function doctor(store: Store, mem: DoctorMem | undefined, o: DoctorOptions): DoctorProblem[] {
  const out: DoctorProblem[] = []
  const add = (kind: string, id: string, text: string) => out.push({ key: `${kind}:${id}`, kind, text })
  const stuckMs = o.stuckMs ?? 10 * 60_000
  // 记忆层：索引 ↔ 文件、带外改动
  if (mem) {
    const c = mem.check()
    for (const p of c.problems) add('mem', p, `记忆层：${p}`)
    for (const d of c.drift) add('drift', d.path, `带外改动：${d.path}（${d.problem === 'missing' ? '被删了' : '被改了'}）`)
  }
  // 投递
  for (const d of store.deliveriesByState('error')) add('delivery-error', d.key, `投递失败（不再重试）：${d.key} → ${d.to_id}：${d.last_error ?? ''}`)
  for (const d of store.deliveriesByState('pending')) {
    const age = o.now - (Date.parse(d.created_at) || o.now)
    if (age > stuckMs) add('delivery-stuck', d.key, `投递卡住 ${Math.round(age / 60_000)} 分钟：${d.key} → ${d.to_id}（已试 ${d.attempts} 次${d.last_error ? `，最后错误 ${d.last_error}` : ''}）`)
  }
  // 花名册、任务、归属
  const sessions = new Map(store.listSessions().map(s => [s.id, s]))
  const tasks = new Map(store.listTasks().map(t => [t.id, t]))
  for (const t of tasks.values()) {
    if (TERMINAL_TASK_STATES.has(t.state)) continue
    const s = sessions.get(t.owner)
    if (!s) add('owner-missing', t.id, `任务 ${t.id}（${t.state}）的负责会话 ${t.owner} 不在花名册里`)
    else if (s.status === 'closed') add('owner-closed', t.id, `任务 ${t.id}（${t.state}）的负责会话 ${t.owner} 已关闭`)
  }
  const rows = store.db.prepare('SELECT session, turn, task FROM turn_attrib').all() as Array<{ session: string; turn: number; task: string }>
  for (const r of rows) {
    if (!tasks.has(r.task)) add('attrib-task', `${r.session}:${r.turn}:${r.task}`, `归属指向不存在的任务：${r.session} 第 ${r.turn} 轮 → ${r.task}`)
    if (!sessions.has(r.session)) add('attrib-session', `${r.session}:${r.turn}`, `归属记录的会话不在花名册里：${r.session} 第 ${r.turn} 轮`)
  }
  for (const a of store.openAsks()) {
    const t = tasks.get(a.task)
    if (!t) add('ask-task', String(a.id), `等你定 ${a.code ?? `#${a.id}`} 指向不存在的任务 ${a.task}`)
    else if (TERMINAL_TASK_STATES.has(t.state)) add('ask-closed', String(a.id), `任务 ${a.task} 已「${t.state}」，等你定 ${a.code ?? `#${a.id}`} 还开着`)
  }
  // 任务书文件
  if (mem) for (const t of tasks.values()) {
    const v = store.getMeta(`spec:${t.id}`)
    if (!v) continue
    const file = JSON.parse(v).file as string
    if (!fs.existsSync(mem.docs.abs(file))) add('spec-missing', t.id, `任务书文件不见了：${file}`)
  }
  // 备份
  if (o.backupDir) {
    const days = fs.existsSync(o.backupDir) ? fs.readdirSync(o.backupDir).filter(d => /^\d{8}$/.test(d)).sort() : []
    const last = days.at(-1)
    const lastMs = last ? Date.parse(`${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}T00:00:00+08:00`) : NaN
    const maxAge = o.backupMaxAgeMs ?? 3 * 24 * 3600_000
    if (!last) add('backup', 'none', `没有找到每日备份（${o.backupDir}）`)
    else if (o.now - lastMs > maxAge) add('backup', 'old', `最近一次备份是 ${last}，已超过 ${Math.round(maxAge / 86400_000)} 天`)
    else for (const f of ['master.db', 'memory.db']) if (!fs.existsSync(path.join(o.backupDir, last, f))) add('backup', `${last}:${f}`, `备份 ${last} 缺 ${f}`)
  }
  return out
}
