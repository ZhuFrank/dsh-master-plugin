/**
 * G8：暂停 / 恢复项目总管。暂停状态记在项目自己的库（master.db 的 meta paused，JSON），不动 projects.db：
 * 登记、状态目录、任务书 / 手册 / devlog、成员会话都留着；清掉就是恢复。
 * 暂停时：宿主定时保底删掉（恢复时重建）、插件内巡检不给总管发消息（备份照做）、保底消息万一到了也拒掉、成员一轮结束没回报不提醒总管。
 * 不停：总管的工具和守则（用户直接找总管照常干活）、总管自己派活 / 发消息 / 成员回报的投递（那是用户叫它做的事）。
 */
import type { Store } from './store.ts'

export interface PauseInfo { at: string; by: string; reason?: string }
const KEY = 'paused'

export function pausedInfo(store: Pick<Store, 'getMeta'>): PauseInfo | undefined {
  const v = store.getMeta(KEY)
  if (!v) return undefined
  try { const o = JSON.parse(v); return o && typeof o.at === 'string' ? o as PauseInfo : undefined } catch { return undefined }
}
export function setPaused(store: Pick<Store, 'setMeta'>, info: PauseInfo | undefined): void {
  store.setMeta(KEY, info ? JSON.stringify(info) : '')
}
