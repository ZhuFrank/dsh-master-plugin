/**
 * 看板任务列表的分组（客户端用；纯函数，单测直接测）。
 * G7 ⑨：已结案（完成 / 取消）的任务下面还挂着没回答的等你定（3090 master-workspace：T101 先结案、再补问 Q1107-1）——
 * 以前三处都写成 `!closed && (等你定 || 要你处理的状态)`，它被分进「已结束」，「只看等我」显示 0。
 * 没回答的等你定一律算「等我」，不管任务是不是已结案；要你处理的任务状态（待验收 / 受阻…）只对没结案的算。
 */
export const NEEDS_YOU = new Set(['待验收', '受阻', '失败', '等用户', '等你定'])

export interface BoardTask { id: string; state: string; closed: boolean; openAsks: number }

export const needsYou = (t: BoardTask): boolean => t.openAsks > 0 || (!t.closed && NEEDS_YOU.has(t.state))

/**
 * G12：所属任务不在当前列表里的「等你定」——总管先问后派（任务还没建），或者任务被这个视图筛掉了。
 * 以前卡片只挂在任务下面渲染，这些问题看板上看不到、答不了，状态栏「等你定」却把它们算进去了（计数对不上）。
 * 看板把它们放在列表最前面单独一块「还没建任务的提问」。匹配规则和挂在任务下面完全一样（任务号精确相等），两边不会漏、不会重。
 */
export function orphanAsks<A extends { task: string }>(asks: A[], tasks: Array<{ id: string }>): A[] {
  const ids = new Set(tasks.map(t => t.id))
  return asks.filter(a => !ids.has(a.task))
}

/** 卡片上的状态标签：有没回答的等你定时写「等你定」；任务已结案就连结案状态一起写（「完成 · 等你定」），不让 Q 的状态顶掉任务状态。 */
export const stateLabel = (t: BoardTask): string => t.openAsks ? (t.closed ? `${t.state} · 等你定` : '等你定') : t.state

export function boardGroups<T extends BoardTask>(tasks: T[], opts: { mine: boolean; archived: boolean }): Array<[string, T[]]> {
  if (opts.archived) return [['已归档（结束超过 7 天）', tasks]]
  const need = tasks.filter(needsYou)
  if (opts.mine) return [['等你处理', need]]
  return [['等你处理', need], ['进行中', tasks.filter(t => !t.closed && !needsYou(t))], ['已结束（近 7 天）', tasks.filter(t => t.closed && !needsYou(t))]]
}

/**
 * G11-3 默认视图的分组（照本机看板 11-06 包：Focus 区 + 默认最近 5 天 + 按日期折叠）：
 * ★ Focus（用户置顶的）→ 等你处理 → 最近 RECENT_DAYS 天按更新日期分组（新的在前）→ 更早（默认折叠；没结的老任务也在这里，不丢）。
 * 每个任务只出现一次；组内保持传进来的顺序（服务端已按更新时间倒序）；空组不出。
 * 只看等我 / 已归档沿用原来的一组。`updated` 是 'YYYY-MM-DD HHMM'（北京时间），`today` 是 'YYYY-MM-DD'。
 */
export const RECENT_DAYS = 5
export interface ListTask extends BoardTask { focus?: boolean; updated: string }
export interface ListGroup<T> { key: string; name: string; list: T[]; collapsedByDefault: boolean }

const dayNo = (ymd: string): number => { const [y, m, d] = ymd.split('-').map(Number); return Math.round(Date.UTC(y!, m! - 1, d!) / 86400_000) }

export function listGroups<T extends ListTask>(tasks: T[], opts: { mine: boolean; archived: boolean; today: string }): Array<ListGroup<T>> {
  const g = (key: string, name: string, list: T[], collapsedByDefault = false): ListGroup<T> => ({ key, name, list, collapsedByDefault })
  if (opts.archived) return [g('archived', '已归档（结束超过 7 天）', tasks)]
  if (opts.mine) return [g('need', '等你处理', tasks.filter(needsYou))]
  const focus = tasks.filter(t => t.focus)
  const rest = tasks.filter(t => !t.focus)
  const need = rest.filter(needsYou)
  const others = rest.filter(t => !needsYou(t))
  const today = dayNo(opts.today)
  const days = new Map<string, T[]>(); const older: T[] = []
  for (const t of others) {
    const ymd = t.updated.slice(0, 10)
    const ago = today - dayNo(ymd)
    if (ago >= 0 && ago < RECENT_DAYS) { const l = days.get(ymd) ?? []; l.push(t); days.set(ymd, l) } else older.push(t)
  }
  const label = (ymd: string) => { const ago = today - dayNo(ymd); return `${ymd.slice(5)}${ago === 0 ? ' 今天' : ago === 1 ? ' 昨天' : ''}` }
  return [
    g('focus', '★ Focus', focus), g('need', '等你处理', need),
    ...[...days.keys()].sort().reverse().map(d => g(`day:${d}`, label(d), days.get(d)!)),
    g('older', '更早', older, true),
  ].filter(x => x.list.length)
}
