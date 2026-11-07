/**
 * G5-E ⑤ 等你点提醒：记下哪个会话在等审批 / 等用户回答选择题（宿主的 approval/request、user-questions/request）。
 * 只记录、只提醒：插件不替用户做任何决定，也不在侧栏放「允许」按钮（那等于把权限闸门搬到网页上）。
 */
export type WaitKind = 'approval' | 'question'
/** ref：宿主的标识（审批 id 或工具 callId），补扫和实时事件靠它对上；backfilled：插件启动时从会话记录补进来的。 */
export interface Waiting { key: string; session: string; kind: WaitKind; label: string; since: number; ref?: string; callId?: string; backfilled?: boolean }

export class WaitingTracker {
  private readonly map = new Map<string, Waiting>()
  private seq = 0
  constructor(private readonly clock: () => number) {}
  start(session: string | undefined, kind: WaitKind, label: string | undefined, extra: { since?: number; ref?: string; callId?: string; backfilled?: boolean } = {}): string {
    const sid = session ?? '?'
    if (extra.ref) { const dup = [...this.map.values()].find(w => w.session === sid && w.ref === extra.ref); if (dup) return dup.key }
    const key = `${kind}:${sid}:${++this.seq}`
    this.map.set(key, { key, session: sid, kind, label: (label ?? '').replace(/\s+/g, ' ').slice(0, 80), since: extra.since ?? this.clock(), ...(extra.ref ? { ref: extra.ref } : {}), ...(extra.callId ? { callId: extra.callId } : {}), ...(extra.backfilled ? { backfilled: true } : {}) })
    return key
  }
  end(key: string): void { this.map.delete(key) }
  /** 宿主记下「已决定 / 已有结果」：按审批 id 或 callId 删掉对应的（补扫进来的那些靠这个消失）。 */
  settle(session: string, ref: string): void {
    for (const w of [...this.map.values()]) if (w.session === session && (w.ref === ref || w.callId === ref)) this.map.delete(w.key)
  }
  list(): Waiting[] { return [...this.map.values()].sort((a, b) => a.since - b.since) }
}

/** 包住宿主的 waterfall：进来记一条，照常交给后面的应答者（next），结束（不管结果如何）就删掉。结果原样返回。 */
export function track<T>(t: WaitingTracker, session: string | undefined, kind: WaitKind, label: string | undefined, next: () => Promise<T>, extra: { ref?: string; callId?: string } = {}): Promise<T> {
  const k = t.start(session, kind, label, extra)
  return next().finally(() => t.end(k))
}

export interface PendingInRecord { kind: WaitKind; ref: string; callId?: string; label: string; since: number }
/**
 * G5-F ② 补扫：按会话记录的先后顺序，找「问了还没结果」的审批 / 选择题。
 * 审批：approval/asked 之后没有同 id 的 approval/decided、也没有同 callId 的 tool/result；
 * 选择题：ask_user_question 的 tool/call 之后没有同 callId 的 tool/result（宿主停机时会写 cancelled / ASK_ABORTED，这些就不算）。
 * 一轮结束（turn/end）时这一轮里挂着的全部作废。
 */
export function pendingFromRecord(events: Array<{ type: string; time?: unknown; data?: any }>): PendingInRecord[] {
  const open = new Map<string, PendingInRecord>()
  const at = (e: { time?: unknown }) => typeof e.time === 'number' ? e.time : Date.parse(String(e.time ?? '')) || 0
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'approval/asked' && d.id) open.set(`a:${d.id}`, { kind: 'approval', ref: String(d.id), ...(d.callId ? { callId: String(d.callId) } : {}), label: String(d.toolName ?? ''), since: at(e) })
    else if (e.type === 'approval/decided' && d.id) open.delete(`a:${d.id}`)
    else if (e.type === 'tool/call' && d.name === 'ask_user_question' && d.callId) {
      let q = ''; try { q = String(JSON.parse(d.arguments ?? '{}')?.questions?.[0]?.question ?? '') } catch { /* 参数坏了就不写标签 */ }
      open.set(`q:${d.callId}`, { kind: 'question', ref: String(d.callId), callId: String(d.callId), label: q, since: at(e) })
    } else if (e.type === 'tool/result') {
      const cid = d.message?.toolCallId ?? d.callId
      if (cid) for (const [k, v] of open) if (v.callId === cid) open.delete(k)
    } else if (e.type === 'turn/end') open.clear()
  }
  return [...open.values()]
}

/** G5-F ⑥ 横幅里怎么叫这个会话：花名册名字 → 宿主自己的标题 → 「新会话（未命名 · 前 8 位）」（不再直接露 session-<长 ID>）。 */
export function waitTitle(session: string, rosterTitle?: string | null, hostTitle?: string | null): string {
  const t = (rosterTitle ?? '').trim() || (hostTitle ?? '').trim()
  if (t) return t.length > 40 ? t.slice(0, 40) + '…' : t
  return `新会话（未命名 · ${session.replace(/^session-/, '').slice(0, 8)}）`
}
