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
import { FREE_HOW } from './heavy.ts'

export interface Finding { key: string; text: string }
/** G11-1 直接对话：只看最近 24 小时；30 分钟没回才报；对外动作 / 叫停 / 改方向的关键词。 */
export const DIRECT_WINDOW_MS = 24 * 3600_000
export const DIRECT_NOREPLY_MS = 30 * 60_000
export const DIRECT_KEYWORDS = /发布|推送|push|上线|发出去|提交|commit|删除|删掉|删了|叫停|停下|停一下|先别|别做|不做了|不要做|改方向|换个方向|撤回|回滚/i
export interface PatrolOptions { stallMs: number; longRunMs: number; backupDir?: string; keepBackups?: number
  /** G5-E：在等用户点（审批 / 选择题）的会话；超过 waitMs（默认 10 分钟）报出来 */
  waiting?: () => Array<{ session: string; kind: 'approval' | 'question'; label: string; since: number }>; waitMs?: number
  /** 已结任务最近几天还有 devlog 才参与关联（默认 7） */
  linkDays?: number
  /** G14 ①：全局重活队列（在旧单元库里，项目巡检读不到自己的库）+ 当前可用内存；排队超过 heavyStuckMs（默认 15 分钟）且门槛高于可用 ⇒ 报 */
  heavy?: () => { jobs: Array<{ id: number; session: string; label: string; min_free_gb: number; state: string; created_at: string }>; free: number }
  heavyStuckMs?: number }

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
    if (this.core.directEnabled) out.push(...this.directFindings(now))
    for (const d of this.store.deliveriesByState('error')) out.push({ key: `delivery-error:${d.key}`, text: `消息投不出去（已放弃重试）：${d.from_id} → ${d.to_id}，${d.key}：${d.last_error}` })
    // G14 审稿 MUST 2：一件一条 key。0.2.0 把所有编号拼成一个 key（asks:3,4），答掉一件 key 就变了，被当成新增照样叫醒总管
    for (const a of this.store.openAsks()) out.push({ key: `ask:${a.id}`, text: `等用户定：${a.code ?? `#${a.id}`}（${a.task}）${a.question.slice(0, 40)}` })
    // G14 ③b（T005 待评估第 7 项 ③）：结案任务上来的迟到回报只 inject、不叫醒总管 ⇒ 总管上一轮开始之后来的、7 天内的，报出来（总管跑过一轮就消失）
    const masterTurn = this.store.getTurn(this.core.masterId)?.started_ms ?? 0
    for (const e of this.store.events({ type: 'task/late-report' })) {
      const ms = Date.parse(e.at)
      if (!(ms > masterTurn) || now - ms > 7 * 86400_000) continue
      let d: { line?: string; taskState?: string } = {}; try { d = JSON.parse(e.data) } catch { /* 坏数据照报 */ }
      out.push({ key: `late-report:${e.seq}`, text: `已结案的 ${e.task}（${d.taskState ?? '已结'}）上来了一条迟到回报（${e.session ?? '?'}，${min(now - ms)} 分钟前），你还没看：${d.line ?? ''}。看要不要重开、另派，还是记一笔就行` })
    }
    // G14 ①：0.2.0 读的是自己这个库的 heavy_jobs，项目单元里永远是空的（队列在全局库）⇒ 改成读注入的全局队列，只看本项目花名册里的会话
    const hv = this.opts.heavy?.()
    if (hv) {
      const queued = hv.jobs.filter(j => j.state === 'queued')
      for (const j of queued) {
        if (!this.store.getSession(j.session)) continue
        const waited = now - Date.parse(j.created_at)
        // G14 审稿 SHOULD 5：报过一次的，只要还在排队就一直留着（内存在门槛上下抖时不反复出现 / 消失、反复叫醒总管）
        const stuck = waited > (this.opts.heavyStuckMs ?? 15 * 60_000) && j.min_free_gb > hv.free
        if (!stuck && !(`heavy-stuck:${j.id}` in this.reportedKeys())) continue
        const behind = queued.filter(x => x.id > j.id).length
        out.push({ key: `heavy-stuck:${j.id}`, text: `重活 #${j.id}「${j.label}」（${j.session}）已排队 ${min(waited)} 分钟：门槛 ${j.min_free_gb} GB，现在可用 ${hv.free.toFixed(1)} GB（${FREE_HOW}），${stuck ? '够不着就一直排着' : '现在已经够了，下一次心跳会开跑（之前卡过，报过一次）'}${behind ? `，后面还排着 ${behind} 件` : ''}。门槛设高了就让成员 heavy_cancel 后用低一点的重提，或者你用 heavy_cancel 取消` })
      }
    }
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
   * G11-1「直接对话」：用户直接在成员会话里说的话，只在要紧时报给总管（平常的追问不报，省一次叫醒）：
   * 成员回答里写了「改了结论」；用户原话里有对外动作 / 叫停 / 改方向的词；说了 30 分钟这个会话一轮都没结束、现在又没在跑；会话已关闭。
   * 只看最近 24 小时；key 带消息 ID，跟别的发现一样按签名只报一次。
   */
  private directFindings(now: number): Finding[] {
    const out: Finding[] = []
    const changed = new Set(this.store.events({ type: 'user/direct-changed' }).map(e => `${e.session}:${JSON.parse(e.data).msg}`))
    for (const e of this.store.events({ type: 'user/direct' })) {
      const d = JSON.parse(e.data) as { msg: string; ms: number; text: string }
      const s = e.session ?? ''
      if (now - d.ms > DIRECT_WINDOW_MS) continue
      const quote = d.text.length > 60 ? `${d.text.slice(0, 60)}…` : d.text
      const row = this.store.getSession(s)
      if (!row || row.status !== 'active') { out.push({ key: `direct-closed:${s}:${d.msg}`, text: `用户在 ${s} 里说了话，但这个会话已关闭，已不归总管管：「${quote}」` }); continue }
      if (changed.has(`${s}:${d.msg}`)) out.push({ key: `direct-changed:${s}:${d.msg}`, text: `用户直接问了 ${s}，它的回答改了已交付的结论（用户问：「${quote}」）；看它最后一轮的回答` })
      if (DIRECT_KEYWORDS.test(d.text)) out.push({ key: `direct-keyword:${s}:${d.msg}`, text: `用户直接对 ${s} 说了可能涉及对外动作 / 叫停 / 改方向的话：「${quote}」` })
      const end = Number(this.store.getMeta(`turnend:${s}`) ?? 0)
      if (now - d.ms > DIRECT_NOREPLY_MS && end < d.ms && this.core.port.status(s) !== 'running')
        out.push({ key: `direct-noreply:${s}:${d.msg}`, text: `用户在 ${s} 里说了话 ${Math.round((now - d.ms) / 60_000)} 分钟，它还没回（没在跑）：「${quote}」` })
    }
    return out
  }

  /**
   * G7 ⑧：定时保底到点时用——总管还没见过的发现有几项。和上次报给总管的（巡检消息 patrol_sig，或上一次保底 schedule_seen_sig）
   * 完全一样就算 0：3090 上两件没回答的等你定让每 6 小时的保底都叫醒模型（4 次 4 次），每次都是同样的发现。
   * 返回 sig 给调用方：真的叫醒了模型以后用 markScheduleSeen 记下。
   */
  unseenForSchedule(): { count: number; sig: string; keys: string[] } {
    const f = this.findings()
    const keys = f.map(x => x.key)
    const sig = createHash('sha1').update([...keys].sort().join('\n')).digest('hex')
    if (!f.length || sig === this.store.getMeta('patrol_sig') || sig === this.store.getMeta('schedule_seen_sig')) return { count: 0, sig, keys }
    // G14 ②：只有项消失（剩下的都报过 / 保底见过）不算新发现
    const seen = new Set([...Object.keys(this.reportedKeys()), ...this.metaJson<string[]>('schedule_seen_keys', [])])
    this.lastUnseen = { sig, keys }
    return { count: keys.filter(k => !seen.has(k)).length, sig, keys }
  }
  private lastUnseen: { sig: string; keys: string[] } | undefined
  /** 记下保底已经叫醒模型看过的发现；keys 不传就用上一次 unseenForSchedule 算出来的（同一个签名时）。 */
  markScheduleSeen(sig: string, keys?: string[]): void {
    this.store.setMeta('schedule_seen_sig', sig)
    const k = keys ?? (this.lastUnseen?.sig === sig ? this.lastUnseen.keys : undefined)
    if (k) this.store.setMeta('schedule_seen_keys', JSON.stringify(k))
  }

  private metaJson<T>(key: string, dflt: T): T { try { const v = this.store.getMeta(key); return v ? JSON.parse(v) as T : dflt } catch { return dflt } }
  /** G14 ②：上次报给总管（或只消失时记下）的发现 key → 文字（报文里列「已消失」要用文字）。0.2.0 升上来没有这一项 ⇒ 空。 */
  private reportedKeys(): Record<string, string> { return this.metaJson<Record<string, string>>('patrol_keys', {}) }

  /** 定时调用：返回 quiet（无变化，零投递）/ reported（投了一条）/ cleared（发现清空了）。 */
  tick(): 'quiet' | 'reported' | 'cleared' {
    this.backup()
    const f = this.findings()
    const sig = createHash('sha1').update(f.map(x => x.key).sort().join('\n')).digest('hex')
    if (sig === this.store.getMeta('patrol_sig')) return 'quiet'
    const old = this.reportedKeys()
    this.store.setMeta('patrol_sig', sig)
    this.store.setMeta('patrol_keys', JSON.stringify(Object.fromEntries(f.map(x => [x.key, x.text.slice(0, 120)]))))
    if (this.mem) this.store.setMeta('patrol_drift_seq', String(this.mem.docs.lastLogSeq()))
    if (!f.length) return 'cleared'
    // G14 ②（照 Claude Code 看板 gone_only）：剩下的都报过、只是有项消失了（等你定答完、投递错误清掉……）⇒ 不叫醒总管
    const added = f.filter(x => !(x.key in old))
    const gone = Object.entries(old).filter(([k]) => !f.some(x => x.key === k)).map(([, t]) => t)
    if (!added.length) {
      this.store.addEvent({ at: bjtIso(this.clock()), type: 'patrol/gone-only', data: { sig, gone: gone.length } })
      return 'quiet'
    }
    const kept = f.filter(x => x.key in old)
    this.store.addEvent({ at: bjtIso(this.clock()), type: 'patrol/report', data: { sig, keys: f.map(x => x.key) } })
    const text = [`巡检发现 ${f.length} 项（和上次不同才会发；要看全部用 master_patrol）：`,
      `新增 ${added.length} 项：`, ...added.map(x => `- ${x.text}`),
      ...(gone.length ? [`已消失、不用处理：${gone.join('；')}`] : []),
      ...(kept.length ? [`之前报过、还在 ${kept.length} 项：`, ...kept.map(x => `- ${x.text}`)] : [])].join('\n')
    try {
      this.core.systemNotify({ key: `patrol:${sig.slice(0, 16)}`, to: this.core.masterId, label: '巡检', text })
      this.core.noteWake('patrol', added.map(x => x.key)) // G14 ⑧
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
