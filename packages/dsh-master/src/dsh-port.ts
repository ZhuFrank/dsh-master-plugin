/**
 * DSH 一侧的实现：投递（照官方原型 delivery.ts）与会话操作。
 * 只用 ctx 上的服务，不 import 任何 @deepseek-ai 包（link 安装解析不到，spike G1 坑 1）。
 */
import fs from 'node:fs'
import type { DeliveryPort, DeliverInput } from './delivery.ts'
import { SOURCE_KIND } from './delivery.ts'
import type { SessionPort, LiveStatus } from './core.ts'
import type { PanelPort, ContentPart, TurnText } from './panel-service.ts'
import type { Role } from './store.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = any
type Agent = any

export const PRESET_IDS = { master: 'dsh-master-master', exec: 'dsh-master-exec' } as const

export interface PortOptions { sessionModel?: { provider: string; model: string } | undefined; permissionPreset: string }

import { pendingFromRecord, type PendingInRecord } from './waiting.ts'
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) }
  return o
}

async function readEvents(ctx: Ctx, sessionId: string, each: (e: any) => void): Promise<void> {
  await ctx.sessionPersistence.flush()
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    for (let offset = 0; ;) {
      const { events } = await handle.read(offset, 512)
      if (!events.length) break
      for (const e of events) each(e)
      offset += events.length
    }
  } finally {
    if (typeof handle[Symbol.asyncDispose] === 'function') await handle[Symbol.asyncDispose]()
    else await handle.close?.()
  }
}

export class DshPorts implements DeliveryPort, SessionPort, PanelPort {
  /** 每个 Agent 会话里已经有的 dsh-master 消息 ID（实时事件 + 持久历史）。 */
  private readonly seen = new WeakMap<object, { ids: Set<string>; loaded?: Promise<void> }>()
  constructor(private readonly ctx: Ctx, private readonly opts: PortOptions, private readonly faultFile?: string) {
    ctx.on('session/event', (session: any, event: any) => {
      if (event?.type !== 'user/message' || event.data?.source?.kind !== SOURCE_KIND) return
      this.seen.get(session)?.ids.add(event.data.id)
    })
  }

  private async history(agent: Agent): Promise<Set<string>> {
    let state = this.seen.get(agent.session)
    if (!state) { state = { ids: new Set() }; this.seen.set(agent.session, state) }
    const s = state
    s.loaded ??= readEvents(this.ctx, agent.id, e => {
      if (e.type === 'user/message' && e.data?.source?.kind === SOURCE_KIND) s.ids.add(e.data.id)
    }).catch(err => { s.loaded = undefined; throw err })
    await s.loaded
    return s.ids
  }

  private async resolve(id: string): Promise<Agent> {
    const r = await this.ctx.sessionController.resolveAgent(id)
    if ('error' in r) throw new Error(`resolveAgent(${id}): ${r.error?.code ?? JSON.stringify(r.error)}`)
    return r.agent
  }

  async deliver(input: DeliverInput): Promise<'delivered' | 'already'> {
    if (this.faultFile && fs.existsSync(this.faultFile)) throw new Error(`fault injection: ${this.faultFile} 存在`)
    const agent = await this.resolve(input.to)
    const ids = await this.history(agent)
    if (this.ctx.agents.get(input.to) !== agent) throw new Error('投递目标在等待期间被销毁')
    const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some((m: any) => m.id === input.messageId)
    if (ids.has(input.messageId) || pending) return 'already'
    const source = input.mode === 'inject' ? { kind: SOURCE_KIND, form: 'notice', summary: input.summary.slice(0, 120) } : { kind: SOURCE_KIND, form: 'relay' }
    const message = deepFreeze(structuredClone({ id: input.messageId, role: 'user', content: [{ type: 'text', text: input.text }], source }))
    if (input.mode === 'inject') { agent.inject(message); ids.add(input.messageId) }
    else if (input.mode === 'steer') agent.steer(message)
    else agent.followup(message)
    await this.ctx.sessionPersistence.flush()
    return 'delivered'
  }

  async ensureSession(input: { id: string; cwd: string; title: string; role: Role; preset?: string | undefined }): Promise<void> {
    let r = await this.ctx.sessionController.resolveAgent(input.id)
    if ('error' in r) {
      if (r.error?.code !== 'session/not-found') throw new Error(`resolveAgent(${input.id}): ${r.error?.code}`)
      const ws = await this.ctx.workspaceRegistry.create(input.cwd)
      await this.ctx.sessionController.create({ sessionId: input.id, workspaceId: ws.id, agentPreset: PRESET_IDS[input.role] })
      r = await this.ctx.sessionController.resolveAgent(input.id)
      if ('error' in r) throw new Error(`创建后仍找不到会话 ${input.id}: ${r.error?.code}`)
      if (this.opts.sessionModel) await this.ctx.sessionController.selectModel({ sessionId: input.id, ...this.opts.sessionModel })
      await this.ctx.sessionController.rename({ sessionId: input.id, title: input.title })
    }
    this.ctx.permissionPresets?.set(r.agent.session, input.preset ?? this.opts.permissionPreset)
  }

  status(id: string): LiveStatus {
    const a = this.ctx.agents.get(id)
    if (!a) return 'cold'
    return a.status === 'running' ? 'running' : 'idle'
  }

  async promptUser(sessionId: string, requestId: string, content: ContentPart[]): Promise<void> {
    await this.ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content }, AbortSignal.timeout(30_000))
  }

  /** 从会话记录里读出某一轮：用户原话 + 插件转来的消息 + 助手文字回复（只读，不另存副本）。 */
  /** G5-F ② 补扫用：读这个会话的记录，返回问了还没结果的审批 / 选择题。 */
  async pendingWaits(sessionId: string): Promise<PendingInRecord[]> {
    const evs: Array<{ type: string; time?: unknown; data?: any }> = []
    await readEvents(this.ctx, sessionId, e => { if (/^(approval\/|tool\/(call|result)$|turn\/end$)/.test(String(e?.type))) evs.push({ type: e.type, time: e.time, data: e.data }) })
    return pendingFromRecord(evs)
  }

  async turnText(sessionId: string, turn: number): Promise<TurnText | undefined> {
    let cur: TurnText | undefined; let done = false
    const textOf = (c: any[]) => (c ?? []).map((x: any) => x?.text ?? '').join('').trim()
    await readEvents(this.ctx, sessionId, e => {
      if (done) return
      if (e.type === 'turn/start') { if (cur) { done = true; return } if (Number(e.data?.turn) === turn) cur = { turn, seqStart: Number(e.seq), seqEnd: null, ended: false, parts: [] } ; return }
      if (!cur) return
      if (e.type === 'turn/end') { cur.seqEnd = Number(e.seq); cur.ended = true; done = true; return }
      if (e.type === 'user/message') {
        const k = e.data?.source?.kind; const t = textOf(e.data?.content)
        if (t && k === 'user') cur.parts.push({ role: 'user', text: t, seq: Number(e.seq) })
        else if (t && k === 'dsh-master' && e.data?.source?.form === 'relay') cur.parts.push({ role: 'relay', text: t, seq: Number(e.seq) })
      } else if (e.type === 'assistant/message') {
        const t = textOf(e.data?.message?.content); if (t) cur.parts.push({ role: 'assistant', text: t, seq: Number(e.seq) })
      }
    })
    return cur
  }

  async lastAssistantText(id: string): Promise<string | undefined> {
    let last: string | undefined
    try {
      await readEvents(this.ctx, id, e => {
        if (e.type !== 'assistant/message') return
        const t = (e.data?.message?.content ?? []).map((c: any) => c?.text ?? '').join('').trim()
        if (t) last = t
      })
    } catch { /* 读不到就算了 */ }
    return last
  }
}
