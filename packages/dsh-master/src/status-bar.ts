/**
 * G11-2 总管状态栏（L1107-2 方案 §3）。
 * 「正在：」只记工具名 + 参数里的 description（压成一行、≤ DOING_MAX 字）。命令全文、路径、正文一律不记：
 * 里面可能有令牌、口令、私人路径（跟本机看板 master_now_hook 同一条规矩）。只放内存，不落库。
 */
export const DOING_MAX = 80

export function doingLabel(tool: unknown, args: unknown): string {
  const name = typeof tool === 'string' && tool.trim() ? tool.trim() : '（未知工具）'
  const raw = args && typeof args === 'object' ? (args as Record<string, unknown>).description : undefined
  if (typeof raw !== 'string') return name
  const one = raw.replace(/\s+/g, ' ').trim()
  if (!one) return name
  const chars = [...one]
  const desc = chars.length > DOING_MAX ? `${chars.slice(0, DOING_MAX - 1).join('')}…` : one
  return `${name} · ${desc}`
}

export interface Doing { label: string; atMs: number }

/** 每个总管最近一次工具调用（tools/pre-execute 里记）。 */
export class MasterNowTracker {
  private readonly map = new Map<string, Doing>()
  record(session: string, tool: unknown, args: unknown, atMs: number): void { this.map.set(session, { label: doingLabel(tool, args), atMs }) }
  get(session: string): Doing | undefined { return this.map.get(session) }
}
