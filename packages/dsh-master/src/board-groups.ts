/**
 * 看板任务列表的分组（客户端用；纯函数，单测直接测）。
 * G7 ⑨：已结案（完成 / 取消）的任务下面还挂着没回答的等你定（3090 master-workspace：T101 先结案、再补问 Q1107-1）——
 * 以前三处都写成 `!closed && (等你定 || 要你处理的状态)`，它被分进「已结束」，「只看等我」显示 0。
 * 没回答的等你定一律算「等我」，不管任务是不是已结案；要你处理的任务状态（待验收 / 受阻…）只对没结案的算。
 */
export const NEEDS_YOU = new Set(['待验收', '受阻', '失败', '等用户', '等你定'])

export interface BoardTask { id: string; state: string; closed: boolean; openAsks: number }

export const needsYou = (t: BoardTask): boolean => t.openAsks > 0 || (!t.closed && NEEDS_YOU.has(t.state))

/** 卡片上的状态标签：有没回答的等你定时写「等你定」；任务已结案就连结案状态一起写（「完成 · 等你定」），不让 Q 的状态顶掉任务状态。 */
export const stateLabel = (t: BoardTask): string => t.openAsks ? (t.closed ? `${t.state} · 等你定` : '等你定') : t.state

export function boardGroups<T extends BoardTask>(tasks: T[], opts: { mine: boolean; archived: boolean }): Array<[string, T[]]> {
  if (opts.archived) return [['已归档（结束超过 7 天）', tasks]]
  const need = tasks.filter(needsYou)
  if (opts.mine) return [['等你处理', need]]
  return [['等你处理', need], ['进行中', tasks.filter(t => !t.closed && !needsYou(t))], ['已结束（近 7 天）', tasks.filter(t => t.closed && !needsYou(t))]]
}
