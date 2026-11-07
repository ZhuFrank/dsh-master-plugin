/**
 * 静默巡检：不调模型。发现 = 一组带稳定 key 的条目；和上次的签名一样就什么都不做（零投递），变了才给总管投一条。
 * 另外每天第一次巡检做备份（两个库 VACUUM INTO + docs 拷贝，保留 14 份）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Store } from './store.ts'
import type { Core } from './core.ts'
import { TERMINAL_TASK_STATES } from './core.ts'
import { bjtIso, bjtStamp, type Clock } from './time.ts'
import type { MemoryLayer } from 'dsh-master-devlog'

export interface Finding { key: string; text: string }
export interface PatrolOptions { stallMs: number; longRunMs: number; backupDir?: string; keepBackups?: number
  /** G5-E：在等用户点（审批 / 选择题）的会话；超过 waitMs（默认 10 分钟）报出来 */
  waiting?: () => Array<{ session: string; kind: 'approval' | 'question'; label: string; since: number }>; waitMs?: number
  /** 已结任务最近几天还有 devlog 才参与关联（默认 7） */
  linkDays?: number }

export class Patrol {
  constructor(private readonly store: Store, private readonly core: Core, private readonly mem: MemoryLayer | undefined, private readonly clock: Clock, private readonly opts: PatrolOptions) {}

  findings(): Finding[] {
    const now = this.clock(); const out: Finding[] = []
    const min = (ms: number) => Math.round(ms / 60_000)
    for (const s of this.store.listSessions().filter(x => x.role === 'exec' && x.status === 'active')) {
      const turn = this.store.getTurn(s.id)
      for (const t of this.core.activeTasks(s.id)) {
        const last = Math.max(turn?.last_report_ms ?? 0, Date.parse(t.updated_at) || 0)
        if (now - last > this.opts.stallMs) out.push({ key: `stalled:${s.id}:${t.id}`, text: `${s.id} 的 ${t.id}[${t.state}] 已经 ${min(now - last)} 分钟没有回报` })
      }
      if (this.core.port.status(s.id) === 'running' && turn?.started_ms && now - turn.started_ms > this.opts.longRunMs)
        out.push({ key: `long-run:${s.id}:${turn.started_ms}`, text: `${s.id} 这一轮已经跑了 ${min(now - turn.started_ms)} 分钟` })
    }
    for (const w of this.opts.waiting?.() ?? []) if (now - w.since > (this.opts.waitMs ?? 10 * 60_000))
      out.push({ key: `waiting:${w.session}:${w.since}`, text: `⏳ ${w.session} 等用户${w.kind === 'approval' ? '批准' : '回答'}已经 ${min(now - w.since)} 分钟：${w.label}（只能去那个会话里点）` })
    for (const d of this.store.deliveriesByState('error')) out.push({ key: `delivery-error:${d.key}`, text: `消息投不出去（已放弃重试）：${d.from_id} → ${d.to_id}，${d.key}：${d.last_error}` })
    const asks = this.store.openAsks()
    if (asks.length) out.push({ key: `asks:${asks.map(a => a.id).join(',')}`, text: `有 ${asks.length} 件等用户定：${asks.map(a => `${a.code ?? `#${a.id}`}（${a.task}）${a.question.slice(0, 40)}`).join('；')}` })
    for (const j of this.store.heavyJobs('queued')) out.push({ key: `heavy-queued:${j.id}`, text: `重活 #${j.id}「${j.label}」（${j.session}）排队中` })
    if (this.mem) {
      // G5-E ⑥ 跨任务关联候选：没结的任务，或最近 7 天还有 devlog 的已结任务；已确认的对不再报
      const tasks = new Map(this.store.listTasks().map(t => [t.id.toUpperCase(), t]))
      const eligible = (id: string) => { const t = tasks.get(id); if (!t) return false; return !TERMINAL_TASK_STATES.has(t.state) || now - this.mem!.lastEntryMs(id) <= (this.opts.linkDays ?? 7) * 86400_000 }
      const sessions = new Set(this.store.listSessions().map(x => x.id.toLowerCase()))
      for (const c of this.mem.linkCandidates({ eligible, linked: this.core.linkedPairs(), sessions }).slice(0, 5)) {
        const why = [...c.shared.map(x => `「${x}」`), ...c.partial.map(([x, y]) => `「${x}」≈「${y}」`)].join('')
        out.push({ key: `link:${c.a}|${c.b}:${c.shared.join(',')}`, text: `跨任务关联候选：${c.a} ↔ ${c.b}（共同标签 ${why}，得分 ${c.score}）。看过确认是同一个主题就用 master_link 连上，否则不用管` })
      }
      const { problems, drift } = this.mem.check()
      for (const p of problems) out.push({ key: `mem:${p}`, text: `记忆层不一致：${p}` })
      for (const d of drift) out.push({ key: `drift:${d.path}:${d.actual ?? 'missing'}`, text: `带外改动：${d.path}（${d.kind}）${d.problem === 'missing' ? '被删了' : '被插件之外的方式改过'}` })
      const since = Number(this.store.getMeta('patrol_drift_seq') ?? '0')
      for (const a of this.mem.docs.absorbedDrift(since)) out.push({ key: `drift-absorbed:${a.seq}`, text: `带外改动（插件写入时发现并已另存）：${a.path}${a.saved ? `，原内容存在 ${a.saved}` : ''}` })
    }
    return out
  }

  /**
   * G7 ⑧：定时保底到点时用——总管还没见过的发现有几项。和上次报给总管的（巡检消息 patrol_sig，或上一次保底 schedule_seen_sig）
   * 完全一样就算 0：3090 上两件没回答的等你定让每 6 小时的保底都叫醒模型（4 次 4 次），每次都是同样的发现。
   * 返回 sig 给调用方：真的叫醒了模型以后用 markScheduleSeen 记下。
   */
  unseenForSchedule(): { count: number; sig: string } {
    const f = this.findings()
    const sig = createHash('sha1').update(f.map(x => x.key).sort().join('\n')).digest('hex')
    if (!f.length || sig === this.store.getMeta('patrol_sig') || sig === this.store.getMeta('schedule_seen_sig')) return { count: 0, sig }
    return { count: f.length, sig }
  }
  markScheduleSeen(sig: string): void { this.store.setMeta('schedule_seen_sig', sig) }

  /** 定时调用：返回 quiet（无变化，零投递）/ reported（投了一条）/ cleared（发现清空了）。 */
  tick(): 'quiet' | 'reported' | 'cleared' {
    this.backup()
    const f = this.findings()
    const sig = createHash('sha1').update(f.map(x => x.key).sort().join('\n')).digest('hex')
    if (sig === this.store.getMeta('patrol_sig')) return 'quiet'
    this.store.setMeta('patrol_sig', sig)
    if (this.mem) this.store.setMeta('patrol_drift_seq', String(this.mem.docs.lastLogSeq()))
    if (!f.length) return 'cleared'
    this.store.addEvent({ at: bjtIso(this.clock()), type: 'patrol/report', data: { sig, keys: f.map(x => x.key) } })
    try {
      this.core.systemNotify({ key: `patrol:${sig.slice(0, 16)}`, to: this.core.masterId, label: '巡检', text: `巡检发现 ${f.length} 项（和上次不同才会发；要看全部用 master_patrol）：\n${f.map(x => `- ${x.text}`).join('\n')}` })
    } catch { /* 限频：签名已记下，下次变化再说 */ }
    return 'reported'
  }

  backup(): string | undefined {
    const dir = this.opts.backupDir
    if (!dir) return undefined
    const day = bjtStamp(this.clock()).slice(0, 10).replace(/-/g, '')
    const target = path.join(dir, day)
    if (fs.existsSync(target)) return undefined
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    this.store.db.exec(`VACUUM INTO '${path.join(target, 'master.db').replace(/'/g, "''")}'`)
    if (this.mem) {
      this.mem.db.db.exec(`VACUUM INTO '${path.join(target, 'memory.db').replace(/'/g, "''")}'`)
      fs.cpSync(this.mem.docs.root, path.join(target, 'docs'), { recursive: true, filter: src => !src.includes(`${path.sep}.git`) })
    }
    const keep = this.opts.keepBackups ?? 14
    const all = fs.readdirSync(dir).filter(d => /^\d{8}$/.test(d)).sort()
    for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old), { recursive: true, force: true })
    this.store.addEvent({ at: bjtIso(this.clock()), type: 'backup', data: { target } })
    return target
  }
}
