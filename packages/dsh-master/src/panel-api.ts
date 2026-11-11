/**
 * 看板（右侧栏）的服务端逻辑（纯函数，便于单测）：视图筛选、动作白名单与校验、POST 请求头检查。
 * G4c 起看板不再发消息：send / upload / new_task 及图片暂存已删除（对话一律回原生窗口）。
 * 路由只挂在 connection.fetch（/api，DSH owner 认证；手机经 pocket 也是 owner），不放进无鉴权的 webServer。
 */
import type { TaskRow } from './store.ts'
import { TERMINAL_TASK_STATES } from './core.ts'

export const PANEL_LIMITS = {
  actionBytes: 64 * 1024,        // 动作请求体 ≤64KB
  archiveAfterMs: 7 * 24 * 3600_000,
}


/** POST 防跨站：Origin 必须是本服务、Content-Type 必须对、带自定义头（简单请求带不上）。 */
export function checkPost(req: Request): string | undefined {
  // 宿主转进来的 req.url 是 http://dsh.internal/…（不是浏览器看到的地址），所以拿 Host 头比；
  // 宿主的 /api 防线已经校验 Host 是本机 / 绑定地址 / trustedHosts，并且只在带了 Origin 时才比 ⇒ 这里要求必须带、且同源
  const origin = req.headers.get('origin'); const host = req.headers.get('host')
  let originHost: string | undefined
  try { const u = new URL(origin ?? ''); if (u.protocol === 'http:' || u.protocol === 'https:') originHost = u.host } catch { /* 无效 */ }
  if (!origin || !host || originHost !== host.toLowerCase()) return 'origin 不是本服务'
  if (req.headers.get('x-dsh-master') !== '1') return '缺少 x-dsh-master 请求头'
  const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (ct !== 'application/json') return 'content-type 必须是 application/json'
  return undefined
}

/**
 * 读请求体；超过 limit 不再保存（不把超大请求读进内存）。
 * 超了之后继续读掉、丢弃，直到 drainLimit——宿主在请求体没读完时会直接断开连接，浏览器只看到「Failed to fetch」而拿不到 413；
 * 超过 drainLimit 才真的断开。
 */
export async function readLimited(req: Request, limit: number, drainLimit = limit * 3): Promise<Buffer | 'too_large'> {
  if (!req.body) return Buffer.alloc(0)
  const reader = req.body.getReader()
  const parts: Buffer[] = []; let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > drainLimit) { await reader.cancel().catch(() => {}); return 'too_large' }
    if (n <= limit) parts.push(Buffer.from(value))
  }
  return n > limit ? 'too_large' : Buffer.concat(parts)
}
/** 出错返回前把剩下的请求体读掉（最多 limit），理由同上。 */
export async function drain(req: Request, limit = 1024 * 1024): Promise<void> { await readLimited(req, 0, limit).catch(() => {}) }

// ---------------- 视图 ----------------
export type PanelView = 'active' | 'archived' | 'all'
const ms = (iso: string) => Date.parse(iso) || 0
/** 「进行中 + 结束 7 天内」/「已归档」（结束超过 7 天）；可再按派出日期（北京时间 YYYY-MM-DD，含首尾）筛。 */
/** openAsk：还挂着没回答的等你定的任务 ID（G7 ⑨：这些任务就算结案超过 7 天也不进已归档，问题不能被藏起来）。 */
export function filterTasks(tasks: TaskRow[], view: PanelView, now: number, range: { from?: string; to?: string } = {}, openAsk: Set<string> = new Set(), focus: Set<string> = new Set()): TaskRow[] {
  const day = (iso: string) => iso.slice(0, 10) // 存的就是 +08:00 的 ISO，前 10 位即北京日期
  return tasks.filter(t => {
    const ended = TERMINAL_TASK_STATES.has(t.state)
    // G11-3：置顶（Focus）的已结任务不归档，一直留在默认视图，直到用户取消置顶
    const old = ended && !openAsk.has(t.id) && !focus.has(t.id) && now - ms(t.updated_at) > PANEL_LIMITS.archiveAfterMs
    if (view === 'active' && old) return false
    if (view === 'archived' && !old) return false
    if (range.from && day(t.created_at) < range.from) return false
    if (range.to && day(t.created_at) > range.to) return false
    return true
  })
}

// ---------------- 动作 ----------------
export type PanelAction =
  | { action: 'answer'; ask: number; answer: string }
  | { action: 'done'; task: string; note?: string }
  | { action: 'cancel'; task: string; note?: string }
  | { action: 'confirm_tag'; session: string; turn: number; task: string }
  | { action: 'pause'; reason?: string }
  | { action: 'resume' }
  /** G11-3：任务置顶到「★ Focus」区（存项目库，手机电脑一致） */
  | { action: 'focus'; task: string; on: boolean }

const TASK_ID = /^(T\d{3,}|L\d{4}-\d+)$/
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,80}$/
/** 动作白名单 + 字段校验；返回规范化动作或错误。 */
export function validateAction(body: unknown): PanelAction | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '请求体必须是对象' }
  const b = body as Record<string, unknown>
  const s = (k: string, max: number, required = true): string | undefined | { error: string } => {
    const v = b[k]
    if (v === undefined || v === null || v === '') return required ? { error: `缺少 ${k}` } : undefined
    if (typeof v !== 'string') return { error: `${k} 必须是字符串` }
    if (v.length > max) return { error: `${k} 太长` }
    return v.trim()
  }
  const isErr = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v
  switch (b.action) {
    case 'answer': {
      if (typeof b.ask !== 'number' || !Number.isInteger(b.ask) || b.ask <= 0) return { error: 'ask 必须是正整数' }
      const answer = s('answer', 2000); if (isErr(answer)) return answer
      return { action: 'answer', ask: b.ask, answer: answer! }
    }
    case 'done': case 'cancel': {
      const task = s('task', 20); if (isErr(task)) return task
      if (!TASK_ID.test(task!)) return { error: 'task 格式不对' }
      const note = s('note', 500, false); if (isErr(note)) return note
      return { action: b.action, task: task!, ...(note ? { note } : {}) }
    }
    case 'confirm_tag': {
      const session = s('session', 80); if (isErr(session)) return session
      if (!SESSION_ID.test(session!)) return { error: 'session 格式不对' }
      if (typeof b.turn !== 'number' || !Number.isInteger(b.turn) || b.turn <= 0) return { error: 'turn 必须是正整数' }
      const task = s('task', 20); if (isErr(task)) return task
      if (!TASK_ID.test(task!)) return { error: 'task 格式不对' }
      return { action: 'confirm_tag', session: session!, turn: b.turn, task: task! }
    }
    // G8：暂停 / 恢复项目总管（入口里处理，不经 PanelService）
    case 'pause': {
      const reason = s('reason', 500, false); if (isErr(reason)) return reason
      return { action: 'pause', ...(reason ? { reason } : {}) }
    }
    case 'resume': return { action: 'resume' }
    case 'focus': {
      const task = s('task', 20); if (isErr(task)) return task
      if (!TASK_ID.test(task!)) return { error: 'task 格式不对' }
      if (typeof b.on !== 'boolean') return { error: 'on 必须是 true / false' }
      return { action: 'focus', task: task!, on: b.on }
    }
    default: return { error: `不支持的动作：${String(b.action)}` }
  }
}
