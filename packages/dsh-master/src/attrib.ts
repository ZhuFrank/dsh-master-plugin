/**
 * G4c：把原生对话的每一轮归到任务（四层 + 兜底），并在 pre-step 处理 @任务 / @执行会话。
 * 归属按「会话 + 轮次」入库（轮次号就是宿主的 turn，和对话里每轮末尾插槽拿到的 turn 一致）。
 */
import type { Store } from './store.ts'
import { Core, ToolInputError, TERMINAL_TASK_STATES } from './core.ts'
import { LAYER, LAYER_LABEL, NOTICE_HEAD, PEER_REMINDER, decideTurn, relayTask, rewriteTaskLinks, scanUserText, taskBrief, type AttribRow } from './mentions.ts'
import { bjtIso, bjtStamp, type Clock } from './time.ts'

const textOf = (m: any) => (m?.content ?? []).map((c: any) => c?.text ?? '').join('')
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) } return o }
const SESSION_LINK = /@\[([^\]\n]*)\]\(dsh-session:[A-Za-z0-9_-]+\)/g
const RECENT_MS = 7 * 24 * 3600_000

export interface StepResult { messages: any[]; changed: boolean }

export class Attribution {
  /** 每个会话当前在第几轮（pre-step 时记下；工具调用归属用它）。 */
  private readonly turnOf = new Map<string, number>()
  private seq = 0
  constructor(private readonly store: Store, private readonly core: Core, private readonly clock: Clock) {}

  private exists = (id: string) => !!this.store.getTask(id)
  private record(session: string, turn: number, task: string, layer: number, reason: string): void {
    const now = this.clock()
    this.store.addAttrib({ session, turn, task, layer, reason, at: bjtIso(now), at_ms: now })
  }
  private openTasksOf(session: string) { return this.store.listTasks().filter(t => t.owner === session && !TERMINAL_TASK_STATES.has(t.state)) }
  private reportsOf(task: string) {
    return this.store.events({ task, type: 'task/report' }).slice(-3).map(e => ({ at: bjtStamp(Date.parse(e.at)), line: String(JSON.parse(e.data).line ?? '') }))
  }
  briefOfTask(id: string): string | undefined {
    const t = this.store.getTask(id); if (!t) return undefined
    return taskBrief(t, this.reportsOf(id), this.store.openAsks().filter(a => a.task === id))
  }
  briefOfSession(id: string): string {
    const s = this.store.getSession(id)
    const open = this.openTasksOf(id)
    const indent = (b: string) => b.split('\n').map(l => `  ${l}`).join('\n')
    const lines = [`- ${id}${s ? `（${s.title}）` : ''}：在途任务 ${open.length ? open.map(t => t.id).join('、') : '无'}`, ...open.slice(0, 3).map(t => indent(this.briefOfTask(t.id)!))]
    if (!open.length) {
      // 没有在途任务：附最近一个已结束任务的摘要（宿主快照里看不到回报）
      const last = this.store.listTasks().filter(t => t.owner === id).sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))[0]
      if (last) lines.push(`  最近一个已结束的任务：`, indent(this.briefOfTask(last.id)!))
    }
    return lines.join('\n')
  }

  /** pre-step：识别这一步里的 @任务 / @会话 / 插件转来的消息，记归属，按需在这一步末尾附一条说明。 */
  processStep(agentId: string, turn: number, messages: any[]): StepResult {
    const role = this.core.roleOf(agentId)
    if (!role || !Number.isInteger(turn) || turn < 1) return { messages, changed: false }
    this.turnOf.set(agentId, turn)
    const now = this.clock()
    const atTasks = new Set<string>(); const textTasks = new Set<string>(); const sessions = new Set<string>()
    let excerpt: string | undefined; let changed = false
    const out = messages.map(m => {
      const kind = m?.source?.kind
      if (kind === 'user') {
        const text = textOf(m)
        const sc = scanUserText(text, this.exists)
        sc.atTasks.forEach(x => atTasks.add(x)); sc.textTasks.forEach(x => textTasks.add(x)); sc.sessions.forEach(x => sessions.add(x))
        excerpt ??= rewriteTaskLinks(text).replace(SESSION_LINK, (_s, label) => `@${label}`).replace(/\s+/g, ' ').trim().slice(0, 160)
        if (!/dsh-master-task:/.test(text)) return m
        changed = true
        return deepFreeze(structuredClone({ ...m, content: (m.content ?? []).map((c: any) => c?.type === 'text' ? { ...c, text: rewriteTaskLinks(c.text) } : c) }))
      }
      if (kind === 'dsh-master' && m?.source?.form === 'relay') {
        const text = textOf(m); const task = relayTask(text)
        if (task && this.exists(task)) this.record(agentId, turn, task, LAYER.TOOL, '插件转来的消息带任务号')
        excerpt ??= text.replace(/^\[dsh-master 消息[^\n]*\n?/, '').replace(/\s+/g, ' ').trim().slice(0, 160)
      }
      return m
    })
    if (excerpt) this.store.setTurnText({ session: agentId, turn, at: bjtIso(now), at_ms: now, excerpt })
    for (const t of atTasks) this.record(agentId, turn, t, LAYER.AT_TASK, '@任务')
    for (const t of textTasks) this.record(agentId, turn, t, LAYER.TEXT, '正文提到')
    const blocks: string[] = []
    if (atTasks.size) blocks.push('用户点名的任务（库里的当前状态）：', ...[...atTasks].slice(0, 5).map(t => this.briefOfTask(t)!))
    const roster = new Set(this.store.listSessions().filter(s => s.role === 'exec').map(s => s.id))
    const execs = [...sessions].filter(s => roster.has(s) && s !== agentId)
    if (execs.length && role === 'master') {
      blocks.push('用户点名了执行会话（宿主附的快照里看不到回报和插件转过去的消息，以下是库里的状态）：', ...execs.map(s => this.briefOfSession(s)))
      for (const s of execs) {
        const open = this.openTasksOf(s)
        if (open.length === 1) this.record(agentId, turn, open[0]!.id, LAYER.AT_EXEC, `@${s}（只有这一个在途任务）`)
      }
      this.store.addEvent({ at: bjtIso(now), session: agentId, type: 'mention/exec', data: { turn, sessions: execs } })
    }
    if (execs.length && role === 'exec') {
      blocks.push(PEER_REMINDER, ...execs.map(s => this.briefOfSession(s)))
      this.store.addEvent({ at: bjtIso(now), session: agentId, type: 'mention/exec-peer', data: { turn, sessions: execs } })
    }
    if (atTasks.size) this.store.addEvent({ at: bjtIso(now), session: agentId, type: 'mention/task', data: { turn, tasks: [...atTasks] } })
    if (!blocks.length) return { messages: changed ? out : messages, changed }
    const note = deepFreeze(structuredClone({ id: `dsh-master:mention:${agentId}:${now}:${++this.seq}`, role: 'user',
      content: [{ type: 'text', text: `${NOTICE_HEAD}\n${blocks.join('\n')}` }], source: { kind: 'dsh-master', form: 'notice', summary: '附上的信息' } }))
    return { messages: [...out, note], changed: true }
  }

  /** 工具调用带了存在的任务号 ⇒ 第 2 层。 */
  onTool(caller: string, tool: string, args: unknown): void {
    const task = (args as any)?.task
    const turn = this.turnOf.get(caller)
    if (typeof task === 'string' && turn && this.exists(task)) this.record(caller, turn, task, LAYER.TOOL, `工具 ${tool}`)
  }

  /** master_tag：总管兜底标注（只给总管用）。 */
  tag(caller: string, a: { turn?: unknown; task?: unknown; session?: unknown }) {
    if (caller !== this.core.masterId) throw new ToolInputError('只有总管能用 master_tag')
    const session = typeof a.session === 'string' && a.session ? a.session : this.core.masterId
    if (!this.store.getSession(session)) throw new ToolInputError(`会话 ${session} 不在花名册里`)
    const turn = Number(a.turn)
    if (!Number.isInteger(turn) || turn < 1) throw new ToolInputError('turn 必须是正整数（第几轮）')
    if (typeof a.task !== 'string' || !this.exists(a.task)) throw new ToolInputError(`没有任务 ${String(a.task)}`)
    this.record(session, turn, a.task, LAYER.TAG, '总管标注')
    return { session, turn, task: a.task }
  }

  /** 看板上一键确认（把「可能相关」或任意一轮定为某任务）。 */
  confirm(session: string, turn: number, task: string) {
    if (!this.store.getSession(session)) throw new ToolInputError(`会话 ${session} 不在花名册里`)
    if (!this.exists(task)) throw new ToolInputError(`没有任务 ${task}`)
    if (!this.store.attribsFor(session).some(r => r.turn === turn) && !this.store.turnText(session, turn)) throw new ToolInputError(`${session} 没有第 ${turn} 轮的记录`)
    this.record(session, turn, task, LAYER.USER, '你确认的')
    return { session, turn, task }
  }

  /** 每轮末尾小标签用：这个会话每一轮的主任务 / 也提到 / 可能相关。 */
  turnsOf(session: string) {
    const by = new Map<number, AttribRow[]>()
    for (const r of this.store.attribsFor(session)) by.set(r.turn, [...(by.get(r.turn) ?? []), r])
    return [...by].map(([turn, rows]) => { const d = decideTurn(rows); return { turn, primary: d.primary ? { task: d.primary.task, layer: d.primary.layer, why: LAYER_LABEL[d.primary.layer] } : null, also: d.also.map(x => x.task), maybe: d.maybe.map(x => x.task) } })
  }

  /** 任务时间线里的「对话轮次」条目。 */
  turnsForTask(task: string) {
    const by = new Map<string, AttribRow[] & { at_ms?: number }>()
    const meta = new Map<string, number>()
    for (const r of this.store.attribsTouching(task)) { const k = `${r.session}\u0000${r.turn}`; by.set(k, [...(by.get(k) ?? []), r] as any); meta.set(k, Math.min(meta.get(k) ?? Infinity, r.at_ms)) }
    const items: Array<{ session: string; turn: number; atMs: number; at: string; role: 'primary' | 'also' | 'maybe'; layer: number; why: string; excerpt: string }> = []
    for (const [k, rows] of by) {
      const [session, turnS] = k.split('\u0000'); const turn = Number(turnS)
      const d = decideTurn(rows)
      const role = d.primary?.task === task ? 'primary' : d.also.some(x => x.task === task) ? 'also' : 'maybe'
      const mine = rows.filter(r => r.task === task).sort((a, b) => a.layer - b.layer)[0]!
      const atMs = meta.get(k)!
      items.push({ session: session!, turn, atMs, at: bjtStamp(atMs), role, layer: mine.layer, why: LAYER_LABEL[mine.layer]!, excerpt: this.store.turnText(session!, turn)?.excerpt ?? '' })
    }
    return items.sort((a, b) => a.atMs - b.atMs)
  }

  /** @ 菜单的候选：总管会话列全部未结 + 结束 7 天内；执行会话只列派给它的；不在花名册的会话不列。 */
  candidatesFor(session: string) {
    const role = this.core.roleOf(session)
    if (!role) return []
    const now = this.clock()
    return this.store.listTasks()
      .filter(t => role === 'master' || t.owner === session)
      .filter(t => !TERMINAL_TASK_STATES.has(t.state) || now - (Date.parse(t.updated_at) || 0) <= RECENT_MS)
      .map(t => ({ id: t.id, title: t.title, state: t.state, owner: t.owner }))
  }
}
