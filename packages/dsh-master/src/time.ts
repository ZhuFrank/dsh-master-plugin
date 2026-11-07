/** 插件内部唯一的时间来源：北京时间（UTC+8），不读系统时区（开发机是 KST）。 */
export type Clock = () => number

export const systemClock: Clock = () => Date.now()

const BJT_OFFSET_MS = 8 * 3600_000

function parts(ms: number) {
  const d = new Date(ms + BJT_OFFSET_MS)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return { y: d.getUTCFullYear(), mo: p(d.getUTCMonth() + 1), d: p(d.getUTCDate()), h: p(d.getUTCHours()), mi: p(d.getUTCMinutes()), s: p(d.getUTCSeconds()) }
}

/** `YYYY-MM-DD HHMM`（状态行、devlog 用的格式）。 */
export function bjtStamp(ms: number): string {
  const x = parts(ms)
  return `${x.y}-${x.mo}-${x.d} ${x.h}${x.mi}`
}

/** ISO 8601，带 +08:00。 */
export function bjtIso(ms: number): string {
  const x = parts(ms)
  return `${x.y}-${x.mo}-${x.d}T${x.h}:${x.mi}:${x.s}+08:00`
}
