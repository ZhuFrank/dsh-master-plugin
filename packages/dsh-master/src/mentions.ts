/**
 * G4c：@ 任务 / @ 会话的识别、四层归属的取舍、注入给模型的摘要。纯函数，便于单测。
 *
 * 归属层级（数字小的优先；maybe 永远不当主任务）：
 *   0 用户在看板确认     1 @任务（引用块或手打的、存在的任务号）   2 工具调用 / 插件转来的消息带任务号
 *   3 @执行会话且它恰好 1 个在途任务（只在总管会话里算）     4 正文写了任务号（软：maybe）     5 总管 master_tag 兜底
 */
export const LAYER = { USER: 0, AT_TASK: 1, TOOL: 2, AT_EXEC: 3, TEXT: 4, TAG: 5 } as const
export type Layer = (typeof LAYER)[keyof typeof LAYER]
export const LAYER_LABEL: Record<number, string> = { 0: '你确认的', 1: '@任务', 2: '工具调用 / 转来的消息带任务号', 3: '@执行会话（只有这一个在途任务）', 4: '正文提到（可能相关）', 5: '总管标注' }

const TASK_ID = String.raw`(?:T\d{3,}|L\d{4}-\d+)`
export const TASK_LINK_RE = new RegExp(String.raw`@\[([^\]\n]{1,160})\]\(dsh-master-task:(${TASK_ID})\)`, 'g')
const PLAIN_AT_RE = new RegExp(String.raw`(^|[^\w@\[/])@(${TASK_ID})(?![\w-])`, 'g')
const BARE_RE = new RegExp(String.raw`(^|[^\w@\[/:-])(${TASK_ID})(?![\w-])`, 'g')
const SESSION_RE = /dsh-session:([A-Za-z0-9_-]+)/g
const RELAY_HEAD_RE = new RegExp(String.raw`^\[dsh-master 消息 · 来自 \S+ · 发给 \S+ · (${TASK_ID}) ·`)

/** 宿主 dsh-session: 的载荷是 base64url 编码的 JSON 字符串；不规范的一律丢掉。 */
export function decodeSessionRef(payload: string): string | undefined {
  try {
    const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof v !== 'string' || !v) return undefined
    return Buffer.from(JSON.stringify(v)).toString('base64url') === payload ? v : undefined
  } catch { return undefined }
}

export interface Scan { atTasks: string[]; sessions: string[]; textTasks: string[] }
/** 扫一条用户消息：@任务（只认存在的）、@会话、正文里裸写的任务号（只认存在的，不含已经 @ 的）。 */
export function scanUserText(text: string, exists: (id: string) => boolean): Scan {
  const at = new Set<string>(); const bare = new Set<string>(); const sessions = new Set<string>()
  for (const m of text.matchAll(TASK_LINK_RE)) if (exists(m[2]!)) at.add(m[2]!)
  const stripped = text.replace(TASK_LINK_RE, ' ').replace(/@\[[^\]\n]*\]\(dsh-session:[A-Za-z0-9_-]+\)/g, ' ')
  for (const m of stripped.matchAll(PLAIN_AT_RE)) if (exists(m[2]!)) at.add(m[2]!)
  for (const m of stripped.matchAll(BARE_RE)) if (exists(m[2]!) && !at.has(m[2]!)) bare.add(m[2]!)
  for (const m of text.matchAll(SESSION_RE)) { const id = decodeSessionRef(m[1]!); if (id) sessions.add(id) }
  return { atTasks: [...at], sessions: [...sessions], textTasks: [...bare] }
}

/** 发给模型前把引用块原文 `@[T005 标题](dsh-master-task:T005)` 换成 `@T005`（摘要另附）。 */
export function rewriteTaskLinks(text: string): string { return text.replace(TASK_LINK_RE, (_m, _label, id) => `@${id}`) }

/** 插件转来的消息（派活 / 回报 / 验收）头部带的任务号。 */
export function relayTask(text: string): string | undefined { return RELAY_HEAD_RE.exec(text)?.[1] }

export interface AttribRow { task: string; layer: number; reason: string }
/** 一轮一个主任务：非 maybe 的里层级最小的；其余非 maybe 记「也提到」，maybe 单列。 */
export function decideTurn(rows: AttribRow[]): { primary?: AttribRow; also: AttribRow[]; maybe: AttribRow[] } {
  const best = new Map<string, AttribRow>()
  for (const r of rows) { const b = best.get(r.task); if (!b || r.layer < b.layer) best.set(r.task, r) }
  const all = [...best.values()]
  const hard = all.filter(r => r.layer !== LAYER.TEXT).sort((a, b) => a.layer - b.layer || a.task.localeCompare(b.task))
  return { primary: hard[0], also: hard.slice(1), maybe: all.filter(r => r.layer === LAYER.TEXT) }
}

// ---------------- 摘要 ----------------
export interface BriefTask { id: string; title: string; state: string; gate: string | null; owner: string }
export interface BriefReport { at: string; line: string }
export interface BriefAsk { id: number; code?: string; question: string }
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
/** 任务摘要：标题、状态、闸门、负责、最近 3 条回报、未答等你定；整段 ≤2KB。 */
export function taskBrief(t: BriefTask, reports: BriefReport[], asks: BriefAsk[]): string {
  const lines = [`- ${t.id} ${clip(t.title, 80)}｜状态 ${t.state}${t.gate ? `｜闸门 ${t.gate}` : ''}｜负责 ${t.owner}`]
  if (reports.length) lines.push('  最近回报：', ...reports.slice(-3).map(r => `  · ${r.at} ${clip(r.line.replace(/\s+/g, ' '), 240)}`))
  else lines.push('  最近回报：（还没有）')
  if (asks.length) lines.push('  未答等你定：', ...asks.slice(0, 3).map(a => `  · ${a.code ?? `#${a.id}`} ${clip(a.question, 160)}`))
  return clip(lines.join('\n'), 2000)
}
export const NOTICE_HEAD = '[dsh-master 附上的信息（插件附上的，不是用户说的）]'
export const PEER_REMINDER = '执行会话之间不直接协作：要别的执行会话配合，请回报总管（master_report），由总管转交。这里附上的只是对方的状态，供参考。'
