/**
 * dsh-master 插件入口（宿主端）。
 * 状态目录默认 $DSH_HOME/dsh-master/：master.db、memory.db、docs/（git 仓库，插件不 commit）、backups/、heavy/、.lock、projects.db、projects/<项目>/。
 *
 * G6-2 起按「单元」运行：
 * - 旧单元（legacy）：状态目录里的 master.db / memory.db / docs/，总管 master，成员 exec-<名字>。没有开张任何项目时只有它，行为和以前完全一样。
 * - 项目单元：projects.db 里登记的每个项目一个（运行库 projects/<项目>/，文档 <项目根>/.dsh-master/docs/，总管 = 开张时的那个会话，成员 <项目>.<名字>）。
 * - 工具、系统提示、每步前处理、会话事件、投递、巡检都按会话所属的单元走；守卫、重活队列、等你点是全局的。
 * - 开张：在某个目录里用「dsh-master 总管」预设新建会话 ⇒ session/created 里认出来 ⇒ 登记项目、写 .git/info/exclude 和 owner 文件、把这个会话设为项目总管。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MemoryLayer } from 'dsh-master-devlog'
import { Store } from './store.ts'
import { Delivery, SOURCE_KIND } from './delivery.ts'
import { Core, ToolInputError, TERMINAL_TASK_STATES, type ToolSpec } from './core.ts'
import { DshPorts, PRESET_IDS } from './dsh-port.ts'
import { toolOutput } from './tool-output.ts'
import { pausedInfo, setPaused } from './pause.ts'
import { resolveLegacyMode, masterPresetOf, stillSelected, type LegacyMode } from './release-defaults.ts'
import { guardDecision, bashWriteTargets, fileToolTarget } from './guard.ts'
import { denyText, fsConflict, CONFLICT_HINT, rel as relPath } from './claims.ts'
import { waitService } from './services.ts'
import { acquireStateLock } from './lock.ts'
import { systemClock, bjtIso, bjtStamp } from './time.ts'
import { rolePrompt } from './prompts.ts'
import { Patrol } from './patrol.ts'
import { HeavyQueue } from './heavy.ts'
import { FilePushGate, topicPriors, scheduleStep } from './recall-push.ts'
import { PanelService, PanelError } from './panel-service.ts'
import { validateAction, checkPost, readLimited, drain, PANEL_LIMITS } from './panel-api.ts'
import { Attribution } from './attrib.ts'
import { doctor } from './doctor.ts'
import { WaitingTracker, track, waitTitle } from './waiting.ts'
import { ProjectRegistry, projectPaths, memberPrefixOf, projectDotDir, findProjectRoot, gitExclude, claimOwner, type ProjectRow } from './projects.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
export const name = 'dsh-master'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'tools', 'webServer', 'connection', 'permissionPresets', 'systemPrompt']

export interface Config {
  stateDir?: string
  masterCwd?: string
  idleGraceMs?: number
  pumpIntervalMs?: number
  permissionPreset?: string
  /** G7：只有总管能读的目录，默认 [$DSH_HOME/logs]。 */
  secretPaths?: string[]
  /** G7 ④：项目总管的权限预设。默认 danger-full-access（完全权限，Frank 11-07 #427 定）；写 workspace-write 就收窄成「工作区内修改」。 */
  projectMasterPreset?: string
  /** G6-4：项目成员的权限预设（默认 workspace-write：只写项目根，往外写弹等你批）。 */
  projectMemberPreset?: string
  sessionModel?: { provider: string; model: string }
  rate?: { perMinute?: number; maxBytes?: number; maxAttempts?: number; backoffMs?: number }
  /** 巡检间隔（默认 10 分钟）、停滞阈值（默认 2 小时）、单轮过长阈值（默认 1 小时）。 */
  patrol?: { intervalMs?: number; stallMs?: number; longRunMs?: number; firstBackupMs?: number; waitMs?: number; rescanMs?: number }
  /** ctx.schedule 绑总管的保底巡检间隔（秒，默认 6 小时；0 关闭）。 */
  scheduleEverySeconds?: number
  /** 自动推送回忆：按文件（写前提醒）、按话题（每步开始前）。默认都开。 */
  autoRecall?: { byFile?: boolean; byTopic?: boolean }
  /**
   * 旧单元（master / exec-，不分项目的早期形态）。
   * - archived（G6-5）：只读，不投递、不提醒、不装工具、删旧定时保底；状态目录里有 legacy-archived 标记文件也算。
   * - off（G10）：不建旧总管、不巡检、没有定时保底，只用项目制。
   * - 不配置：状态目录里已经有旧花名册 ⇒ active（老用户升级后不变），否则 off（新装）。
   */
  legacy?: LegacyMode
  /** G6-2：项目制开张（用「dsh-master 总管」预设新建会话 ⇒ 登记项目）。默认开；false 时只跑旧单元。 */
  projects?: boolean
  /** 只给测试用：开一个只认 127.0.0.1 的调试接口 /dsh-master-debug。 */
  debugControl?: boolean
  /** 只给测试用：这个文件存在时所有投递都失败（验证持久重试 / 重启后重试）。 */
  faultFile?: string
  /** 只给测试用：插件启动后这么多毫秒内假装宿主的 schedule 服务还没就绪（复现 3090 上存档模式启动太快的时序）。 */
  fakeScheduleDelayMs?: number
  /** 只给测试用：重活队列看到的可用内存（GB）。 */
  fakeFreeGb?: number
}

/** 执行会话不许用的内置工具（只对全局工具生效；preset 里的工具靠 preset 本身不装）。 */
const EXEC_DENY = ['send_message', 'list_agents', 'interrupt_agent', 'schedule_create', 'schedule_update', 'schedule_delete']
const PUSH_FILE = '[dsh-master 前情提醒（自动推送，不是用户说的，也不是执行失败）]'
const PUSH_TOPIC = '[dsh-master 相关前情（自动推送，不是用户说的）]'
/** 「dsh-master 总管」预设的 ID（cordis.patch.yml）。用户在某个目录里用它新建会话 = 开张。 */
export const MASTER_PRESET = 'dsh-master-master'
export const LEGACY = 'legacy'

function deepFreeze<T>(o: T): T { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) } return o }
const textOf = (m: any) => (m?.content ?? []).map((c: any) => c?.text ?? '').join('')

/** 一个单元：一套库 + 记忆层 + 总管 + 归属 + 巡检 + 面板。 */
export interface Unit {
  key: string
  project?: ProjectRow
  store: Store
  mem: MemoryLayer
  delivery: Delivery
  core: Core
  attrib: Attribution
  patrol: Patrol
  panel: PanelService
  filePush: FilePushGate
  pushed: Map<string, Set<string>>
  backupDir: string
}

export function apply(ctx: any, config: Config = {}): void {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  const stateDir = path.resolve(config.stateDir ?? path.join(home, 'dsh-master'))
  const release = acquireStateLock(stateDir)
  ctx.effect(() => release)
  const ports = new DshPorts(ctx, { sessionModel: config.sessionModel, permissionPreset: config.permissionPreset ?? 'danger-full-access' }, config.faultFile)
  const r = config.rate ?? {}
  const deliveryOpts = {
    ...(r.perMinute ? { ratePerMinute: r.perMinute } : {}), ...(r.maxBytes ? { maxBytes: r.maxBytes } : {}),
    ...(r.maxAttempts ? { maxAttempts: r.maxAttempts } : {}), ...(r.backoffMs ? { backoffMs: r.backoffMs } : {}),
  }
  const log = (msg: string, ...args: unknown[]) => ctx.logger?.info?.(`[dsh-master] ${msg}`, ...args)
  const warn = (msg: string, ...args: unknown[]) => ctx.logger?.warn?.(`[dsh-master] ${msg}`, ...args)
  const env = { DSH_HOME: home, HOME: os.homedir() }
  /** G7：实例日志目录（dsh.log 里有登录令牌）只有总管能读。 */
  const secretPaths = config.secretPaths ?? [path.join(home, 'logs')]
  const cwdOf = (agent: any): string | undefined => {
    try { return ctx.get?.('workingDirectory')?.get(agent.session) ?? agent?.session?.header?.cwd } catch { return agent?.session?.header?.cwd }
  }
  const pc = config.patrol ?? {}

  // ---- 单元表 ----
  const units = new Map<string, Unit>()
  const unitList = () => [...units.values()]
  /** 会话属于哪个单元（按各单元的花名册）。不在任何花名册里 ⇒ undefined。 */
  const unitOf = (sessionId: string | undefined): Unit | undefined => {
    if (!sessionId) return undefined
    for (const u of units.values()) if (u.core.roleOf(sessionId)) return u.key === LEGACY && !legacyLive ? undefined : u
    return undefined
  }
  /** G6-5：旧单元已存档 ⇒ 旧会话当成普通会话（不在任何单元里）：不装工具、不提醒、不归属；旧单元不投递、不巡检、没有定时保底，看板只读。 */
  const archiveMarker = path.join(stateDir, 'legacy-archived')
  /** 还在跑的单元（存档的旧单元不算）。 */
  const liveUnits = () => unitList().filter(u => !(u.key === LEGACY && !legacyLive))
  /** 守卫保护的目录：全局状态目录 + 每个项目的 <根>/.dsh-master/。 */
  /** 成员手上没结束的任务（G6-4 把认领 / 冲突事件记到这些任务的时间线上）。 */
  const activeTasksOf = (u: Unit, sid: string) => u.store.listTasks().filter(t => t.owner === sid && !TERMINAL_TASK_STATES.has(t.state)).map(t => t.id)
  const protectedPaths = () => [stateDir, ...unitList().filter(u => u.project).map(u => projectDotDir(u.project!.root))]
  /** G6-4：受保护目录里放行的产物目录 <根>/.dsh-master/out/。 */
  const allowPaths = () => unitList().filter(u => u.project).map(u => path.join(projectDotDir(u.project!.root), 'out'))

  // 旧单元：状态目录里的库（重活队列也记在这里，全机一个队列）
  const legacyStore = new Store(path.join(stateDir, 'master.db'))
  /** G10：旧单元模式（见 Config.legacy）。archived 只读；off 不建旧总管；active 和以前一样。 */
  const legacyMode: LegacyMode = resolveLegacyMode({ config: config.legacy, marker: fs.existsSync(archiveMarker), legacySessions: legacyStore.listSessions().length })
  const legacyArchived = legacyMode === 'archived'
  const legacyLive = legacyMode === 'active'
  const legacyDocs = path.join(stateDir, 'docs')
  const legacyMem = new MemoryLayer({ dbFile: path.join(stateDir, 'memory.db'), docsRoot: legacyDocs, clock: systemClock })
  try { if (!fs.existsSync(path.join(legacyDocs, '.git'))) execFileSync('git', ['init', '-q', legacyDocs], { stdio: 'ignore' }) } catch { /* 没有 git 也能用 */ }
  const heavy = new HeavyQueue(legacyStore, systemClock, {
    logDir: path.join(stateDir, 'heavy'),
    ...(config.fakeFreeGb !== undefined ? { freeGb: () => config.fakeFreeGb! } : {}),
    guard: (command, cwd) => guardDecision({ name: 'bash', args: { command }, cwd }, { protectedPaths: protectedPaths(), env }),
    onDone: job => {
      try { (unitOf(job.session) ?? units.get(LEGACY)!).core.systemNotify({ key: `heavy:${job.id}:${job.state}`, to: job.session, label: '重活结束', text: `heavy_run #${job.id}「${job.label}」${job.state === 'done' ? '跑完了' : '失败了'}（exit=${job.exit_code ?? '中断'}）。日志：${job.log}` }) }
      catch (e) { warn('heavy notify: %s', String(e)) }
    },
  })
  const waiting = new WaitingTracker(systemClock)

  function makeUnit(key: string, store: Store, mem: MemoryLayer, backupDir: string, project?: ProjectRow): Unit {
    const delivery = new Delivery(store, ports, systemClock, deliveryOpts)
    const u = { key, project, store, mem, delivery, backupDir, pushed: new Map<string, Set<string>>(), filePush: new FilePushGate(file => mem.relatedForFiles([file])) } as Unit
    u.core = new Core(store, delivery, ports, systemClock, { idleGraceMs: config.idleGraceMs ?? 120_000, mem, heavy,
      ...(project ? { masterId: project.master, memberPrefix: memberPrefixOf(project), projectRoot: project.root, memberPreset: config.projectMemberPreset ?? 'workspace-write', masterPreset: masterPresetOf(config) } : {}),
      patrol: async () => ({ findings: u.patrol.findings() }), tag: (caller, a) => u.attrib.tag(caller, a),
      doctor: () => ({ problems: doctor(store, mem, { now: systemClock(), backupDir }) }),
      // G8：只有项目单元能暂停（旧单元没有这个工具）
      ...(project ? { pause: (caller: string, reason: string) => pauseUnit(u, caller, reason) } : {}) })
    u.attrib = new Attribution(store, u.core, systemClock)
    // 等你点：旧单元报不在任何项目里的会话（和以前一样），项目单元只报自己的
    const mine = () => waiting.list().filter(w => { const o = unitOf(w.session); return project ? o === u : (!o || o === u) })
    u.patrol = new Patrol(store, u.core, mem, systemClock, { stallMs: pc.stallMs ?? 2 * 3600_000, longRunMs: pc.longRunMs ?? 3600_000, backupDir, waiting: mine, waitMs: pc.waitMs })
    u.panel = new PanelService(store, u.core, u.attrib, ports, systemClock)
    store.addEvent({ at: bjtIso(systemClock()), type: 'plugin/start', data: { pid: process.pid, stateDir, unit: key, pending: store.deliveriesByState('pending').length } })
    ctx.effect(() => () => { try { u.core.dispose() } catch {} ; try { mem.close() } catch {} ; try { store.close() } catch {} })
    units.set(key, u)
    return u
  }
  const legacy = makeUnit(LEGACY, legacyStore, legacyMem, path.join(stateDir, 'backups'))

  const registry = new ProjectRegistry(path.join(stateDir, 'projects.db'), systemClock)
  ctx.effect(() => () => { try { registry.db.close() } catch {} })
  function openUnit(p: ProjectRow): Unit {
    const had = units.get(p.id); if (had) return had
    const paths = projectPaths(stateDir, p)
    const store = new Store(paths.dbFile)
    const mem = new MemoryLayer({ dbFile: paths.memoryDb, docsRoot: paths.docsRoot, clock: systemClock })
    return makeUnit(p.id, store, mem, path.join(paths.runtimeDir, 'backups'), p)
  }
  if (config.projects !== false) for (const p of registry.list()) { try { openUnit(p) } catch (e) { warn('打开项目 %s 失败：%s', p.id, String(e)) } }

  // ---- 按角色装饰会话：工具 + 系统提示（角色守则 + 记忆层常驻摘要）----
  const decorated = new WeakMap<object, Array<() => void>>()
  const toolDef = (u: Unit, spec: ToolSpec, caller: string) => ({
    name: spec.name, description: spec.description, parameters: spec.parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: async (args: unknown) => {
      try {
        const out = await spec.run(args, caller)
        if (spec.name.startsWith('master_')) u.core.renderBoard()
        try { u.attrib.onTool(caller, spec.name, args) } catch (e) { warn('attrib tool: %s', String(e)) }
        // G7 ⑥：输出声明的是对象，宿主会校验；不是对象的包一层（master_sessions 曾经返回数组，每次都报 invalid output）
        return toolOutput(out)
      }
      catch (e) { if (e instanceof ToolInputError) throw new Error(e.message); throw e }
    },
  })
  const decorate = (agent: any) => {
    if (!agent || decorated.has(agent)) return
    const u = unitOf(agent.id)
    const role = u?.core.roleOf(agent.id)
    if (!u || !role) return
    const disposers: Array<() => void> = []
    decorated.set(agent, disposers)
    for (const spec of u.core.toolsFor(agent.id)) disposers.push(agent.ctx.tools.register(toolDef(u, spec, agent.id)))
    try {
      disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-master-role', order: 9000, interpolate: false, text: () => {
        const row = u.store.getSession(agent.id)
        return [rolePrompt(role, agent.id, u.mem.docs.abs(u.core.handbookFile(agent.id, row?.handbook)), u.core.masterId, u.project ? { root: u.project.root, worktree: u.store.getMeta(`worktree:${agent.id}`), paused: role === 'master' ? pausedView(u) : undefined } : undefined), u.mem.residentSummary()].filter(Boolean).join('\n\n')
      } }))
    } catch (e) { warn('systemPrompt.section 失败：%s', String(e)) }
    if (role === 'exec') {
      try { disposers.push(agent.ctx.tools.restrict({ deny: EXEC_DENY })) } catch (e) { warn('restrict 失败：%s', String(e)) }
    }
    log('decorated %s as %s（%s）', agent.id, role, u.key)
  }
  const decorateLive = (id?: string) => { for (const a of ctx.agents.list?.() ?? []) if (!id || a.id === id) decorate(a) }
  ctx.on('agent/created', ({ agent }: any) => { decorate(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }: any) => { for (const d of decorated.get(agent) ?? []) { try { d() } catch {} } decorated.delete(agent) })
  ctx.on('agent/status', ({ agent, status }: any) => {
    if (status === 'running' || status === 'idle') unitOf(agent.id)?.core.onStatus(agent.id, status)
  })
  ctx.on('session/event', (session: any, event: any) => {
    try {
      if (event?.type === 'user/message' && event.data?.source?.kind === 'user') unitOf(session.id)?.core.onUserMessage(session.id, String(event.data.id), textOf(event.data))
      else if (typeof event?.type === 'string' && event.type.startsWith('compaction/') && event.type.endsWith('end')) unitOf(session.id)?.core.onCompaction(session.id, String(event.seq ?? event.time ?? Date.now()))
      // G5-F ②：宿主记下审批结果 / 工具结果 ⇒ 对应的等你点消失（补扫进来的那些没有 waterfall 的 finally，只能靠这个）
      else if (event?.type === 'approval/decided' && event.data?.id) waiting.settle(session.id, String(event.data.id))
      else if (event?.type === 'tool/result') { const cid = event.data?.message?.toolCallId; if (cid) waiting.settle(session.id, String(cid)) }
      else if (event?.type === 'turn/end') for (const w of waiting.list()) if (w.session === session.id && w.backfilled) waiting.end(w.key)
    } catch (e) { warn('session/event: %s', String(e)) }
  })

  // ---- G6-2 开张：用「dsh-master 总管」预设新建会话 ⇒ 登记项目、设为项目总管 ----
  /** 给一个不在花名册里的会话直接投一条插件消息（开张被拒时告诉它原因）。 */
  // 用 followup：会话里马上能看到（inject 要等它下一步才进上下文，新会话还没有下一步）
  const tellLoose = (sessionId: string, key: string, text: string) => ports.deliver({ to: sessionId, messageId: `${SOURCE_KIND}:${key}`, mode: 'followup', summary: '开张', text: `[dsh-master 消息 · 开张]\n${text}` }).catch(e => warn('tellLoose: %s', String(e)))
  /** 最近 50 次开张判断（调试接口 /open-log 看；宿主日志里看不到插件的告警）。 */
  const openLog: Array<{ at: string; session: string; via: string; preset: unknown; cwd: unknown; result: unknown }> = []
  async function onSessionCreated(session: any, via: 'created' | 'preset-selected' = 'created'): Promise<unknown> {
    const rec = { at: bjtIso(systemClock()), session: String(session?.id ?? ''), via, preset: session?.header?.agentPreset ?? null, cwd: session?.header?.cwd ?? null, result: null as unknown }
    openLog.push(rec); if (openLog.length > 50) openLog.shift()
    try { rec.result = await openOrRecord(session, via) } catch (e) { rec.result = { error: String((e as Error)?.message ?? e) }; throw e }
    return rec.result
  }
  async function openOrRecord(session: any, via: string): Promise<unknown> {
    const id = String(session?.id ?? ''); const preset = session?.header?.agentPreset; const cwd = session?.header?.cwd
    // 插件自己建的总管 / 成员（建之前就写进了花名册）。按花名册查、不用 unitOf：旧单元存档后 unitOf 不认旧会话，
    // 但旧总管是用总管预设建的，宿主重新加载它时还会发 session/created，不能把它当成新总管去开张（G6-5 沙盒里踩到过）
    if (!id || !cwd || unitList().some(u => u.core.roleOf(id))) return { skipped: 'roster' }
    if (preset !== MASTER_PRESET) {
      const p = registry.find(cwd); const u = p ? units.get(p.id) : undefined
      if (u) u.store.addEvent({ at: bjtIso(systemClock()), session: id, type: 'session/unenrolled', data: { cwd, preset, via } })
      // 自己选了「dsh-master 执行会话」预设：成员只能由总管 master_spawn 建，自己选预设不会进团队 ⇒ 告诉它
      if (preset === PRESET_IDS.exec) void tellLoose(id, `exec-preset:${id}`, `这个会话选了「dsh-master 执行会话」预设，但成员只能由总管用 master_spawn 建（ID 是 <项目>.<名字>），自己选预设不会加入团队，也拿不到回报工具。${u ? `它现在是项目 ${u.key} 里的未入编会话：要它干活，请到总管会话里让总管建成员。` : '这个目录还没有开张成项目。'}`)
      return { skipped: 'not-master-preset', unenrolledIn: u?.key }
    }
    const root = findProjectRoot(cwd)
    const had = registry.byRoot(root)
    if (had && had.master !== id) {
      const u = units.get(had.id)
      u?.store.addEvent({ at: bjtIso(systemClock()), session: id, type: 'project/second-master', data: { cwd, existing: had.master } })
      void tellLoose(id, `second-master:${id}`, `这个目录属于项目 ${had.id}（项目根 ${had.root}），它已经有总管 ${had.master}。这个会话**不会**被当成总管：要派活、看看板请到总管会话里；要加成员，请总管用 master_spawn。`)
      return { refused: 'second-master', project: had.id }
    }
    const owner = claimOwner(root, stateDir)
    if (owner) {
      legacy.store.addEvent({ at: bjtIso(systemClock()), session: id, type: 'project/owned-elsewhere', data: { root, owner } })
      void tellLoose(id, `owned:${id}`, `项目根 ${root} 正被另一个 dsh-master 实例（状态目录 ${owner.stateDir}）管着，这里不开张，免得两边一起写任务书。`)
      return { refused: 'owned-elsewhere', owner }
    }
    const p = registry.ensure(root, id)
    const excluded = gitExclude(root)
    try { fs.mkdirSync(path.join(projectDotDir(root), 'out'), { recursive: true }) } catch { /* 写不了就算了，成员第一次写产物时会建 */ }
    const u = openUnit(p)
    await u.core.ensureMaster(root)
    u.store.addEvent({ at: bjtIso(systemClock()), session: id, type: 'project/opened', data: { project: p.id, root, excluded: excluded ?? null } })
    decorateLive(id)
    await ensureSchedule(u).catch(e => warn('schedule %s: %s', p.id, String(e)))
    // G7 ⑧：用 followup，不用 inject。inject 要等这个会话下一步才进上下文：用户选完预设没说话的话，它一直挂在收件箱里，
    // 6 小时后跟定时保底挤进同一步，让那一步不再「全是保底消息」而叫醒模型（3090 worker 11-07 07:00）。followup 会马上跑一轮。
    u.core.systemNotify({ key: `opened:${p.id}`, to: id, mode: 'followup', label: '开张',
      text: `这个工作区已开张为项目 ${p.id}（项目根 ${root}）。你是这个项目的总管：成员用 master_spawn 建（ID 是 ${memberPrefixOf(p)}<名字>，工作目录固定是项目根）；任务书 / devlog / 手册在 ${path.join(projectDotDir(root), 'docs')}/（本机，${excluded ? '已写进 .git/info/exclude，不进 git' : '不在 git 仓库里'}）。` })
    log('开张 %s（%s，总管 %s）', p.id, root, id)
    return { opened: p.id, root, master: id }
  }
  if (config.projects !== false) ctx.on('session/created', (session: any) => { void onSessionCreated(session).catch(e => warn('开张失败：%s', String(e?.stack ?? e))) })
  // G6-5：界面上的开张流程是「新建会话（头里是默认预设 standard）→ 在模式菜单里选『dsh-master 总管』→ 发第一句话」。
  // 预设是随后单独记的一条 agent-preset/selected，不在 session/created 的头里；宿主的预设登记表会把它再广播成
  // agent-preset/selected(会话 ID, 预设)（session/event 里收不到这一条，沙盒实测）⇒ 按选中的预设再走一遍开张判断，工作目录按 ID 向宿主要
  if (config.projects !== false) ctx.on('agent-preset/selected', (sessionId: string, preset: string) => {
    void (async () => {
      const r: any = await ctx.sessionController.resolveAgent(String(sessionId))
      const s = 'error' in r ? undefined : r.agent?.session
      const cwd = s?.header?.cwd ?? await hostCwd(String(sessionId))
      await onSessionCreated({ id: String(sessionId), header: { ...(s?.header ?? {}), cwd, agentPreset: preset } }, 'preset-selected')
    })().catch(e => warn('开张失败：%s', String(e?.stack ?? e)))
  })

  // ---- G5-E ⑤ 等你点：宿主的审批 / 选择题 waterfall，排在最前面记一笔、照常交给后面的应答者 ----
  ctx.on('approval/request', (req: any, next: () => Promise<any>) => track(waiting, req?.agent?.id, 'approval', req?.toolName, next, req?.callId ? { callId: String(req.callId) } : {}), { prepend: true })
  ctx.on('user-questions/request', (req: any, next: () => Promise<any>) => track(waiting, req?.agent?.id, 'question', req?.questions?.[0]?.question, next, req?.wait?.callId ? { ref: String(req.wait.callId), callId: String(req.wait.callId) } : {}), { prepend: true })
  // G5-F ② 补扫：插件启动时，宿主说还在跑（running）的会话里「问了还没结果」的审批 / 选择题补进来。
  // 宿主正常停机会把挂着的写成 cancelled / ASK_ABORTED；被强杀的会话 running=false（再打开时宿主自己修），都不补。
  const rescanWaiting = async () => {
    const list: any = await (ctx as any).sessionController.list({}, AbortSignal.timeout(15_000))
    const items: any[] = list?.items ?? []
    let checked = 0, added = 0, skipped = 0
    for (const it of items) {
      const pend = (it.running ? await ports.pendingWaits(String(it.sessionId)).catch(() => []) : [])
      if (!it.running) { skipped++; continue }
      checked++
      for (const x of pend) { waiting.start(String(it.sessionId), x.kind, x.label, { since: x.since || systemClock(), ref: x.ref, callId: x.callId, backfilled: true }); added++ }
    }
    legacy.store.addEvent({ at: bjtIso(systemClock()), type: 'waiting/rescan', data: { sessions: items.length, running: checked, notRunning: skipped, added } })
    return { sessions: items.length, running: checked, notRunning: skipped, added }
  }
  const rescanTimer = setTimeout(() => { rescanWaiting().catch(e => warn('waiting rescan: %s', String(e))) }, pc.rescanMs ?? 3000)
  rescanTimer.unref?.()

  // ---- 自动推送回忆：已推过的（会话 → slug）不再推（按单元各记各的）----
  const fresh = (u: Unit, sid: string, slugs: string[]) => { const s = u.pushed.get(sid) ?? new Set<string>(); u.pushed.set(sid, s); return slugs.filter(x => !s.has(x)) }
  const markPushed = (u: Unit, sid: string, slugs: string[]) => { const s = u.pushed.get(sid) ?? new Set<string>(); u.pushed.set(sid, s); for (const x of slugs) s.add(x) }
  let pushSeq = 0

  // ---- 守卫 + 按文件推送前情（写之前）----
  ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<unknown>) => {
    const callerId: string | undefined = exec?.agent?.id
    const u = unitOf(callerId)
    const role = callerId && u ? u.core.roleOf(callerId) : undefined
    const cwd = exec?.agent ? cwdOf(exec.agent) : undefined
    const call = { name: exec?.name, args: exec?.arguments, role, cwd }
    // G6-4：项目成员（工作目录是项目根，不是临时 worktree）不许动 git 暂存区 / 提交 / 分支
    const noGit = !!(u?.project && role === 'exec' && callerId && !u.store.getMeta(`worktree:${callerId}`))
    const reason = guardDecision(call, { protectedPaths: protectedPaths(), allowPaths: allowPaths(), env, noGit, secretPaths })
    if (reason) {
      ;(u ?? legacy).store.addEvent({ at: bjtIso(systemClock()), session: callerId ?? null, type: 'guard/deny', data: { tool: exec?.name, reason } })
      for (const t of u && callerId && reason.includes('不提交') ? activeTasksOf(u, callerId) : []) u!.store.addEvent({ at: bjtIso(systemClock()), task: t, session: callerId!, type: 'guard/git-deny', data: { command: String(exec?.arguments?.command ?? '').slice(0, 200) } })
      return { kind: 'deny', reason }
    }
    // G6-4 软认领：成员写别人认领的文件（write / edit，bash 里能看出来的写目标）⇒ 拦下
    if (u?.project && role === 'exec' && callerId) {
      const ft = fileToolTarget(call, env.HOME)
      const cmd = exec?.arguments?.command
      const writes = ft ? [ft] : (exec?.name === 'bash' && typeof cmd === 'string' ? bashWriteTargets(cmd, cwd, env) : [])
      for (const target of writes) {
        const hit = u.core.claimHitFor(callerId, target)
        if (!hit) continue
        const why = denyText(target, hit, u.project.root)
        const at = bjtIso(systemClock())
        for (const t of new Set([hit.claim.task, ...activeTasksOf(u, callerId)])) u.store.addEvent({ at, task: t, session: callerId, type: 'claims/deny', data: { tool: exec?.name, file: relPath(u.project.root, target), claimTask: hit.claim.task, claimOwner: hit.claim.owner, claimPath: relPath(u.project.root, hit.path) } })
        return { kind: 'deny', reason: why }
      }
    }
    if (u && role && callerId && config.autoRecall?.byFile !== false) {
      const target = fileToolTarget(call, env.HOME)
      const cmd = exec?.arguments?.command
      const targets = target ? [target] : (exec?.name === 'bash' && typeof cmd === 'string' ? bashWriteTargets(cmd, cwd, env) : [])
      const push = targets.length ? u.filePush.decide(callerId, targets) : undefined
      if (push) {
        u.store.addEvent({ at: bjtIso(systemClock()), session: callerId, type: 'recall/push-file', data: { targets: push.files, slugs: push.priors.map(p => p.slug) } })
        return { kind: 'deny', reason: `${PUSH_FILE}\n你要改的 ${push.files.join('、')} 以前碰过。先看下面的前情（过去的决策 / 坑），确认不会重蹈覆辙后，原样再调用一次即可执行（同一批前情对同一个文件不会再拦第二次）：\n${u.mem.formatPriors(push.priors)}\n写 devlog 时把相关条目放进 related。` }
      }
    }
    return next()
  })

  // ---- G6-4 乐观锁：宿主文件工具报冲突（FS_STALE_VERSION / FS_NOT_OBSERVED）⇒ 记进时间线、告诉成员先重读 ----
  ctx.on('tools/post-execute', async (exec: any, result: any, next: () => Promise<any>) => {
    const decision = await next()
    try {
      if (!result?.isError || !['write', 'edit'].includes(exec?.name)) return decision
      const callerId: string | undefined = exec?.agent?.id
      const u = unitOf(callerId)
      if (!u?.project || !callerId) return decision
      const content = decision?.content ?? result.content ?? []
      const text = (Array.isArray(content) ? content : []).map((c: any) => typeof c?.text === 'string' ? c.text : '').join('\n') + ' ' + String(result?.error?.message ?? '')
      const kind = fsConflict(text)
      if (!kind) return decision
      const file = fileToolTarget({ name: exec.name, args: exec.arguments, cwd: cwdOf(exec.agent) }, env.HOME)
      const at = bjtIso(systemClock())
      for (const t of activeTasksOf(u, callerId)) u.store.addEvent({ at, task: t, session: callerId, type: 'fs/conflict', data: { kind, tool: exec.name, file: file ? relPath(u.project.root, file) : null } })
      return { ...decision, kind: decision?.kind ?? 'accept', content: [...(Array.isArray(content) ? content : []), { type: 'text', text: CONFLICT_HINT[kind] }] }
    } catch (e) { warn('post-execute: %s', String(e)); return decision }
  })

  // ---- 按话题推送前情（每步开始前，插进这一步的消息里）----
  /** G7 ⑤：旧单元存档后，旧会话还以为自己是总管 / 成员（11-07 旧总管说「工具链断了，要重启吗」）。用户第一次跟它说话时，
   *  在这一步末尾加一条说明（同一轮里就看得到，不用多跑一轮）；每个会话只说一次（记在旧单元库的 meta 里，重启后也不重复）。 */
  const archivedNotice = (id: string, decision: any) => {
    const msgs: any[] = decision.messages ?? []
    if (!msgs.some(m => m?.role === 'user' && m?.source?.kind === 'user')) return decision
    const key = `archived-notice:${id}`
    if (legacy.store.getMeta(key)) return decision
    const at = bjtIso(systemClock())
    legacy.store.setMeta(key, at)
    const role = legacy.core.roleOf(id)
    const projects = registry.list()
    legacy.store.addEvent({ at, session: id, type: 'legacy/notice', data: { role, projects: projects.map(p => p.id) } })
    const since = legacy.store.getMeta('archived_at') ?? '部署 G6-5 时'
    const list = projects.length ? projects.map(p => `- 项目 ${p.id}（根目录 ${p.root}）：总管是会话 ${p.master}`).join('\n') : '- 现在还没有开张的项目。'
    const text = `[dsh-master 消息 · 旧单元已存档]
这个会话属于 dsh-master 的旧单元（旧的全局${role === 'master' ? '总管' : '执行会话'}）。旧单元已在 ${since} 存档（只读），以后只用「每个项目一个总管」：
- 你现在${role === 'master' ? '不是总管' : '不是任何总管的成员'}，没有 master_* 工具，插件也不再给你投递、提醒、定时巡检。这不是故障，重启实例也不会恢复，不要建议重启，也不要去翻插件源码或想办法绕过守卫。
- 现在的项目和总管：
${list}
- 请把这件事直接告诉用户：要派活，到对应项目的总管会话里说；某个目录还没有总管，就在那个工作区新建会话、在模式菜单里选「dsh-master 总管」，发第一句话就开张。这个旧会话留着可以翻历史。`
    const msg = deepFreeze(structuredClone({ id: `${SOURCE_KIND}:archived-notice:${id}`, role: 'user', content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'notice', summary: '旧单元已存档' } }))
    return { ...decision, messages: [...msgs, msg] }
  }
  ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    let decision = await next()
    try {
      const agent = payload?.agent
      const u = unitOf(agent?.id)
      // G7 ⑤：存档后的旧单元会话（旧总管 / 旧成员）第一次收到用户消息时，在这一步里告诉它已经存档、新总管在哪（只说一次）
      if (!u && agent && decision?.kind === 'enter' && legacyArchived && legacy.core.roleOf(agent.id)) return archivedNotice(agent.id, decision)
      if (decision?.kind !== 'enter' || !agent || !u) return decision
      let msgs: any[] = decision.messages ?? []
      // 定时巡检保底到了：插件先自己跑一遍巡检（不调模型），没有发现就跳过这一步（无论有没有配模型都不会报失败）
      if (agent.id === u.core.masterId && msgs.some(m => m?.source?.kind === 'schedule')) {
        // G8：暂停中定时保底不该再来（暂停时删掉了）；万一来了（删之前已排上的）也不叫醒模型
        if (pausedInfo(u.store) && scheduleStep(msgs.map(m => ({ kind: m?.source?.kind, form: m?.source?.form, text: textOf(m) })), 0) === 'skip') {
          u.store.addEvent({ at: bjtIso(systemClock()), session: u.core.masterId, type: 'patrol/schedule-paused', data: { messages: msgs.length } })
          return { kind: 'reject' }
        }
        // G7 ⑧：只数总管还没见过的发现（和上次报过的一样就算 0）
        const unseen = u.patrol.unseenForSchedule()
        if (scheduleStep(msgs.map(m => ({ kind: m?.source?.kind, form: m?.source?.form, text: textOf(m) })), unseen.count) === 'skip') {
          u.store.addEvent({ at: bjtIso(systemClock()), session: u.core.masterId, type: 'patrol/schedule-quiet', data: { messages: msgs.length } })
          return { kind: 'reject' }
        }
        if (unseen.count) u.patrol.markScheduleSeen(unseen.sig)
      }
      // G4c：@任务 / @执行会话 / 插件转来的消息 → 归属 + 附上库里的状态
      try {
        const res = u.attrib.processStep(agent.id, Number(payload?.turn), msgs)
        if (res.changed) { msgs = res.messages; decision = { ...decision, messages: msgs } }
      } catch (e) { warn('pre-step mentions: %s', String(e)) }
      if (config.autoRecall?.byTopic === false) return decision
      const text = msgs.filter((m: any) => !(m?.source?.kind === SOURCE_KIND && m?.source?.form === 'notice')).map(textOf).join('\n')
      // 这一步里已经点名的条目（比如回报里刚写的 devlog）不再原样推回去
      const priors = topicPriors(u.mem.relatedForText(text, 5, new Set(u.store.listSessions().map(x => x.id.toLowerCase()))), text).filter(p => fresh(u, agent.id, [p.slug]).length)
      if (!priors.length) return decision
      markPushed(u, agent.id, priors.map(p => p.slug))
      u.store.addEvent({ at: bjtIso(systemClock()), session: agent.id, type: 'recall/push-topic', data: { slugs: priors.map(p => p.slug), reasons: priors.map(p => p.reason) } })
      const msg = deepFreeze(structuredClone({ id: `${SOURCE_KIND}:push:${agent.id}:${Date.now()}:${++pushSeq}`, role: 'user',
        content: [{ type: 'text', text: `${PUSH_TOPIC}\n这一步提到的东西以前碰过（要动它们之前先看；需要更多用 devlog_recall）：\n${u.mem.formatPriors(priors)}` }],
        source: { kind: SOURCE_KIND, form: 'notice', summary: `相关前情 ${priors.length} 条` } }))
      return { ...decision, messages: [...decision.messages, msg] }
    } catch (e) { warn('pre-step push: %s', String(e)); return decision }
  })

  // ---- 心跳：投递、重活；巡检（每个单元各跑各的）----
  const timer = setInterval(() => {
    for (const u of liveUnits()) void u.delivery.pump().catch(e => warn('pump %s: %s', u.key, String(e)))
    try { heavy.tick() } catch (e) { warn('heavy: %s', String(e)) }
  }, config.pumpIntervalMs ?? 2000)
  ctx.effect(() => () => clearInterval(timer))
  const patrolTimer = setInterval(() => { for (const u of liveUnits()) { try { if (pausedInfo(u.store)) u.patrol.backup(); else u.patrol.tick() } catch (e) { warn('patrol %s: %s', u.key, String(e)) } } }, pc.intervalMs ?? 600_000) // G8：暂停中只备份，不给总管发巡检消息
  ctx.effect(() => () => clearInterval(patrolTimer))
  // 启动后先做当天的备份（只备份、不巡检）：新装的实例、频繁重启的实例也不会一直没有备份
  const firstBackup = setTimeout(() => { for (const u of liveUnits()) { try { u.patrol.backup() } catch (e) { warn('backup %s: %s', u.key, String(e)) } } }, pc.firstBackupMs ?? 60_000)
  firstBackup.unref?.()
  ctx.effect(() => () => clearTimeout(firstBackup))

  // ---- 总管会话、已在内存里的会话（热替换后）、重启恢复、定时巡检保底 ----
  const masterCwd = path.resolve(config.masterCwd ?? path.join(stateDir, 'master-workspace'))
  /** 启动流程（总管会话、恢复、定时保底、旧单元存档）走完了没有（测试的就绪判据用）。 */
  const startup = { ready: false }
  const startedAt = Date.now()
  /** 宿主的定时服务：刚启动时可能还没注册好 ⇒ 等它（最多 60 秒），不再拿不到就悄悄跳过。 */
  let scheduleRef: any // G10：拿到过的定时服务（插件停用时 ctx 可能已经不能 get，用这份删定时保底）
  const scheduleService = () => waitService<any>(() => (config.fakeScheduleDelayMs && Date.now() - startedAt < config.fakeScheduleDelayMs) ? undefined : ctx.get?.('schedule'),
    { timeoutMs: config.fakeScheduleDelayMs ? config.fakeScheduleDelayMs + 30_000 : 60_000 }).then(x => { if (x) scheduleRef = x; return x })
  // ---- G10：卸载 / 取消选择 / 关掉这一行 ⇒ 删掉自己建的定时保底；重启、热重载（profile 还选着）⇒ 保留 ----
  // 不删的话，宿主的定时任务会在插件不在时照样把巡检消息发给总管会话（叫醒模型，却没有 master_patrol 工具）
  const profileDir: string | undefined = (() => { try { return ctx.profileContext?.dir ?? ctx.get?.('profileContext')?.dir } catch { return undefined } })()
  const ownName = (() => { try { return String(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name || 'dsh-master') } catch { return 'dsh-master' } })()
  ctx.effect(() => () => {
    if (stillSelected(profileDir, ownName, 'dsh-master') !== false) return
    const sched = scheduleRef
    const masters = new Set(unitList().map(u => u.core.masterId))
    if (!sched) return
    log('插件被卸载或关闭：删掉定时保底（%s）', [...masters].join(','))
    void (async () => {
      for (const c of await sched.catalog()) {
        if (!masters.has(c.sessionId) || !String(c.title ?? '').startsWith('dsh-master 定时巡检保底')) continue
        try { await sched.delete({ sessionId: c.sessionId, id: c.id }) } catch (e) { warn('卸载时删定时保底 %s：%s', c.id, String(e)) }
      }
    })().catch(e => warn('卸载时删定时保底：%s', String(e)))
  })
  ;(!legacyLive ? Promise.resolve() : legacy.core.ensureMaster(masterCwd)).then(async () => {
    for (const u of unitList().filter(x => x.project)) { try { await u.core.ensureMaster(u.project!.root) } catch (e) { warn('项目 %s 的总管：%s', u.key, String(e)) } }
    decorateLive()
    heavy.recover()
    let n = 0
    for (const u of liveUnits()) { n += u.core.recover(); u.core.renderBoard(); await ensureSchedule(u).catch(e => warn('schedule %s: %s', u.key, String(e))) }
    if (legacyArchived) await archiveLegacy().catch(e => warn('旧单元存档：%s', String(e)))
    startup.ready = true
    log('ready: stateDir=%s units=%s recovered=%d legacy=%s', stateDir, unitList().map(u => u.key).join(','), n, legacyMode)
  }).catch(e => warn('ensureMaster 失败：%s', String(e?.stack ?? e)))

  /** G6-5：旧单元存档后删掉旧总管的定时保底（每次启动都看一遍，删过就没了）；记一条事件，只记一次。 */
  async function archiveLegacy(): Promise<void> {
    const { removed, sched } = await removeSchedule(legacy)
    const pending = legacy.store.deliveriesByState('pending').length
    if (removed.length || !legacy.store.getMeta('archived_at')) {
      const at = bjtIso(systemClock())
      if (!legacy.store.getMeta('archived_at')) legacy.store.setMeta('archived_at', at)
      legacy.store.addEvent({ at, type: 'legacy/archived', data: { scheduleRemoved: removed, pending, marker: fs.existsSync(archiveMarker), scheduleService: !!sched } })
    }
  }
  /** 删掉这个单元总管的定时保底（按会话 + 标题认，旧单元存档、G8 暂停共用）。 */
  async function removeSchedule(u: Unit): Promise<{ removed: string[]; sched: any }> {
    const sched = await scheduleService()
    const removed: string[] = []
    if (sched) {
      for (const c of await sched.catalog()) {
        if (c.sessionId !== u.core.masterId || !String(c.title ?? '').startsWith('dsh-master 定时巡检保底')) continue
        const r = await sched.delete({ sessionId: c.sessionId, id: c.id })
        if (r?.deleted) removed.push(String(c.id))
      }
    }
    return { removed, sched }
  }
  /** G8：暂停信息给守则 / 看板看（时间换成北京时间的「YYYY-MM-DD HHMM」）。 */
  function pausedView(u: Unit): { at: string; by: string; reason?: string } | undefined {
    const p = pausedInfo(u.store)
    return p ? { at: bjtStamp(Date.parse(p.at)), by: p.by, ...(p.reason ? { reason: p.reason } : {}) } : undefined
  }
  /** G8：暂停项目总管。by = 'user'（看板）或总管会话 ID（master_pause）。 */
  async function pauseUnit(u: Unit, by: string, reason?: string): Promise<Record<string, unknown>> {
    if (!u.project) throw new PanelError('bad_state', '旧单元不能暂停')
    const had = pausedInfo(u.store)
    if (had) return { paused: true, already: true, at: had.at }
    const at = bjtIso(systemClock())
    setPaused(u.store, { at, by, ...(reason ? { reason } : {}) })
    const { removed } = await removeSchedule(u)
    u.store.addEvent({ at, session: u.core.masterId, type: 'project/paused', data: { by, reason: reason ?? null, scheduleRemoved: removed } })
    try { u.core.renderBoard() } catch { /* 看板文件写不了不影响暂停 */ }
    log('暂停项目 %s（%s）', u.key, by)
    return { paused: true, at, scheduleRemoved: removed }
  }
  /** G8：恢复：清掉暂停、重建定时保底（已有就不重复建）。 */
  async function resumeUnit(u: Unit, by: string): Promise<Record<string, unknown>> {
    if (!u.project) throw new PanelError('bad_state', '旧单元不能暂停 / 恢复')
    const had = pausedInfo(u.store)
    if (!had) return { resumed: false, notPaused: true }
    setPaused(u.store, undefined)
    const at = bjtIso(systemClock())
    u.store.addEvent({ at, session: u.core.masterId, type: 'project/resumed', data: { by, pausedAt: had.at } })
    await ensureSchedule(u).catch(e => warn('schedule %s: %s', u.key, String(e)))
    try { u.core.renderBoard() } catch { /* 同上 */ }
    log('恢复项目 %s（%s）', u.key, by)
    return { resumed: true, at }
  }
  async function ensureSchedule(u: Unit): Promise<void> {
    const every = config.scheduleEverySeconds ?? 21600
    if (!every) return
    if (pausedInfo(u.store)) return // G8：暂停中不建（恢复时再建）
    const sched = await scheduleService()
    if (!sched) { u.store.addEvent({ at: bjtIso(systemClock()), session: u.core.masterId, type: 'schedule/unavailable', data: { every } }); return }
    const want = `dsh-master 定时巡检保底（每 ${every} 秒）`
    const cat = await sched.catalog()
    if (cat.some((c: any) => c.sessionId === u.core.masterId && c.title === want && c.status !== 'inactive')) return
    const rec = await sched.create(u.core.masterId, { title: want, every_seconds: every,
      prompt: '【这是 dsh-master 的定时巡检保底消息，不是用户说的】请调用 master_patrol 看一眼有没有停滞、投递失败、待用户定、带外改动；没有就直接结束本轮，不要回复用户。' })
    u.store.setMeta('schedule_id', String(rec?.id ?? ''))
    u.store.addEvent({ at: bjtIso(systemClock()), session: u.core.masterId, type: 'schedule/created', data: { id: rec?.id, every } })
  }

  // ---- 面板接口：只挂 connection.fetch（/api，DSH owner 认证；手机经 dsh-pocket 也是 owner），不放进无鉴权的 webServer ----
  // G6-2：带 ?project=<ID> 就看那个项目，不带就是旧单元（看板按项目显示在 G6-3）
  const reply = (code: number, v: unknown) => new Response(JSON.stringify(v), { status: code, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
  const failed = (e: unknown) => e instanceof PanelError ? reply(e.code === 'not_found' ? 404 : 400, { error: e.message, code: e.code }) : reply(500, { error: String((e as Error)?.message ?? e) })
  const unitByQuery = (q: URLSearchParams): Unit => { const p = q.get('project'); if (!p) return legacy; const u = units.get(p); if (!u || !u.project) throw new PanelError('not_found', `没有项目 ${p}`); return u }
  // G6-3：看板按「当前会话」选单元：花名册里的 ⇒ 它的单元；不在花名册里（未入编）⇒ 按它的 cwd 找项目；都不是 ⇒ 旧单元
  let hostCwds = { at: 0, map: new Map<string, string>() }
  const hostCwd = async (sid: string): Promise<string | undefined> => {
    if (Date.now() - hostCwds.at > 5000 || !hostCwds.map.has(sid)) {
      try { const res: any = await (ctx as any).sessionController.list({}, AbortSignal.timeout(5_000)); hostCwds = { at: Date.now(), map: new Map((res?.items ?? []).map((x: any) => [String(x.sessionId), String(x.cwd ?? '')])) } } catch { /* 拿不到就当不在项目里 */ }
    }
    return hostCwds.map.get(sid) || undefined
  }
  const unitForSession = async (sid: string): Promise<Unit> => {
    const u = unitOf(sid); if (u) return u
    const cwd = await hostCwd(sid)
    if (cwd) { try { const p = registry.find(cwd); const pu = p ? units.get(p.id) : undefined; if (pu) return pu } catch { /* 目录没了 */ } }
    return legacy
  }
  const unitFor = async (q: URLSearchParams): Promise<Unit> => q.get('project') ? unitByQuery(q) : q.get('session') ? unitForSession(q.get('session')!) : legacy
  const projectList = () => unitList().filter(u => u.project).map(u => ({ id: u.project!.id, root: u.project!.root, master: u.project!.master }))
  const getRoute = (p: string, fn: (q: URLSearchParams) => Promise<unknown> | unknown) => ctx.effect(() => ctx.connection.fetch.register({ path: p, methods: ['GET'], requestBody: 'buffered',
    fetch: async (req: Request) => { try { return reply(200, await fn(new URL(req.url).searchParams)) } catch (e) { return failed(e) } } }))
  const waitingView = async (u: Unit) => {
    const list = waiting.list().filter(w => { const o = unitOf(w.session); return u.project ? o === u : (!o || o === u) })
    // 不在花名册里的会话才去问宿主要标题（宿主列表里有 projections.values.title）
    let host = new Map<string, string>()
    if (list.some(w => !u.store.getSession(w.session))) {
      try { const res: any = await (ctx as any).sessionController.list({}, AbortSignal.timeout(5_000)); host = new Map((res?.items ?? []).map((x: any) => [String(x.sessionId), String(x.projections?.values?.title ?? '')])) } catch { /* 拿不到就用兜底名字 */ }
    }
    return list.map(w => ({ session: w.session, title: waitTitle(w.session, u.store.getSession(w.session)?.title, host.get(w.session)), kind: w.kind, label: w.label, since: bjtStamp(w.since), minutes: Math.floor((systemClock() - w.since) / 60_000), ...(w.backfilled ? { backfilled: true } : {}) }))
  }
  getRoute('/api/dsh-master/state', async q => {
    const u = await unitFor(q); const sid = q.get('session')
    // 这个会话不在任何项目、也不在旧花名册里，而且已经有项目开张了 ⇒ 告诉用户这里还没开张（只有旧单元时不提示，和以前一样）
    const notOpened = !!sid && !u.project && !legacy.core.roleOf(sid) && projectList().length > 0
    return { waiting: await waitingView(u), ...(u.panel.state({ view: q.get('view') ?? undefined, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined })), sessions: u.panel.sessionsView(),
      master: u.core.masterId, ...(u.project ? { project: { id: u.project.id, root: u.project.root, master: u.project.master } } : {}),
      unenrolled: u.project ? u.panel.unenrolled() : [], gateIndex: u.panel.gateIndex(), askIndex: u.panel.askIndex(), notOpened, projects: notOpened ? projectList() : [],
      ...(u.project && pausedInfo(u.store) ? { paused: pausedView(u) } : {}),
      ...(u === legacy && legacyArchived ? { archived: { at: (x => x ? bjtStamp(Date.parse(x)) : null)(legacy.store.getMeta('archived_at')) } } : {}) }
  })
  getRoute('/api/dsh-master/thread', async q => (await unitFor(q)).panel.thread(q.get('task') || null))
  getRoute('/api/dsh-master/sessions', async q => (await unitFor(q)).panel.sessionsView())
  getRoute('/api/dsh-master/projects', () => ({ projects: projectList(), legacyMaster: legacyMode === 'off' ? null : legacy.core.masterId }))
  // 会话标题栏按钮 / 左侧入口用：这个会话是谁、归哪个总管
  getRoute('/api/dsh-master/whoami', async q => { const sid = q.get('session') ?? ''; const u = await unitForSession(sid); return { role: u.core.roleOf(sid) ?? null, master: u.core.masterId, project: u.project?.id ?? null } })
  // 用户消息里的 G / Q 标签用：只给编号表（闸门标题 / 状态 / 产物、Q 问题），不给正文
  getRoute('/api/dsh-master/refs', async q => { const u = await unitFor(q); return { master: u.core.masterId, project: u.project?.id ?? null, gateIndex: u.panel.gateIndex(), askIndex: u.panel.askIndex() } })
  // @ 菜单候选（按会话：总管列全部未结 + 近 7 天，执行会话只列派给它的，不在花名册的不列）与每轮末尾小标签 —— 按会话所属的单元
  getRoute('/api/dsh-master/candidates', q => { const s = q.get('session') ?? ''; const u = unitOf(s); return { tasks: u ? u.attrib.candidatesFor(s) : [] } })
  getRoute('/api/dsh-master/turn', q => { const s = q.get('session') ?? ''; return (unitOf(s) ?? legacy).panel.turnFull(s, Number(q.get('turn'))) })
  getRoute('/api/dsh-master/turns', q => { const s = q.get('session') ?? ''; const u = unitOf(s); return { turns: u ? u.attrib.turnsOf(s) : [] } })
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-master/action', methods: ['POST'], requestBody: 'buffered', fetch: async (req: Request) => {
    const bad = checkPost(req); if (bad) { await drain(req, PANEL_LIMITS.actionBytes); return reply(403, { error: bad, code: 'forbidden' }) }
    const raw = await readLimited(req, PANEL_LIMITS.actionBytes); if (raw === 'too_large') return reply(413, { error: '请求体太大', code: 'too_large' })
    let body: unknown; try { body = JSON.parse(raw.toString('utf8')) } catch { return reply(400, { error: '不是合法 JSON', code: 'bad_json' }) }
    const a = validateAction(body); if ('error' in a) return reply(400, { error: a.error, code: 'bad_action' })
    try {
      const u = await unitFor(new URL(req.url).searchParams)
      if (u === legacy && legacyArchived) return reply(409, { error: '旧单元已存档（只读），不能再改', code: 'archived' })
      if (u === legacy && legacyMode === 'off') return reply(409, { error: '没有启用旧单元：先用「dsh-master 总管」预设新建会话开张一个项目', code: 'legacy-off' })
      if (a.action === 'pause') return reply(200, { ok: true, ...await pauseUnit(u, 'user', a.reason) })
      if (a.action === 'resume') return reply(200, { ok: true, ...await resumeUnit(u, 'user') })
      return reply(200, await u.panel.act(a))
    } catch (e) { return failed(e) }
  } }))

  if (config.debugControl) registerDebug(ctx, { units, legacy, unitOf, ports, heavy, registry, waiting, rescanWaiting, onSessionCreated, startup, openLog })
}

/** 测试驱动接口：只认 127.0.0.1 / localhost，配置里显式打开才有。?project=<ID> 选项目单元，不带就是旧单元。 */
function registerDebug(ctx: any, d: { units: Map<string, Unit>; legacy: Unit; unitOf: (s?: string) => Unit | undefined; ports: DshPorts; heavy: HeavyQueue; registry: ProjectRegistry; waiting: WaitingTracker; rescanWaiting: () => Promise<unknown>; onSessionCreated: (s: any) => Promise<unknown>; startup: { ready: boolean }; openLog: unknown[] }): void {
  const { waiting, rescanWaiting, ports } = d
  const json = (res: ServerResponse, code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(v)) }
  const body = (req: IncomingMessage) => new Promise<any>((ok, bad) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 131072) bad(new Error('too big')) }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}) } catch (e) { bad(e) } })
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-master-debug', handler: async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { error: 'loopback only' })
      const url = new URL(req.url ?? '/', 'http://x'); const p = url.pathname.slice('/dsh-master-debug'.length)
      const pj = url.searchParams.get('project')
      const u = pj ? d.units.get(pj) : d.legacy
      if (!u) return json(res, 404, { error: `没有项目 ${pj}` })
      const { core, store, mem, patrol } = u
      if (p === '/state') return json(res, 200, core.snapshot())
      if (p === '/ready') return json(res, 200, { ready: d.startup.ready })
      if (p === '/open-log') return json(res, 200, d.openLog)
      if (p === '/projects') return json(res, 200, { registry: d.registry.list(), units: [...d.units.keys()] })
      if (p === '/patrol') return json(res, 200, { result: patrol.tick(), findings: patrol.findings() })
      if (p === '/schedules') return json(res, 200, await ctx.get?.('schedule')?.catalog?.() ?? null)
      if (p === '/mem') return json(res, 200, { devlog: mem.listDevlog().map(r => mem.indexLine(r)), memories: mem.listMemories(), check: mem.check(), docs: mem.docs.root })
      if (p === '/events') return json(res, 200, store.events({ type: url.searchParams.get('type') ?? undefined }).map(e => ({ ...e, data: JSON.parse(e.data) })))
      if (p === '/heavy') return json(res, 200, d.legacy.store.heavyJobs())
      if (p === '/waiting') return json(res, 200, waiting.list())
      if (p === '/waiting-rescan') { for (const w of waiting.list()) if (w.backfilled) waiting.end(w.key); return json(res, 200, { result: await rescanWaiting(), waiting: waiting.list() }) }
      if (p === '/waiting-forget') { for (const w of waiting.list()) waiting.end(w.key); return json(res, 200, { ok: true }) } // 模拟插件刚启动、记录器是空的
      if (p === '/host-sessions') return json(res, 200, await (ctx as any).sessionController.list({}, AbortSignal.timeout(10_000)))
      if (p === '/status') return json(res, 200, { [core.masterId]: ports.status(core.masterId), ...Object.fromEntries(store.listSessions().map(s => [s.id, ports.status(s.id)])) })
      if (p === '/history') {
        const sid = url.searchParams.get('sessionId') ?? core.masterId
        const out: unknown[] = []
        await ctx.sessionPersistence.flush()
        const h = await ctx.sessionPersistence.open(sid, 'read')
        try {
          for (let o = 0; ;) { const { events } = await h.read(o, 512); if (!events.length) break
            for (const e of events) {
              if (e.type === 'user/message') out.push({ type: e.type, id: e.data?.id, source: e.data?.source?.kind, text: (e.data?.content ?? []).map((c: any) => c.text ?? '').join('') })
              else if (e.type === 'assistant/message') out.push({ type: e.type, text: (e.data?.message?.content ?? []).map((c: any) => c.text ?? '').join('') })
              else if (e.type === 'tool/call' || e.type === 'tool/result') out.push({ type: e.type, data: JSON.stringify(e.data).slice(0, 600) })
            }
            o += events.length }
        } finally { if (typeof h[Symbol.asyncDispose] === 'function') await h[Symbol.asyncDispose](); else await h.close?.() }
        return json(res, 200, out)
      }
      if (req.method !== 'POST') return json(res, 405, {})
      if (p === '/redeliver') { // 绕过库直接再投一次已投过的消息：验证 DSH 侧按消息 ID 去重
        const b = await body(req)
        const dl = store.getDelivery(b.key)
        if (!dl) return json(res, 404, { error: 'no such delivery' })
        return json(res, 200, { result: await ports.deliver({ to: dl.to_id, messageId: `dsh-master:${dl.key}`, text: dl.text, mode: dl.mode, summary: dl.summary }) })
      }
      if (p === '/create') { // 建一个会话（不在花名册里）。带 preset 时用那个预设（dsh-master-master ⇒ 开张）
        const b = await body(req)
        const ws = await ctx.workspaceRegistry.create(b.cwd)
        const v = await ctx.sessionController.create({ sessionId: b.id, workspaceId: ws.id, ...(b.preset ? { agentPreset: b.preset } : {}) })
        return json(res, 200, v)
      }
      if (p === '/select-preset') { // 照界面的做法：在还没开始第一轮的会话上切预设（宿主记一条 agent-preset/selected）
        const b = await body(req)
        const r = await ctx.sessionController.resolveAgent(b.sessionId)
        if ('error' in r) return json(res, 404, { error: r.error?.code })
        const presets = ctx.get?.('agentPresets')
        if (!presets?.select) return json(res, 500, { error: 'agentPresets 服务不在' })
        return json(res, 200, { selected: await presets.select(r.agent, b.preset) })
      }
      if (p === '/prompt') {
        const b = await body(req)
        const v = await ctx.sessionController.prompt({ requestId: b.requestId ?? `dbg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, sessionId: b.sessionId, mode: b.mode ?? 'queue', content: [{ type: 'text', text: b.text }] }, AbortSignal.timeout(30_000))
        return json(res, 200, v)
      }
      return json(res, 404, { p })
    } catch (e: any) { return json(res, 500, { error: String(e?.message ?? e) }) }
  } }))
}
