/**
 * G11-5 宿主定时服务的版本兼容（DSH 0.2.1 / 0.2.2 两种接口，插件只经这里用）。
 * - 0.2.1：create(sessionId, { title, every_seconds, prompt })；delete({ sessionId, id }) ⇒ { deleted }；
 *   catalog 条目顶层有 sessionId，status 是 active / inactive。
 * - 0.2.2：create({ title, prompt, timing: { kind: 'every', every_seconds }, target: { kind: 'session', sessionId } }, actorSessionId)；
 *   edit({ id, action: 'delete' }) ⇒ { deleted: true }（没有 delete 方法）；catalog 条目的会话在 target 里，status 是 active / paused / ended。
 * 依据：两版 @deepseek-ai/dsh-schedule 的 lib/types/index.d.ts、types.d.ts。认版本看有没有 edit（0.2.1 没有、0.2.2 有）。
 */
export type SchedFlavor = '0.2.1' | '0.2.2'
/** 统一后的条目：插件只关心这几样。 */
export interface SchedEntry { id: string; title: string; sessionId: string | undefined; active: boolean; scheduledAt: string | undefined }

export function schedFlavor(sched: any): SchedFlavor { return typeof sched?.edit === 'function' ? '0.2.2' : '0.2.1' }

export function normEntry(c: any): SchedEntry {
  const sessionId = typeof c?.sessionId === 'string' ? c.sessionId : c?.target?.kind === 'session' && typeof c.target.sessionId === 'string' ? c.target.sessionId : undefined
  return { id: String(c?.id ?? ''), title: String(c?.title ?? ''), sessionId, active: c?.status === 'active', scheduledAt: typeof c?.scheduledAt === 'string' ? c.scheduledAt : undefined }
}

export async function schedEntries(sched: any): Promise<SchedEntry[]> { return ((await sched.catalog()) ?? []).map(normEntry) }

/** 给某个会话建一条「每 N 秒」的定时消息，返回新条目的 id。 */
export async function schedCreateEvery(sched: any, sessionId: string, x: { title: string; everySeconds: number; prompt: string }): Promise<string | undefined> {
  const rec = schedFlavor(sched) === '0.2.2'
    ? await sched.create({ title: x.title, prompt: x.prompt, timing: { kind: 'every', every_seconds: x.everySeconds }, target: { kind: 'session', sessionId } }, sessionId)
    : await sched.create(sessionId, { title: x.title, every_seconds: x.everySeconds, prompt: x.prompt })
  return rec?.id === undefined ? undefined : String(rec.id)
}

/** 删一条；删到了返回 true。 */
export async function schedDelete(sched: any, e: SchedEntry): Promise<boolean> {
  // 0.2.2：把总管当操作者，宿主就不给它发「[SCHEDULE CHANGE]」改动通知（通知会在它下一步里多出来一条，还被当成保底）
  const r = schedFlavor(sched) === '0.2.2' ? await sched.edit({ id: e.id, action: 'delete' }, e.sessionId) : await sched.delete({ sessionId: e.sessionId, id: e.id })
  return r?.deleted === true
}
