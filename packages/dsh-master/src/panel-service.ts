/**
 * 看板（右侧栏）的服务端：读视图（任务列表 / 任务时间线 / 会话页）、执行动作（回答等你定 / 完成 / 取消 / 确认归属）。
 * G4c 起不再从看板发消息、不收图片、不捕获总管回复（对话一律回原生窗口）。和 DSH 的交互只经 PanelPort。
 */
import path from 'node:path'
import type { Store, TaskRow } from './store.ts'
import { Core, ToolInputError, TERMINAL_TASK_STATES } from './core.ts'
import { filterTasks, viewState, type PanelAction, type PanelView, type ViewMarks } from './panel-api.ts'
import type { Attribution } from './attrib.ts'
import { findPaths } from './paths.ts'
import { bjtIso, bjtStamp, type Clock } from './time.ts'
import type { Doing } from './status-bar.ts'

export interface ContentPart { type: 'text'; text: string }
export interface TurnText { turn: number; seqStart: number; seqEnd: number | null; ended: boolean; parts: Array<{ role: 'user' | 'assistant' | 'relay'; text: string; seq: number }> }
export interface PanelPort {
  /** 以「用户」身份给会话发一条消息（回答等你定时用：那是用户在看板上做的选择）。 */
  promptUser(sessionId: string, requestId: string, content: ContentPart[]): Promise<void>
  /** 从会话记录里读某一轮的全文（只读）。 */
  turnText(sessionId: string, turn: number): Promise<TurnText | undefined>
}

export class PanelError extends Error { constructor(readonly code: string, message: string) { super(message) } }

/** 闸门按开头的 G 编号合并：「G1」与「G1（实现 + 自测）」是同一个；不是 G 开头的原样用。 */
export function gateKey(g: unknown): string | undefined {
  if (typeof g !== 'string' || !g.trim()) return undefined
  return g.trim().match(/^G\d+[a-z]?/i)?.[0].toUpperCase().replace(/^G(\d+)([A-Z]?)$/, (_m, n, x) => `G${n}${x.toLowerCase()}`) ?? g.trim()
}

const HIDDEN_EVENTS = new Set(['message/queued', 'message/delivered', 'message/retry', 'view/changed'])

/** G14 ③c：等你定挂多久算超时（状态栏标红）。 */
export const ASK_OVERDUE_MS = 2 * 3600_000

export class PanelService {
  constructor(private readonly store: Store, private readonly core: Core, private readonly attrib: Attribution, private readonly port: PanelPort, private readonly clock: Clock) {}

  // ---------------- 读 ----------------
  state(q: { view?: string; from?: string; to?: string }) {
    const view: PanelView = q.view === 'archived' ? 'archived' : q.view === 'all' ? 'all' : q.view === 'hidden' ? 'hidden' : 'active'
    const date = (v?: string) => v && /^\d{4}-\d\d-\d\d$/.test(v) ? v : undefined
    const now = this.clock()
    const asks = this.store.openAsks()
    const focus = this.store.focusMap()
    const marks = this.viewMarks(asks)
    const all = this.store.listTasks()
    const tasks = filterTasks(all, view, now, { from: date(q.from), to: date(q.to) }, new Set(asks.map(a => a.task)), new Set(focus.keys()), marks)
    const openAsk = new Set(asks.map(a => a.task)); const focusSet = new Set(focus.keys())
    return {
      now: bjtStamp(now), view,
      tasks: tasks.map(t => ({ ...this.taskCard(t, asks), hidden: viewState(t, now, openAsk, focusSet, marks).hidden, archivedManual: marks.archived.has(t.id) })),
      // G14 ⑨：「已收起（n）」按钮
      hiddenCount: all.filter(t => viewState(t, now, openAsk, focusSet, marks).hidden).length,
      asks: asks.map(a => ({ id: a.id, code: a.code, task: a.task, question: a.question, options: JSON.parse(a.options), at: bjtStamp(Date.parse(a.created_at)) })),
      // 看板里文件链接的白名单根目录之一（另一类是花名册会话的工作目录）
      docsRoot: this.core.mem ? this.core.mem.docs.abs('') : null,
      toUser: this.store.toUserMessages(20).map(m => ({ key: m.key, task: m.task, at: bjtStamp(m.at_ms), text: m.text.slice(0, 120) })),
    }
  }

  /**
   * G11-2 总管状态栏：总管忙闲 + 正在什么（只有工具名 + 说明，见 status-bar.ts）、下次定时保底、
   * 三个待处理计数（等你定 / 等你点 / 受阻）、执行会话块（在岗成员 + 手上没结的任务和闸门）。
   * 「正在」「等你点」「下次保底」由入口给（内存里的记录、宿主定时服务），这里只拼。
   */
  statusBar(x: { doing?: Doing | undefined; waitingCount: number; nextSchedule?: string | null | undefined }) {
    const tasks = this.store.listTasks()
    const open = tasks.filter(t => !TERMINAL_TASK_STATES.has(t.state))
    const asks = this.store.openAsks(); const now = this.clock()
    const at = (iso: string | null | undefined) => { const ms = iso ? Date.parse(iso) : NaN; return Number.isFinite(ms) ? bjtStamp(ms) : null }
    return {
      master: { id: this.core.masterId, live: this.core.port.status(this.core.masterId), doing: x.doing?.label ?? null, doingAt: x.doing ? bjtStamp(x.doing.atMs) : null },
      nextSchedule: at(x.nextSchedule),
      // G14 ⑤：下次到点提醒
      nextReminder: (() => { const r = this.store.reminders('pending')[0]; return r ? { at: bjtStamp(r.at_ms), text: r.text } : null })(),
      counts: { asks: asks.length, waiting: x.waitingCount, blocked: open.filter(t => t.state === '受阻').length,
        // G14 ③c：等你定最早一件挂了多久；超过 2 小时状态栏标红（照 Claude Code 看板 T031 的「超 2 小时没回标红」）
        asksOverdue: asks.filter(q => now - Date.parse(q.created_at) > ASK_OVERDUE_MS).length,
        asksOldestMin: asks.length ? Math.round((now - Math.min(...asks.map(q => Date.parse(q.created_at)))) / 60_000) : null },
      members: this.store.listSessions().filter(s => s.role === 'exec' && s.status === 'active').map(s => ({
        id: s.id, title: s.title, live: this.core.port.status(s.id),
        tasks: open.filter(t => t.owner === s.id).map(t => ({ id: t.id, state: t.state, gate: t.gate })),
      })),
    }
  }

  /**
   * G11-1：关于这件任务，用户该找谁说话。消息直送开着、负责人是在岗成员 ⇒ 成员；
   * 负责人是总管自己、没有这个任务 / 负责人、负责人已关闭、消息直送关了 ⇒ 总管。
   */
  /** G14 ⑨：收起之后又来了新回报 / 新等你定的，不再算收起（自动回到列表）。 */
  private viewMarks(asks: ReturnType<Store['openAsks']>): ViewMarks {
    const hidden = new Set<string>()
    for (const [task, at] of this.store.markMap('hide:')) {
      const since = Date.parse(at)
      const ev = this.store.events({ task }).filter(e => e.type === 'task/report' || e.type === 'task/late-report' || e.type === 'ask/open').at(-1)
      const newer = (ev && Date.parse(ev.at) > since) || asks.some(a => a.task === task && Date.parse(a.created_at) > since)
      if (!newer) hidden.add(task)
    }
    return { hidden, archived: new Set(this.store.markMap('archive:').keys()), restored: new Set(this.store.markMap('restore:').keys()) }
  }

  talkTo(task: string): string {
    const t = this.store.getTask(task); const owner = t?.owner
    // G14 ③a（T005 待评估第 7 项 ①）：任务已结案 ⇒ 交给总管（叫醒）。直送给成员的话成员接着干、回报成了迟到回报，总管不会醒（彩排、T018 各碰到一次）
    if (!this.core.directEnabled || !owner || owner === this.core.masterId || this.core.roleOf(owner) !== 'exec' || TERMINAL_TASK_STATES.has(t!.state)) return this.core.masterId
    return owner
  }

  private taskCard(t: TaskRow, asks: ReturnType<Store['openAsks']>) {
    const last = this.store.events({ task: t.id, limit: 1 })[0]
    const focusAt = this.store.getMeta(`focus:${t.id}`)
    return { id: t.id, kind: t.kind, title: t.title, owner: t.owner, talkTo: this.talkTo(t.id), focus: !!focusAt, focusAt: focusAt ? bjtStamp(Date.parse(focusAt)) : null, state: t.state, gate: t.gate, closed: TERMINAL_TASK_STATES.has(t.state),
      created: bjtStamp(Date.parse(t.created_at)), updated: bjtStamp(Date.parse(t.updated_at)), openAsks: asks.filter(a => a.task === t.id).length,
      last: last ? { type: last.type, at: bjtStamp(Date.parse(last.at)) } : null,
      alias: this.core.aliasOf(t.id), // G14 ⑩
      // G14 ⑦：搜索用的最后一句回报
      lastLine: (() => { const r = this.store.events({ task: t.id, type: 'task/report' }).at(-1); try { return r ? String(JSON.parse(r.data).line ?? '') : null } catch { return null } })() }
  }

  thread(task: string | null) {
    if (task !== null && !this.store.getTask(task)) throw new PanelError('not_found', `没有任务 ${task}`)
    const items: Array<{ kind: string; at: string; atMs: number; [k: string]: unknown }> = []
    // 时间线编号 no：统一用 events 表的 seq（一个命名空间，不和等你定 #N、任务号撞）。
    // 转交消息 → 它的 message/queued 事件；等你定 → 它的 ask/open 事件；对话轮次不编号（有「第 N 轮」）。
    const evs = task !== null ? this.store.events({ task }) : []
    const msgNo = new Map<string, number>(); const askNo = new Map<number, number>()
    for (const e of evs) {
      if (e.type === 'message/queued') { const k = JSON.parse(e.data).key; if (typeof k === 'string' && !msgNo.has(k)) msgNo.set(k, e.seq) }
      if (e.type === 'ask/open') { const id = Number(JSON.parse(e.data).id); if (id && !askNo.has(id)) askNo.set(id, e.seq) }
    }
    for (const m of this.store.messagesFor(task)) items.push({ kind: 'message', no: msgNo.get(m.key) ?? null, at: bjtStamp(m.at_ms), atMs: m.at_ms, from: m.from_id, to: m.to_id, mode: m.mode, text: m.text })
    if (task !== null) {
      for (const e of evs) if (!HIDDEN_EVENTS.has(e.type) && e.type !== 'ask/open') { const t = Date.parse(e.at); items.push({ kind: 'event', no: e.seq, at: bjtStamp(t), atMs: t, type: e.type, session: e.session, data: JSON.parse(e.data) }) }
      for (const a of this.store.asksFor(task)) { const t = Date.parse(a.created_at); items.push({ kind: 'ask', no: askNo.get(a.id) ?? null, at: bjtStamp(t), atMs: t, id: a.id, code: a.code, question: a.question, options: JSON.parse(a.options), state: a.state, answer: a.answer }) }
      for (const x of this.attrib.turnsForTask(task)) items.push({ kind: 'turn', at: x.at, atMs: x.atMs, session: x.session, turn: x.turn, role: x.role, layer: x.layer, why: x.why, excerpt: x.excerpt })
    }
    items.sort((x, y) => x.atMs - y.atMs)
    const t = task ? this.store.getTask(task) : undefined
    if (!t) return { task: null, items }
    const sp = this.core.spec(t.id)
    const cl = this.core.claimOf(t.id); const root = this.core.opts.projectRoot
    const claims = cl && root ? { paths: cl.paths.map(p => path.relative(root, p) || p), active: this.core.activeClaims().some(c => c.task === t.id), reason: cl.reason ?? null } : null
    return { task: { ...this.taskCard(t, this.store.openAsks()), claims, gates: this.gatesOf(t.id, t.gate),
      // G14 审稿 SHOULD 7 ⑤：这件任务挂着的到点提醒
      reminders: this.store.reminders('pending').filter(r => r.task === t.id).map(r => ({ id: r.id, at: bjtStamp(r.at_ms), text: r.text })), specPath: sp && this.core.mem ? this.core.mem.docs.abs(sp.file) : null, output: sp?.output ?? null, products: this.productsOf(t.id, sp?.output) }, items }
  }

  /** 产物：回报里出现过的文件路径（新的在前）+ 任务书写的产物目录。 */
  private productsOf(task: string, output?: string): string[] {
    const seen = new Set<string>()
    for (const e of [...this.store.events({ task })].reverse()) {
      if (e.type !== 'task/report' && e.type !== 'task/late-report') continue
      const d = JSON.parse(e.data)
      for (const p of findPaths(`${d.line ?? ''}\n${d.body ?? ''}`, 20)) seen.add(p)
    }
    const list = [...seen].slice(0, 12)
    if (output && !list.includes(output)) list.push(output)
    return list
  }

  private readonly turnCache = new Map<string, TurnText>()
  /** 时间线展开一轮：按会话 + 轮次从会话记录读全文；结束了的轮次缓存（不会再变），没结束的每次现读。 */
  async turnFull(session: string, turn: number) {
    if (!this.store.getSession(session)) throw new PanelError('not_found', `会话 ${session} 不在花名册里`)
    if (!Number.isInteger(turn) || turn < 1) throw new PanelError('bad_turn', 'turn 必须是正整数')
    const key = `${session}\u0000${turn}`
    const hit = this.turnCache.get(key); if (hit) return hit
    const t = await this.port.turnText(session, turn)
    if (!t) throw new PanelError('not_found', `${session} 的会话记录里没有第 ${turn} 轮`)
    if (t.ended) { this.turnCache.set(key, t); if (this.turnCache.size > 200) this.turnCache.delete(this.turnCache.keys().next().value!) }
    return t
  }

  /** 闸门格子：派活 / 回报 / 验收里出现过的闸门，按出现顺序；通过的绿、打回的红、当前的黄。 */
  private gatesOf(task: string, current: string | null): Array<{ gate: string; state: 'passed' | 'rejected' | 'current' | 'seen' }> {
    // G6-3：任务书定义了闸门 ⇒ 按定义（编号精确匹配、定义的顺序；G6-1 和 G6-2 不再合成 G6），状态全从派活 / 回报 / 验收事件来
    const defs = this.store.gatesFor(task)
    if (defs.length) {
      const st = new Map<string, 'passed' | 'rejected' | 'seen'>()
      for (const e of this.store.events({ task })) {
        const d = JSON.parse(e.data); const g = typeof d.gate === 'string' ? d.gate : undefined
        if (!g || !defs.some(x => x.gate === g)) continue
        if (e.type === 'task/dispatched' || e.type === 'task/report') { if (!st.has(g)) st.set(g, 'seen') }
        if (e.type === 'task/reviewed') st.set(g, d.verdict === '通过' ? 'passed' : 'rejected')
      }
      return defs.map(x => ({ gate: x.gate, state: x.gate === current && st.get(x.gate) !== 'passed' ? 'current' : (st.get(x.gate) ?? 'seen') }))
    }
    const order: string[] = []; const st = new Map<string, 'passed' | 'rejected' | 'seen'>()
    const seen = (g: unknown) => { const k = gateKey(g); if (k && !order.includes(k)) { order.push(k); st.set(k, 'seen') } return k }
    for (const e of this.store.events({ task })) {
      const d = JSON.parse(e.data)
      if (e.type === 'task/dispatched' || e.type === 'task/report') seen(d.gate)
      if (e.type === 'task/reviewed') { const k = seen(d.gate); if (k) st.set(k, d.verdict === '通过' ? 'passed' : 'rejected') }
    }
    const cur = seen(current)
    return order.map(g => ({ gate: g, state: g === cur && st.get(g) !== 'passed' ? 'current' : st.get(g)! }))
  }

  /**
   * G6-3 闸门索引：本项目每个有闸门定义的任务 → { 标题, 闸门: { 标题, 产物定义, 状态, 产物路径 } }。
   * 状态来自事件（gatesOf），产物 = 定义里写的 + 这个闸门的回报里出现的绝对路径（最多 6 个）。不解析任务书文字。
   */
  gateIndex(): Record<string, { title: string; spec: string | null; gates: Record<string, { title: string; produces: string; status: string; outputs: string[] }> }> {
    const out: ReturnType<PanelService['gateIndex']> = {}
    const label: Record<string, string> = { passed: '已验收', rejected: '打回', current: '进行中', seen: '未验收' }
    for (const t of this.store.listTasks()) {
      const defs = this.store.gatesFor(t.id); if (!defs.length) continue
      const states = new Map(this.gatesOf(t.id, t.gate).map(g => [g.gate, g.state]))
      const reportPaths = new Map<string, string[]>()
      for (const e of this.store.events({ task: t.id, type: 'task/report' })) {
        const d = JSON.parse(e.data); if (typeof d.gate !== 'string') continue
        reportPaths.set(d.gate, [...(reportPaths.get(d.gate) ?? []), ...findPaths(`${d.line ?? ''}\n${d.body ?? ''}`, 20)])
      }
      const sp = this.core.spec(t.id)
      out[t.id] = { title: t.title, spec: sp && this.core.mem ? this.core.mem.docs.abs(sp.file) : null, gates: Object.fromEntries(defs.map(g => [g.gate, { title: g.title, produces: g.produces, status: label[states.get(g.gate) ?? 'seen']!,
        outputs: [...new Set([...findPaths(g.produces, 6), ...(reportPaths.get(g.gate) ?? [])])].slice(0, 6) }])) }
    }
    return out
  }
  /** G6-3 Q 索引：本项目所有等你定（编号 → 问题、所属任务、是否已定）。 */
  askIndex(): Record<string, { task: string; question: string; state: string; answer: string | null; at: string }> {
    const rows = this.store.db.prepare('SELECT * FROM asks WHERE code IS NOT NULL ORDER BY id').all() as any[]
    return Object.fromEntries(rows.map(a => [a.code, { task: a.task, question: a.question, state: a.state, answer: a.answer, at: bjtStamp(Date.parse(a.created_at)) }]))
  }
  /** G6-3 未入编：项目里用别的预设建、还没进花名册的会话（session/unenrolled 事件，后来入编了的不算）。 */
  unenrolled(): Array<{ session: string; at: string; preset: string | null }> {
    const seen = new Map<string, { session: string; at: string; preset: string | null }>()
    for (const e of this.store.events({ type: 'session/unenrolled' })) if (e.session && !this.store.getSession(e.session)) seen.set(e.session, { session: e.session, at: bjtStamp(Date.parse(e.at)), preset: JSON.parse(e.data).preset ?? null })
    return [...seen.values()]
  }

  sessionsView() {
    const tasks = this.store.listTasks()
    return this.store.listSessions().map(s => {
      const report = this.store.events({ session: s.id, type: 'task/report', limit: 1 })[0]
      const rd = report ? JSON.parse(report.data) : null
      const closedEv = s.status === 'closed' ? this.store.events({ session: s.id, type: 'session/closed', limit: 1 })[0] : undefined
      const by = closedEv ? JSON.parse(closedEv.data).by : undefined
      return { id: s.id, role: s.role, title: s.title, purpose: this.store.getMeta(`purpose:${s.id}`) ?? null, cwd: s.cwd, status: s.status, live: this.core.port.status(s.id),
        closedBy: closedEv ? (by === 'user' ? '你关的' : by === this.core.masterId ? '总管关的' : `${by ?? '?'} 关的`) : null, closedAt: closedEv ? bjtStamp(Date.parse(closedEv.at)) : null,
        open: tasks.filter(t => t.owner === s.id && !TERMINAL_TASK_STATES.has(t.state)).map(t => ({ id: t.id, state: t.state, title: t.title })),
        lastReport: report ? { at: bjtStamp(Date.parse(report.at)), line: rd.line, state: rd.state ?? null, task: report.task } : null }
    })
  }

  // ---------------- 写 ----------------
  async act(a: PanelAction): Promise<Record<string, unknown>> {
    const now = this.clock()
    switch (a.action) {
      case 'answer': {
        const ask = this.store.getAsk(a.ask)
        if (!ask) throw new PanelError('not_found', `没有 #${a.ask}`)
        if (ask.state !== 'open') throw new PanelError('closed', `#${a.ask} 已经回答过了`)
        this.store.answerAsk(a.ask, a.answer, bjtIso(now))
        const label = ask.code ?? `#${a.ask}`
        // G11-1：负责这件任务的在岗成员直接收答案；总管只留一条 inject（不叫醒，下次醒来看得到）
        const member = this.talkTo(ask.task)
        if (member !== this.core.masterId) {
          this.store.addEvent({ at: bjtIso(now), task: ask.task, type: 'ask/answered', data: { id: a.ask, answer: a.answer, to: member } })
          this.core.markUserOpened(member) // 答案开的这一轮算用户开的：成员接着干、不回报也不叫醒总管
          this.core.systemNotify({ key: `answer:${a.ask}`, to: member, task: ask.task, mode: 'followup', label: '回答等你定',
            text: `用户在看板回答了等你定 ${label}（@${ask.task}）。\n问题：${ask.question}\n回答：${a.answer}\n按这个答案继续；要总管知道的照常用 master_report 回报。` })
          try { this.core.systemNotify({ key: `answer-note:${a.ask}`, to: this.core.masterId, task: ask.task, mode: 'inject', label: '回答等你定',
            text: `用户在看板回答了等你定 ${label}（@${ask.task}）：${a.answer}。已直接转给 ${member}，不用你转。` }) } catch { /* 限频：成员那边已经收到 */ }
          return { ok: true, to: member }
        }
        this.store.addEvent({ at: bjtIso(now), task: ask.task, type: 'ask/answered', data: { id: a.ask, answer: a.answer, to: this.core.masterId } })
        const requestId = `panel-${now}-${Math.random().toString(36).slice(2, 8)}`
        await this.port.promptUser(this.core.masterId, requestId, [{ type: 'text', text: `【来自看板｜回答等你定 ${ask.code ?? `#${a.ask}`}（@${ask.task}）】\n问题：${ask.question}\n回答：${a.answer}` }])
        this.record(requestId, ask.task, `回答 #${a.ask}：${a.answer}`, now)
        return { ok: true, requestId, to: this.core.masterId }
      }
      case 'done': case 'cancel': {
        try { return { ok: true, ...this.core.userCloseTask(a.task, a.action === 'done' ? '完成' : '取消', a.note) } }
        catch (e) { if (e instanceof ToolInputError) throw new PanelError('bad_state', e.message); throw e }
      }
      case 'confirm_tag': {
        try { return { ok: true, ...this.attrib.confirm(a.session, a.turn, a.task) } }
        catch (e) { if (e instanceof ToolInputError) throw new PanelError('bad_state', e.message); throw e }
      }
      case 'focus': {
        if (!this.store.getTask(a.task)) throw new PanelError('not_found', `没有任务 ${a.task}`)
        this.store.setFocus(a.task, a.on ? bjtIso(now) : null)
        return { ok: true, task: a.task, focus: a.on }
      }
      // G14 ⑨：收起 / 归档；返回 undo（反向动作），看板 5 秒内可撤销
      case 'hide': case 'unhide': case 'archive': case 'restore': case 'setmarks': {
        const t = this.store.getTask(a.task)
        if (!t) throw new PanelError('not_found', `没有任务 ${a.task}`)
        const at = bjtIso(now)
        // G14 审稿 SHOULD 3：撤销 = 动作前三个标记的原样快照（原来撤销归档会留下 restore:，任务再也不自动归档）
        const meta = (k: string) => this.store.getMeta(`${k}:${a.task}`) || null
        const before = { hide: meta('hide'), archive: meta('archive'), restore: meta('restore') }
        // G14 复核：设归档标记（archive / setmarks 写回归档）都要过这两条检查，不然撤销框、手工请求能把没结束的、挂着等你定的任务藏进已归档
        const canArchive = () => {
          if (!TERMINAL_TASK_STATES.has(t.state)) throw new PanelError('bad_state', `${a.task} 还没结束（${t.state}），只能归档已结束的任务；不想看到可以先收起`)
          if (this.store.openAsks().some(q => q.task === a.task)) throw new PanelError('bad_state', `${a.task} 还挂着等你定，答了再归档`)
        }
        if (a.action === 'setmarks') {
          if (a.marks.archive && !before.archive) canArchive()
          for (const k of ['hide', 'archive', 'restore'] as const) this.store.setMark(`${k}:`, a.task, a.marks[k])
          this.store.addEvent({ at, task: a.task, type: 'view/changed', data: { action: 'setmarks', marks: a.marks } })
          return { ok: true, task: a.task, action: 'setmarks', undo: { action: 'setmarks', task: a.task, marks: before } }
        }
        if (a.action === 'hide') this.store.setMark('hide:', a.task, at)
        if (a.action === 'unhide') this.store.setMark('hide:', a.task, null)
        if (a.action === 'archive') {
          canArchive()
          this.store.setMark('archive:', a.task, at) // 手动归档不看 restore:，不用清它（撤销时原样留着）
        }
        if (a.action === 'restore') { this.store.setMark('archive:', a.task, null); this.store.setMark('restore:', a.task, at) }
        this.store.addEvent({ at, task: a.task, type: 'view/changed', data: { action: a.action } })
        return { ok: true, task: a.task, action: a.action, undo: { action: 'setmarks', task: a.task, marks: before } }
      }
      case 'alias': {
        try { const r = this.core.setAlias(a.task, a.alias); return { ok: true, task: a.task, alias: r.alias, undo: { action: 'alias', task: a.task, alias: r.old ?? '' } } }
        catch (e) { if (e instanceof ToolInputError) throw new PanelError('bad_input', e.message); throw e }
      }
      // G8：暂停 / 恢复在入口里处理（要删建宿主定时任务），不该走到这里
      case 'pause': case 'resume': throw new PanelError('bad_state', '暂停 / 恢复要经入口处理')
    }
  }

  /** 看板上做的选择记进时间线（发出成功之后）。 */
  private record(requestId: string, task: string | null, text: string, now: number): void {
    this.store.insertMessage({ at: bjtIso(now), at_ms: now, key: `panel:${requestId}`, from_id: 'user', to_id: this.core.masterId, task, mode: 'followup', text })
  }
}
