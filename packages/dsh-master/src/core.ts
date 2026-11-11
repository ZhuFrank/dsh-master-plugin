/**
 * 总管业务核心：花名册、按角色的工具、派活 / 回报 / 验收、空闲没回报的兜底。
 * 不直接碰 DSH：DSH 的会话操作经 SessionPort，投递经 Delivery。便于在单测里用假实现。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Store, Role, TaskRow } from './store.ts'
import { Delivery, DeliveryError } from './delivery.ts'
import { bjtIso, bjtStamp, type Clock } from './time.ts'
import { MemoryLayer, MemoryInputError, memoryTools } from 'dsh-master-devlog'
import { execFileSync } from 'node:child_process'
import { normClaims, conflictsWith, claimHit, rel, type Claim } from './claims.ts'
import { pausedInfo } from './pause.ts'

/**
 * G7 ①：闸门字段归一成编号。成员常把标题一起写进 gate（「G1 — 写清单」），状态没错，但数据里同一个闸门成了两种写法。
 * 认 G 后面的编号（G1、G6-1、G6a、G4b），后面的标题去掉；不是 G 开头的原样（去首尾空白）。
 */
export function normGate(g: string | undefined): string | undefined {
  const t = g?.trim()
  if (!t) return undefined
  const m = t.match(/^[Gg](\d+)(-\d+)?([a-zA-Z])?(?=$|[^0-9A-Za-z])/)
  return m ? `G${m[1]}${m[2] ?? ''}${(m[3] ?? '').toLowerCase()}` : t
}

export const MASTER_ID = 'master'
export const SYSTEM_ID = 'dsh-master'
export const EXEC_PREFIX = 'exec-'
export const REPORT_STATES = ['进展', '等待', '受阻', '失败', '就绪', '完成'] as const
export type ReportState = (typeof REPORT_STATES)[number]
const ACTIVE_TASK_STATES = new Set(['进行中', '打回', '等待'])
/** 终态：总管验收 final（或以后的取消）之后，执行会话的任何回报都不能再改任务状态（状态机单向）。 */
export const TERMINAL_TASK_STATES = new Set(['完成', '取消'])

export type LiveStatus = 'running' | 'idle' | 'cold'
export interface SessionPort {
  /** preset：权限预设（G6-4 项目成员默认「工作区内修改」）；不给就用插件配置的默认值。 */
  ensureSession(input: { id: string; cwd: string; title: string; role: Role; preset?: string | undefined }): Promise<void>
  status(id: string): LiveStatus
  lastAssistantText(id: string): Promise<string | undefined>
}

export interface JsonSchema { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
export interface ToolSpec { name: string; description: string; parameters: JsonSchema; run(args: unknown, caller: string): Promise<unknown> }

export class ToolInputError extends Error {}

export interface HeavyRunner { submit(input: { session: string; label: string; command: string; cwd: string; minFreeGb: number }): Promise<unknown> }
export interface CoreOptions {
  /** G4c：master_tag 的实现（归属在 attrib.ts）。 */
  tag?: (caller: string, args: Record<string, unknown>) => unknown
  /** G5：master_doctor 的实现（doctor.ts）。 */
  doctor?: () => unknown
  /** G8：master_pause 的实现（入口里删定时保底、记事件；只给项目单元）。 */
  pause?: (caller: string, reason: string) => unknown
  idleGraceMs: number
  /** G6-1：这个项目的总管会话 ID（不给就是旧的单总管 'master'）。 */
  masterId?: string
  /** G6-1：成员会话 ID 前缀（不给就是旧的 'exec-'；项目制下是 `<项目>.`）。 */
  memberPrefix?: string
  /** G6-2：项目根（项目制下成员的 cwd 固定是它；不给就是旧行为，master_spawn 要自己给 cwd）。 */
  projectRoot?: string
  /** G7 ④：项目总管的权限预设（入口按配置 projectMasterPreset 传，默认完全权限）。不设 ⇒ 用插件的 permissionPreset（旧单元）。 */
  masterPreset?: string | undefined
  /** G6-4：项目成员的权限预设（默认 workspace-write，产物放 <根>/.dsh-master/out/，往外写会弹等你批）。 */
  memberPreset?: string
  timer?: (fn: () => void, ms: number) => () => void
  /** 记忆层（devlog / 决策 / 记忆 / 受管文件）。不给就没有记忆、任务书、手册工具（G2 单测用）。 */
  mem?: MemoryLayer
  /** 巡检（master_patrol 工具用）。 */
  patrol?: () => Promise<{ findings: Array<{ key: string; text: string }> }>
  heavy?: HeavyRunner
  /** G11-1 消息直送（默认开）：用户在成员会话里开的那一轮不发空闲提醒；看板「回答等你定」直投负责成员；巡检报「直接对话」。false ⇒ 旧行为。 */
  directToMember?: boolean
}
/** G11-1：用户消息和「开始跑」相差多少毫秒以内，算这一轮是用户开的（宿主两个事件先后不定）。 */
export const USER_TURN_WINDOW_MS = 10_000
export const HANDBOOK_SECTIONS = ['标准做法', '坑', '工具与素材', '用户偏好与否决过的做法', '还没想清楚的', '做过的任务'] as const
export const SPEC_SECTIONS = ['目标', '要读的', '交付物', '验收标准', '红线'] as const
export interface SpecMeta { file: string; title: string; expected: string; output: string; resume: string; start?: string; writtenAt?: string; caller?: string; body?: Record<string, string> }
/** 正文 / 回报里以 # 开头的行加转义：渲染出来的任务书里只有插件写的那几个标题是真标题。 */
export function escapeHeadings(text: string): string { return text.replace(/^(\s*)(#{1,6}\s)/gm, '$1\\$2') }

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)

function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ToolInputError('参数必须是对象')
  return v as Record<string, unknown>
}
function str(a: Record<string, unknown>, key: string, opt: { required?: boolean; max?: number; pattern?: RegExp; hint?: string } = {}): string | undefined {
  const v = a[key]
  if (v === undefined || v === null || v === '') {
    if (opt.required) throw new ToolInputError(`缺少参数 ${key}`)
    return undefined
  }
  if (typeof v !== 'string') throw new ToolInputError(`参数 ${key} 必须是字符串`)
  const t = v.trim()
  if (opt.required && !t) throw new ToolInputError(`参数 ${key} 不能为空`)
  if (opt.max && t.length > opt.max) throw new ToolInputError(`参数 ${key} 太长（${t.length} > ${opt.max}）`)
  if (opt.pattern && !opt.pattern.test(t)) throw new ToolInputError(`参数 ${key} 格式不对：${opt.hint ?? opt.pattern}`)
  return t
}
const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra })
const schema = (properties: Record<string, unknown>, required: string[]): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false })

const TASK_ID = /^(T\d{3,}|L\d{4}-\d+)$/
/** 闸门编号：G1、G6a、G6-1。 */
export const GATE_ID = /^G\d+(?:[a-z]|-\d+)?$/
export const GATE_TITLE_MAX = 20
export interface GateDef { gate: string; title: string; produces: string }
/** task_spec_write 的 gates 参数：至少一个；编号不重复；标题 1–20 字（按字符数，不按字节）；产物可空。 */
export function parseGates(v: unknown): GateDef[] {
  if (!Array.isArray(v) || !v.length) throw new ToolInputError('gates 至少写一个闸门：[{ id: "G1", title: "≤20 字短标题", produces: "产物路径或说明" }]')
  const seen = new Set<string>()
  return v.map((x, i) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const gate = String(o.id ?? '').trim(), title = String(o.title ?? '').replace(/\s+/g, ' ').trim(), produces = String(o.produces ?? '').trim()
    if (!GATE_ID.test(gate)) throw new ToolInputError(`gates[${i}].id 要像 G1、G6a、G6-1：${JSON.stringify(gate)}`)
    if (seen.has(gate)) throw new ToolInputError(`闸门 ${gate} 重复了`)
    seen.add(gate)
    const n = Array.from(title).length
    if (!n) throw new ToolInputError(`闸门 ${gate} 要有标题`)
    if (n > GATE_TITLE_MAX) throw new ToolInputError(`闸门 ${gate} 的标题 ${n} 个字，超过 ${GATE_TITLE_MAX} 字，写短一点（只写这一闸门做什么，像「数据层」「开张与团队」）：${title}`)
    if (produces.length > 300) throw new ToolInputError(`闸门 ${gate} 的产物写得太长（>300 字），只写路径或一句话`)
    return { gate, title, produces }
  })
}
const NAME = /^[a-z][a-z0-9-]{0,30}$/

export class Core {
  /** 这个项目的总管会话 ID。 */
  get masterId(): string { return this.opts.masterId ?? MASTER_ID }
  /** 成员会话 ID 前缀。 */
  get memberPrefix(): string { return this.opts.memberPrefix ?? EXEC_PREFIX }
  private readonly timers = new Set<() => void>()
  private readonly timer: (fn: () => void, ms: number) => () => void

  constructor(readonly store: Store, readonly delivery: Delivery, readonly port: SessionPort, readonly clock: Clock, readonly opts: CoreOptions) {
    this.timer = opts.timer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t) })
  }

  dispose(): void { for (const cancel of this.timers) cancel(); this.timers.clear() }

  get mem(): MemoryLayer | undefined { return this.opts.mem }

  roleOf(sessionId: string): Role | undefined {
    const row = this.store.getSession(sessionId)
    return row && row.status === 'active' ? row.role : undefined
  }

  /** 插件启动时确保总管会话在花名册里、在 DSH 里存在。 */
  async ensureMaster(cwd: string): Promise<void> {
    fs.mkdirSync(cwd, { recursive: true })
    const now = this.clock()
    if (!this.store.getSession(this.masterId)) {
      this.store.upsertSession({ id: this.masterId, role: 'master', title: '总管', cwd, handbook: null, created_at: bjtIso(now) })
      this.store.addEvent({ at: bjtIso(now), session: this.masterId, type: 'session/registered', data: { role: 'master', cwd } })
    }
    await this.port.ensureSession({ id: this.masterId, cwd: this.store.getSession(this.masterId)!.cwd, title: '总管', role: 'master', preset: this.opts.masterPreset })
    this.ensureHandbook(this.masterId)
  }

  /** 角色 → 工具。不在花名册（或已关闭）的会话：空。 */
  toolsFor(sessionId: string): ToolSpec[] {
    const role = this.roleOf(sessionId)
    if (role === 'master') return [...this.masterTools(), ...this.memTools()]
    if (role === 'exec') return [...this.execTools(), ...this.memTools()]
    return []
  }

  /** 投递放到当前同步事务提交之后再跑，避免事务回滚了消息却已投出去。 */
  private memTools(): ToolSpec[] {
    const mem = this.opts.mem
    if (!mem) return []
    const wrap = (t: ReturnType<typeof memoryTools>[number]): ToolSpec => ({ name: t.name, description: t.description, parameters: t.parameters as unknown as JsonSchema,
      run: async (a, caller) => { try { return await t.run(a, caller) } catch (e) { if (e instanceof MemoryInputError) throw new ToolInputError(e.message); throw e } } })
    const common = memoryTools(mem, { turnKey: c => this.turnKey(c), currentTask: c => this.activeTasks(c)[0]?.id }).map(wrap)
    const handbook: ToolSpec = { name: 'handbook_add', description: '往你自己的专题经验手册里加一条经验：一句话结论 + 出处（devlog slug / 文件路径 / 记忆名）。写「下次怎么做」，不写流水账。任务收尾、踩到新坑、感觉上下文快满时写。',
      parameters: schema({ section: S('哪一节', { enum: [...HANDBOOK_SECTIONS] }), line: S('一句话结论（≤200 字，一行）'), source: S('出处') }, ['section', 'line', 'source']),
      run: (a, caller) => this.handbookAdd(obj(a), caller) }
    return [...common, handbook]
  }

  private kick(): void { setImmediate(() => { void this.delivery.pump() }) }

  private enqueue(input: Parameters<Delivery['enqueue']>[0]) {
    try {
      const r = this.delivery.enqueue(input)
      this.kick()
      return r
    } catch (e) {
      if (e instanceof DeliveryError) throw new ToolInputError(e.message)
      throw e
    }
  }

  private activeExec(id: string): string {
    const target = id.startsWith(this.memberPrefix) ? id : this.memberPrefix + id
    const row = this.store.getSession(target)
    if (!row || row.role !== 'exec') throw new ToolInputError(`${target} 不在花名册里（先用 master_spawn 建）`)
    if (row.status !== 'active') throw new ToolInputError(`${target} 已关闭`)
    return target
  }

  // ---------------- 总管工具 ----------------
  private masterTools(): ToolSpec[] {
    return [
      { name: 'master_spawn', description: `新建（或确认已存在）一个执行会话，加入花名册。会话 ID 为 ${this.memberPrefix}<name>，永久不变；之后派活即唤醒。${this.opts.projectRoot ? `工作目录固定是项目根 ${this.opts.projectRoot}。` : ''}`,
        parameters: this.opts.projectRoot
          ? schema({ name: S('小写字母开头，只含小写字母、数字、连字符，如 docs、ui'), title: S('显示名'), purpose: S('负责什么（一句话，看板「会话」里显示；可选）'), handbook: S('专题手册路径（可选）') }, ['name', 'title'])
          : schema({ name: S('小写字母开头，只含小写字母、数字、连字符，如 3d、temp'), cwd: S('执行会话的工作目录（绝对路径，必须存在）'), title: S('显示名'), purpose: S('负责什么（一句话，看板「会话」里显示；可选）'), handbook: S('专题手册路径（可选）') }, ['name', 'cwd', 'title']),
        run: (a, caller) => this.spawn(obj(a), caller) },
      { name: 'master_dispatch', description: '给执行会话派一件任务（轻任务 L<月日>-<序号> 或重任务 T<三位数>）。重任务必须给闸门、预计耗时、产物目录、续跑方式。同样的派活重复调用不会重复投递。',
        parameters: schema({ task: S('任务 ID：T005 或 L1103-1'), kind: S('light 或 heavy', { enum: ['light', 'heavy'] }), title: S('一句话标题'), to: S('执行会话 ID 或名字'), gate: S('重任务当前闸门，如 G1'), text: S('派活说明（要自足，执行会话看不到你和用户的对话）'),
          expected: S('重任务：预计耗时'), output: S('重任务：产物目录'), resume: S('重任务：续跑方式（断了从哪接着做）'),
          ...(this.opts.projectRoot ? {
            claims: { type: 'array', items: { type: 'string' }, description: `认领：这件任务要改的目录或文件（相对项目根 ${this.opts.projectRoot} 或绝对路径）。别的成员写这些路径会被拦；和别的成员的有效认领重叠会被拒。再派同一任务的下一个闸门时不写就沿用上次的` },
            claims_reason: S('确实要和别人的认领重叠时写理由（会记进两边的时间线）') } : {}) }, ['task', 'kind', 'title', 'to', 'text']),
        run: (a, caller) => this.dispatch(obj(a), caller) },
      { name: 'master_send', description: '给执行会话发一条普通消息（不是派活）。同样内容重复发会被去重。',
        parameters: schema({ to: S('执行会话 ID 或名字'), text: S('消息正文'), task: S('相关任务 ID（可选）') }, ['to', 'text']),
        run: (a, caller) => this.send(obj(a), caller) },
      { name: 'master_sessions', description: '列出花名册：每个执行会话的状态（running/idle/cold）、在途任务。',
        parameters: schema({}, []), run: async () => ({ sessions: this.sessions() }) },
      { name: 'master_close', description: '把执行会话从花名册关闭（之后不能再给它派活）。',
        parameters: schema({ name: S('执行会话 ID 或名字') }, ['name']), run: (a, caller) => this.close(obj(a), caller) },
      { name: 'master_review', description: '验收：通过或打回一个闸门 / 任务，结果会发给负责的执行会话。final=true 表示整个任务完成。轻任务也要用它记一笔（回报「完成」时已结案，验收通过保持完成、打回会重新打开）。',
        parameters: schema({ task: S('任务 ID'), verdict: S('通过 或 打回', { enum: ['通过', '打回'] }), gate: S('闸门，如 G1'), notes: S('验收意见（打回时逐条写具体问题）'), final: { type: 'boolean', description: '通过且整个任务完成' } }, ['task', 'verdict', 'notes']),
        run: (a, caller) => this.review(obj(a), caller) },
      { name: 'task_spec_write', description: '写（或重写）重任务的任务书 docs/tasks/<任务>.md。派重任务前必须先有任务书：开始、预计耗时、产物目录、续跑方式、目标、要读的、交付物、验收标准、红线都要写。',
        parameters: schema({ task: S('T 编号'), title: S('标题'), start: S('开始时间（BJT，可选，默认现在）'), expected: S('预计耗时'), output: S('产物目录（绝对路径）'), resume: S('续跑方式'),
          ...Object.fromEntries(SPEC_SECTIONS.map(k => [k, S(k)])),
          gates: { type: 'array', description: '闸门（至少一个，按顺序）：编号 G1 / G6a / G6-1，标题 ≤20 字，产物写路径或一句话。重任务派活只能用这里定义过的闸门。',
            items: { type: 'object', properties: { id: S('闸门编号'), title: S('≤20 字短标题'), produces: S('产物（路径或一句话）') }, required: ['id', 'title'], additionalProperties: false } } },
          ['task', 'title', 'expected', 'output', 'resume', ...SPEC_SECTIONS, 'gates']),
        run: (a, caller) => this.specWrite(obj(a), caller) },
      { name: 'master_patrol', description: '立刻跑一遍巡检（不调模型的检查：停滞、投递失败、待你定、带外改动、记忆层一致性），返回全部发现。定时巡检保底消息到达时用它。',
        parameters: schema({}, []), run: async () => this.opts.patrol ? this.opts.patrol() : { findings: [] } },
      ...(this.opts.tag ? [{ name: 'master_tag', description: '兜底标注：把原生对话的某一轮归到某个任务（插件自动归不了的时候用；@任务、工具调用带任务号、@执行会话 都会自动归）。看板时间线和每轮末尾的小标签会显示。',
        parameters: schema({ turn: { type: 'integer', minimum: 1, description: '第几轮（对话每轮末尾小标签、看板时间线上都标着）' }, task: S('任务 ID'), session: S('会话 ID（可选，默认总管自己的会话）') }, ['turn', 'task']),
        run: async (a: unknown, caller: string) => this.opts.tag!(caller, obj(a)) }] : []),
      ...(this.opts.pause ? [{ name: 'master_pause', description: '暂停这个项目：删掉定时巡检保底、成员一轮结束不再提醒你、巡检不再给你发消息（工具和派活照常）。只在用户明确说要暂停时用；恢复只能由用户在看板上点「恢复」。',
        parameters: schema({ reason: S('为什么暂停（用户的原话或一句话）') }, ['reason']), run: async (a: unknown, caller: string) => this.opts.pause!(caller, str(obj(a), 'reason', { required: true, max: 500 })!) }] as ToolSpec[] : []),
      ...(this.opts.doctor ? [{ name: 'master_doctor', description: '自检：库与文件不一致、带外改动、投递卡住 / 出错、归属指向不存在的任务、负责会话不在花名册、已结案任务还挂着等你定、任务书缺失、太久没备份。只列问题，不自动修。',
        parameters: schema({}, []), run: async () => this.opts.doctor!() }] : []),
      { name: 'master_link', description: '确认两个任务相关（巡检报的「跨任务关联候选」你看过、认为确实是同一个主题时用）：两边时间线各留一条「关联 @另一个」。不确定就别连。',
        parameters: schema({ task: S('任务 ID'), with: S('另一个任务 ID'), why: S('为什么相关，一句话（会显示在两边时间线上）') }, ['task', 'with', 'why']),
        run: async (a, caller) => this.link(obj(a), caller) },
      { name: 'master_ask_user', description: '记下一件要用户拍板的事（一次一个具体问题），出现在看板「等你定」里。',
        parameters: schema({ task: S('相关任务 ID'), question: S('具体问题'), options: { type: 'array', items: { type: 'string' }, description: '可选项（可选）' } }, ['task', 'question']),
        run: (a) => this.askUser(obj(a)) },
    ]
  }

  // ---------------- 执行会话工具 ----------------
  private execTools(): ToolSpec[] {
    return [
      { name: 'master_report', description: '向总管回报（结构化状态行）。状态只能是：进展、等待、受阻、失败、就绪、完成。时间由插件按北京时间自动填，不要自己写时间。闸门到了用「就绪」并停下等验收。',
        parameters: schema({ task: S('任务 ID'), state: S('状态', { enum: [...REPORT_STATES] }), action: S('当前动作，一句话'), ask: S('要总管/用户定的一个具体问题（可选）'), gate: S('就绪时：哪个闸门'), body: S('做了什么、产物绝对路径、怎么验的、遇到的问题（可选）') }, ['task', 'state', 'action']),
        run: (a, caller) => this.report(obj(a), caller) },
      ...(this.opts.heavy ? [{ name: 'heavy_run', description: '重活（渲染、转写、分离音轨、本地大模型推理）排队跑：先查系统可用内存，同一时间只跑一件；跑完会自动发消息告诉你结果和日志路径。不要用 bash 直接跑这些。',
        parameters: schema({ label: S('简短标签'), command: S('要跑的命令（在你的工作目录里执行）'), min_free_gb: { type: 'number', description: '至少要多少 GB 可用内存才开跑（默认 4）' } }, ['label', 'command']),
        run: (a: unknown, caller: string) => this.heavyRun(obj(a), caller) } as ToolSpec] : []),
    ]
  }

  // ---------------- 实现 ----------------
  /** G6-4：某个任务的认领（不管有效没有）。 */
  claimOf(task: string): Claim | undefined {
    const v = this.store.getMeta(`claims:${task}`); if (!v) return undefined
    try { return JSON.parse(v) as Claim } catch { return undefined }
  }
  /** G6-4：有效认领 = 任务没完成 / 取消、负责的成员还在花名册里没关闭。 */
  activeClaims(): Claim[] {
    const out: Claim[] = []
    for (const t of this.store.listTasks()) {
      if (TERMINAL_TASK_STATES.has(t.state)) continue
      const c = this.claimOf(t.id); if (!c || !c.paths.length) continue
      if (this.store.getSession(t.owner)?.status !== 'active') continue
      out.push({ ...c, owner: t.owner })
    }
    return out
  }
  /** G6-4：成员要写 target，落在别人的有效认领里 ⇒ 命中的认领。总管不受限。 */
  claimHitFor(caller: string, target: string) {
    if (!this.opts.projectRoot || this.roleOf(caller) !== 'exec') return undefined
    return claimHit(target, caller, this.activeClaims())
  }
  /** 已确认关联的任务对（"A|B"，字母序），巡检不再报。 */
  linkedPairs(): Set<string> {
    const out = new Set<string>()
    for (const e of this.store.events({ type: 'task/linked' })) { const d = JSON.parse(e.data || '{}'); if (e.task && d.with) out.add([e.task, d.with].sort().join('|')) }
    return out
  }
  link(a: Record<string, unknown>, caller: string) {
    const task = String(a.task ?? '').trim().toUpperCase(), other = String(a.with ?? '').trim().toUpperCase(), why = String(a.why ?? '').replace(/\s+/g, ' ').trim()
    if (!this.store.getTask(task)) throw new ToolInputError(`没有任务 ${task}`)
    if (!this.store.getTask(other)) throw new ToolInputError(`没有任务 ${other}`)
    if (task === other) throw new ToolInputError('不能和自己关联')
    if (!why) throw new ToolInputError('why 要写一句为什么相关')
    if (this.linkedPairs().has([task, other].sort().join('|'))) return { task, with: other, linked: false, already: true }
    const at = bjtIso(this.clock())
    this.store.addEvent({ at, task, type: 'task/linked', data: { with: other, why, by: caller } })
    this.store.addEvent({ at, task: other, type: 'task/linked', data: { with: task, why, by: caller } })
    return { task, with: other, linked: true }
  }

  async spawn(a: Record<string, unknown>, caller: string) {
    const name = str(a, 'name', { required: true, pattern: NAME, hint: '小写字母开头，只含小写字母、数字、连字符' })!
    const root = this.opts.projectRoot
    const given = str(a, 'cwd')
    const wt = root && given && path.resolve(given) !== root ? path.resolve(given) : undefined
    if (wt && !sameRepoWorktree(wt, root!)) throw new ToolInputError(`项目制下成员的工作目录固定是项目根 ${root}，不能另设（项目里的子目录、产物目录写在派活说明里，用绝对路径）。只有大重构时临时开的 git worktree（同一个仓库，先由总管 git worktree add 建好）可以作为工作目录`)
    const cwd = wt ?? root ?? str(a, 'cwd', { required: true })!
    const title = str(a, 'title', { required: true, max: 60 })!
    const handbook = str(a, 'handbook') ?? null
    const purpose = str(a, 'purpose', { max: 80 })
    if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ToolInputError(`cwd 必须是存在的绝对路径目录：${cwd}`)
    const id = this.memberPrefix + name
    const now = this.clock()
    const existed = this.store.getSession(id)
    this.store.upsertSession({ id, role: 'exec', title, cwd, handbook, created_at: existed?.created_at ?? bjtIso(now) })
    if (purpose) this.store.setMeta(`purpose:${id}`, purpose)
    if (wt) this.store.setMeta(`worktree:${id}`, wt)
    this.store.addEvent({ at: bjtIso(now), session: id, type: existed ? 'session/reopened' : 'session/spawned', data: { by: caller, cwd, title } })
    await this.port.ensureSession({ id, cwd, title, role: 'exec', preset: root ? (this.opts.memberPreset ?? 'workspace-write') : undefined })
    this.ensureHandbook(id)
    return { id, status: this.port.status(id), existed: Boolean(existed), ...(wt ? { worktree: wt } : {}), ...(this.opts.mem ? { handbook: this.opts.mem.docs.abs(this.handbookFile(id, handbook)) } : {}) }
  }

  async dispatch(a: Record<string, unknown>, caller: string) {
    const task = str(a, 'task', { required: true, pattern: TASK_ID, hint: '重任务 T005，轻任务 L1103-1' })!
    const kind = str(a, 'kind', { required: true, pattern: /^(light|heavy)$/, hint: 'light 或 heavy' }) as 'light' | 'heavy'
    if ((kind === 'heavy') !== task.startsWith('T')) throw new ToolInputError('重任务用 T 编号，轻任务用 L 编号')
    const title = str(a, 'title', { required: true, max: 120 })!
    const to = this.activeExec(str(a, 'to', { required: true })!)
    const text = str(a, 'text', { required: true })!
    const gate = normGate(str(a, 'gate', { max: 40 })) ?? null
    const meta: Record<string, string> = {}
    if (kind === 'heavy') {
      if (!gate) throw new ToolInputError('重任务必须给 gate（当前闸门，如 G1）')
      const spec = this.spec(task)
      if (this.opts.mem) {
        if (!spec) throw new ToolInputError(`${task} 还没有任务书：先用 task_spec_write 写（开始、预计耗时、产物目录、续跑方式、目标、验收标准、红线、闸门都要有）`)
        const defined = this.store.gatesFor(task)
        if (!defined.length) throw new ToolInputError(`${task} 的任务书还没有定义闸门：用 task_spec_write 的 gates 写上（编号 + ≤20 字标题 + 产物），再派活`)
        if (!defined.some(g => g.gate === gate)) throw new ToolInputError(`${task} 的任务书里没有闸门 ${gate}；定义过的是：${defined.map(g => `${g.gate}（${g.title}）`).join('、')}。要加闸门就先改任务书`)
        Object.assign(meta, { 预计耗时: spec.expected, 产物目录: spec.output, 续跑方式: spec.resume, 任务书: this.opts.mem.docs.abs(spec.file) })
      } else {
        for (const [k, label] of [['expected', '预计耗时'], ['output', '产物目录'], ['resume', '续跑方式']] as const) {
          const v = str(a, k)
          if (!v) throw new ToolInputError(`重任务必须给 ${k}（${label}）`)
          meta[label] = v
        }
      }
    }
    const now = this.clock(); const at = bjtIso(now)
    const cur = this.store.getTask(task)
    if (cur && cur.owner !== to) throw new ToolInputError(`${task} 由 ${cur.owner} 负责，不能改派给 ${to}（G2 不支持改派）`)
    if (cur && cur.state === '完成') throw new ToolInputError(`${task} 已完成`)
    // G6-4 软认领
    const root = this.opts.projectRoot
    let claims: string[] | undefined; let overlap: ReturnType<typeof conflictsWith> = []
    const claimsReason = str(a, 'claims_reason', { max: 200 })
    if (root && a.claims !== undefined) {
      try { claims = normClaims(a.claims, root) } catch (e) { throw new ToolInputError(String((e as Error).message)) }
      overlap = conflictsWith(claims, to, task, this.activeClaims())
      if (overlap.length && !claimsReason) throw new ToolInputError(`认领重叠：${overlap.map(o => `${rel(root, o.path)} 和 ${o.claim.task}（${o.claim.owner}）认领的 ${rel(root, o.other)}`).join('；')}。` +
        `换一个不重叠的范围，或者等那件任务完成；确实要一起改就在 claims_reason 写理由（两个人改同一批文件，冲突要靠宿主的乐观锁和你来协调）`)
    }
    const prevClaim = root ? this.claimOf(task) : undefined
    if (prevClaim && !claims) meta['认领'] = prevClaim.paths.map(p => rel(root!, p)).join('、')
    if (claims?.length) meta['认领'] = claims.map(p => rel(root!, p)).join('、') + '（只改这些；要改别的先回报。别的成员认领的文件插件会拦）'
    const metaLines = Object.entries(meta).map(([k, v]) => `- ${k}：${v}`).join('\n')
    const body = `派活：${task}（${kind === 'heavy' ? '重任务' : '轻任务'}${gate ? ` · 闸门 ${gate}` : ''}）${title}\n${metaLines ? metaLines + '\n' : ''}\n${text}\n\n` +
      (kind === 'heavy' ? `到闸门用 master_report(state=就绪) 回报并停下等验收。` : `做完用 master_report(state=完成) 回报一次。`)
    const key = `dispatch:${task}:${gate ?? '-'}:${hash(text)}`
    const result = this.store.tx(() => {
      if (!cur) this.store.insertTask({ id: task, kind, title, owner: to, state: '进行中', gate, meta: JSON.stringify(meta), created_at: at, updated_at: at })
      const r = this.enqueue({ key, from: caller, to, task, mode: 'followup', text: body, label: '派活' })
      if (r.status === 'queued') {
        if (cur) this.store.updateTask(task, { state: '进行中', gate }, at)
        this.store.addEvent({ at, task, session: to, type: 'task/dispatched', data: { by: caller, kind, gate, key, ...(claims ? { claims: claims.map(p => rel(root!, p)) } : {}) } })
      }
      if (claims) {
        this.store.setMeta(`claims:${task}`, JSON.stringify({ task, owner: to, paths: claims, at, ...(overlap.length ? { reason: claimsReason } : {}) } satisfies Claim))
        for (const o of overlap) for (const t of new Set([task, o.claim.task])) this.store.addEvent({ at, task: t, session: to, type: 'claims/overlap', data: { by: caller, task, with: o.claim.task, path: rel(root!, o.path), other: rel(root!, o.other), reason: claimsReason } })
      }
      return r
    })
    this.renderBoard()
    return { task, to, ...result }
  }

  async send(a: Record<string, unknown>, caller: string) {
    const to = this.activeExec(str(a, 'to', { required: true })!)
    const text = str(a, 'text', { required: true })!
    const task = str(a, 'task', { pattern: TASK_ID }) ?? null
    return this.enqueue({ key: `send:${caller}:${to}:${hash(text)}`, from: caller, to, task, mode: 'followup', text })
  }

  sessions() {
    const tasks = this.store.listTasks()
    return this.store.listSessions().map(s => ({ id: s.id, role: s.role, title: s.title, cwd: s.cwd, status: s.status, live: this.port.status(s.id),
      tasks: tasks.filter(t => t.owner === s.id && t.state !== '完成').map(t => ({ id: t.id, state: t.state, gate: t.gate })) }))
  }

  async close(a: Record<string, unknown>, caller: string) {
    const name = str(a, 'name', { required: true })!
    const id = name.startsWith(this.memberPrefix) ? name : this.memberPrefix + name
    const row = this.store.getSession(id)
    if (!row || row.role !== 'exec') throw new ToolInputError(`${id} 不在花名册里`)
    const at = bjtIso(this.clock())
    const closed = this.store.closeSession(id, at)
    if (closed) this.store.addEvent({ at, session: id, type: 'session/closed', data: { by: caller } })
    return { id, closed }
  }

  async review(a: Record<string, unknown>, caller: string) {
    const task = str(a, 'task', { required: true, pattern: TASK_ID })!
    const verdict = str(a, 'verdict', { required: true, pattern: /^(通过|打回)$/, hint: '通过 或 打回' })!
    const notes = str(a, 'notes', { required: true })!
    const cur = this.requireTask(task)
    const gate = normGate(str(a, 'gate', { max: 40 })) ?? cur.gate
    // G5-F ③ 轻任务没有闸门：通过就是完成（不管 final），打回就重新打开；已经按「完成」结案的轻任务也能验收，验收进时间线
    const light = cur.kind === 'light'
    const final = a.final === true || light
    const state = verdict === '打回' ? '打回' : final ? '完成' : '进行中'
    const now = this.clock(); const at = bjtIso(now)
    const text = `验收：${task}${gate ? ` 闸门 ${gate}` : ''} ${verdict}${final && verdict === '通过' ? '（任务完成）' : ''}\n\n${notes}\n\n` +
      (verdict === '打回' ? '按上面逐条改，改完再用 master_report(state=就绪) 回报。' : final ? '任务到此结束，记得把这次的经验写进专题手册。' : '可以继续下一个闸门。')
    return this.store.tx(() => {
      const r = this.enqueue({ key: `review:${task}:${gate ?? '-'}:${verdict}:${hash(notes)}`, from: caller, to: cur.owner, task, mode: 'followup', text, label: '验收' })
      if (r.status === 'queued') {
        this.store.updateTask(task, { state }, at)
        this.store.addEvent({ at, task, session: cur.owner, type: 'task/reviewed', data: { by: caller, verdict, gate, final, notes } })
        this.appendSpec(task, 'review', `- ${bjtStamp(now)} ${gate ?? ''} ${verdict}${final && verdict === '通过' ? '（任务完成）' : ''}：${notes.split('\n').join(' ')}`)
      }
      return { task, verdict, state, ...r }
    })
  }

  async askUser(a: Record<string, unknown>) {
    const task = str(a, 'task', { required: true, pattern: TASK_ID })!
    const question = str(a, 'question', { required: true, max: 500 })!
    const options = Array.isArray(a.options) ? a.options.filter((o): o is string => typeof o === 'string').slice(0, 6) : []
    const at = bjtIso(this.clock())
    const id = this.store.addAsk({ task, question, options, at })
    const code = this.store.getAsk(id)!.code
    this.store.addEvent({ at, task, type: 'ask/open', data: { id, code, question, options } })
    return { id, code, task, question, options }
  }

  async report(a: Record<string, unknown>, caller: string) {
    const task = str(a, 'task', { required: true, pattern: TASK_ID })!
    const state = str(a, 'state', { required: true }) as ReportState
    if (!REPORT_STATES.includes(state)) throw new ToolInputError(`state 只能是：${REPORT_STATES.join('、')}`)
    const action = str(a, 'action', { required: true, max: 200 })!
    const ask = str(a, 'ask', { max: 300 })
    const body = str(a, 'body') ?? ''
    if (this.roleOf(caller) !== 'exec') throw new ToolInputError(`${caller} 不是花名册里在用的执行会话（可能已被总管关闭），不能回报`)
    const cur = this.requireTask(task)
    if (cur.owner !== caller) throw new ToolInputError(`${task} 不是派给你（${caller}）的，负责人是 ${cur.owner}`)
    const gate = normGate(str(a, 'gate', { max: 40 })) ?? cur.gate
    const now = this.clock(); const at = bjtIso(now)
    const line = `[${task}] 状态=${state} ｜时间：${bjtStamp(now)} ｜当前动作：${action}${ask ? ` ｜要你定：${ask}` : ''}`
    // 状态机单向：已结案的任务，回报照记（事件 + 任务书），但不改状态；给总管的提示标成「迟到回报」，不唤醒
    const closed = TERMINAL_TASK_STATES.has(cur.state)
    const taskState = closed ? cur.state : ({ 进展: '进行中', 等待: '等待', 受阻: '受阻', 失败: '失败', 就绪: '待验收', 完成: cur.kind === 'light' ? '完成' : '待验收' } as const)[state]
    const quiet = closed || state === '进展' || state === '等待'
    const lateNote = closed ? `【已结案任务的迟到回报：${task} 已是「${cur.state}」，这条回报不改任务状态】\n` : ''
    const result = this.store.tx(() => {
      const r = this.enqueue({ key: `report:${task}:${state}:${hash(action + '\n' + (ask ?? '') + '\n' + body)}`, from: caller, to: this.masterId, task, mode: quiet ? 'inject' : 'followup',
        text: `${lateNote}${body ? `${line}\n${body}` : line}${!closed && cur.kind === 'light' && state === '完成' ? `\n\n【轻任务 ${task} 已按「完成」结案。你核对完产物后用 master_review 记一笔（通过 / 打回），看板时间线上才看得到验收】` : ''}`, summary: closed ? `迟到回报 ${line}` : line, label: closed ? '已结案任务的迟到回报' : '回报' })
      if (r.status === 'queued') {
        if (!closed) this.store.updateTask(task, { state: taskState, gate }, at)
        this.store.addEvent({ at, task, session: caller, type: closed ? 'task/late-report' : 'task/report', data: { state, gate, line, body, ...(closed ? { taskState: cur.state } : {}) } })
      }
      return r
    })
    this.store.setLastReport(caller, now)
    if (result.status === 'queued') this.appendSpec(task, 'report', `${closed ? '- （迟到回报，不改状态）' + line.slice(0) : `- ${line}`}${body ? `\n${body.split('\n').map(l => '  ' + l).join('\n')}` : ''}`)
    this.renderBoard()
    return { line, taskState, ...(closed ? { late: true, note: `${task} 已结案（${cur.state}），这条回报已记录但不改状态` } : {}), ...result }
  }

  private requireTask(task: string): TaskRow {
    const t = this.store.getTask(task)
    if (!t) throw new ToolInputError(`没有任务 ${task}`)
    return t
  }

  // ---------------- 轮次、空闲兜底（落库，DSH 重启后不漏）----------------
  /** 一轮的标识：会话 + 这一轮开始的时间（devlog「一次请求一条」用）。 */
  turnKey(sessionId: string): string | undefined {
    const t = this.store.getTurn(sessionId)
    return t?.started_ms ? `${sessionId}:${t.started_ms}` : undefined
  }
  activeTasks(sessionId: string): TaskRow[] {
    return this.store.listTasks().filter(t => t.owner === sessionId && ACTIVE_TASK_STATES.has(t.state))
  }

  /** G11-1 消息直送开着吗（配置 directToMember，默认开）。 */
  get directEnabled(): boolean { return this.opts.directToMember !== false }
  /** G11-1：这一轮是用户开的吗（onStatus running / onUserMessage 两边谁后到谁记）。 */
  private isUserTurn(sessionId: string, started: number): boolean {
    return this.store.getMeta(`userturn:${sessionId}`) === String(started)
  }

  /** DSH 的 agent/status 事件进来。执行会话一轮结束却没回报 → 宽限期后提醒总管。 */
  onStatus(sessionId: string, status: 'running' | 'idle'): void {
    const role = this.roleOf(sessionId)
    if (!role) return
    const now = this.clock()
    if (status === 'running') {
      this.store.setTurnStart(sessionId, now)
      const u = Number(this.store.getMeta(`usermsg:${sessionId}`) || NaN)
      if (role === 'exec' && now - u >= 0 && now - u <= USER_TURN_WINDOW_MS) this.store.setMeta(`userturn:${sessionId}`, String(now))
      // 一条用户消息只认领一轮：开始跑了就用掉（g2-flow 回归：用户说完、10 秒内派活开的一轮被误当成用户开的，空闲提醒没了）
      if (role === 'exec') this.store.setMeta(`usermsg:${sessionId}`, '')
      return
    }
    if (role !== 'exec') return
    const t = this.store.getTurn(sessionId)
    if (!t?.started_ms) return
    // G11-1：记下这一轮结束的时间（巡检判「直接对话 30 分钟没回」）；用户开的那一轮，看成员的回答里有没有「改了结论」
    this.store.setMeta(`turnend:${sessionId}`, String(now))
    if (this.isUserTurn(sessionId, t.started_ms)) void this.noteDirectReply(sessionId)
    if ((t.last_report_ms ?? -1) >= t.started_ms) return
    if (!this.activeTasks(sessionId).length) return
    this.scheduleIdleCheck(sessionId, t.started_ms, this.opts.idleGraceMs)
  }

  private scheduleIdleCheck(sessionId: string, started: number, ms: number): void {
    const cancel = this.timer(() => { this.timers.delete(cancel); void this.idleCheck(sessionId, started) }, ms)
    this.timers.add(cancel)
  }

  /** 插件启动（含 DSH 重启）时：库里有「开了一轮、还没回报」的执行会话 → 重新排一次兜底检查。 */
  recover(): number {
    let n = 0
    for (const t of this.store.listTurns()) {
      if (this.roleOf(t.session) !== 'exec' || !t.started_ms) continue
      if ((t.last_report_ms ?? -1) >= t.started_ms) continue
      if (!this.activeTasks(t.session).length) continue
      this.scheduleIdleCheck(t.session, t.started_ms, this.opts.idleGraceMs); n++
    }
    return n
  }

  private async idleCheck(sessionId: string, started: number): Promise<void> {
    if (this.port.status(sessionId) === 'running') return
    // G8：项目暂停中不提醒总管（不叫醒模型）；记一笔，看得出是暂停挡掉的
    if (pausedInfo(this.store)) { this.store.addEvent({ at: bjtIso(this.clock()), session: sessionId, type: 'reminder/paused', data: { started } }); return }
    const t = this.store.getTurn(sessionId)
    if (!t || t.started_ms !== started) return // 之后又开了新一轮，交给那一轮判断
    if ((t.last_report_ms ?? -1) >= started) return
    const active = this.activeTasks(sessionId)
    if (!active.length) return
    // G11-1：用户直接在成员会话里开的这一轮（追问、闲聊），成员没回报是正常的 ⇒ 不叫醒总管；要紧的由巡检「直接对话」报
    if (this.directEnabled && this.isUserTurn(sessionId, started)) {
      this.store.addEvent({ at: bjtIso(this.clock()), session: sessionId, task: active[0]!.id, type: 'reminder/user-turn', data: { started } })
      return
    }
    const last = ((await this.port.lastAssistantText(sessionId)) ?? '（没有文字输出）').slice(0, 600)
    const text = `${sessionId} 一轮结束了，但没有用 master_report 回报（在途任务：${active.map(t => `${t.id}[${t.state}]`).join('、')}）。它最后说：\n${last}`
    try {
      this.enqueue({ key: `idle:${sessionId}:${started}`, from: SYSTEM_ID, to: this.masterId, task: active[0]!.id, mode: 'followup', text, label: '空闲提醒' })
    } catch { /* 限频等：下一轮再说 */ }
  }

  // ---------------- 用户直接对执行会话说话 / 压缩后提醒 ----------------
  /** 用户直接在执行会话里说话，而它有在途任务 → 告诉总管一声（T003 教训：用户叫停而总管不知道）。 */
  onUserMessage(sessionId: string, messageId: string, text: string): void {
    const row = this.store.getSession(sessionId)
    if (row?.role === 'exec' && this.directEnabled) {
      // G11-1：记下来给巡检「直接对话」用（已关闭的会话也记：要报「已不归总管管」）
      const now = this.clock()
      this.store.addEvent({ at: bjtIso(now), session: sessionId, task: this.activeTasks(sessionId)[0]?.id ?? null, type: 'user/direct', data: { msg: messageId, ms: now, text: text.slice(0, 300) } })
      this.store.setMeta(`usermsg:${sessionId}`, String(now))
      // 宿主先报「开始跑」、后报用户消息的情况：这一轮刚开始、上一轮已经结束 ⇒ 也算用户开的
      const t = this.store.getTurn(sessionId)
      const end = Number(this.store.getMeta(`turnend:${sessionId}`) ?? 0)
      if (t?.started_ms && now - t.started_ms >= 0 && now - t.started_ms <= USER_TURN_WINDOW_MS && end < t.started_ms) {
        this.store.setMeta(`userturn:${sessionId}`, String(t.started_ms))
        this.store.setMeta(`usermsg:${sessionId}`, '') // 已经认领了这一轮，别再给下一轮用
      }
    }
    if (this.roleOf(sessionId) !== 'exec') return
    const active = this.activeTasks(sessionId)
    if (!active.length) return
    try {
      this.enqueue({ key: `userdirect:${messageId}`, from: SYSTEM_ID, to: this.masterId, task: active[0]!.id, mode: 'inject', label: '用户直接指示',
        text: `用户直接在 ${sessionId} 里说了话（在途任务：${active.map(t => t.id).join('、')}）。如果它改变了在途任务（叫停、改范围、改方向），按新情况调整：\n${text.slice(0, 1500)}` })
    } catch { /* 限频 */ }
  }
  /**
   * G11-1：接下来这一轮算用户开的（看板「回答等你定」直投成员时用：答案是用户给的，成员接着干、不回报也不叫醒总管）。
   * 和用户直接说话走同一个时间窗：USER_TURN_WINDOW_MS 内开始跑的那一轮。
   */
  markUserOpened(sessionId: string): void {
    if (this.directEnabled) this.store.setMeta(`usermsg:${sessionId}`, String(this.clock()))
  }
  /** G11-1：用户开的那一轮结束，成员的回答里写了「改了结论」⇒ 记一笔，巡检报给总管。 */
  private async noteDirectReply(sessionId: string): Promise<void> {
    try {
      const text = (await this.port.lastAssistantText(sessionId)) ?? ''
      if (!/改了结论/.test(text)) return
      const last = this.store.events({ session: sessionId, type: 'user/direct', limit: 1 })[0]
      const msg = last ? JSON.parse(last.data).msg : null
      this.store.addEvent({ at: bjtIso(this.clock()), session: sessionId, task: last?.task ?? null, type: 'user/direct-changed', data: { msg, excerpt: text.slice(0, 300) } })
    } catch { /* 读不到最后一句：不影响别的 */ }
  }
  /** 会话刚被压缩：提醒它先读手册、任务书、回忆相关前情。 */
  onCompaction(sessionId: string, marker: string): void {
    const role = this.roleOf(sessionId)
    if (!role) return
    const row = this.store.getSession(sessionId)!
    const hb = this.opts.mem ? this.opts.mem.docs.abs(this.handbookFile(sessionId, row.handbook)) : row.handbook ?? '（无）'
    const tasks = this.activeTasks(sessionId).map(t => { const sp = this.spec(t.id); return `${t.id}${sp && this.opts.mem ? `（任务书 ${this.opts.mem.docs.abs(sp.file)}）` : ''}` })
    try {
      this.enqueue({ key: `compact:${sessionId}:${marker}`, from: SYSTEM_ID, to: sessionId, mode: 'inject', label: '压缩后提醒',
        text: `你刚被压缩过（摘要是有损的）。继续之前先：① 读专题手册 ${hb}；② ${tasks.length ? `读在途任务的任务书：${tasks.join('、')}` : '确认有没有在途任务（master_sessions / 任务书）'}；③ 对要动的地方 devlog_recall 一下。` })
    } catch { /* 限频 */ }
  }

  // ---------------- 任务书、手册、任务板（受管 markdown）----------------
  spec(task: string): SpecMeta | undefined {
    const v = this.store.getMeta(`spec:${task}`)
    return v ? JSON.parse(v) : undefined
  }

  async specWrite(a: Record<string, unknown>, caller: string) {
    const mem = this.opts.mem
    if (!mem) throw new ToolInputError('没有记忆层，不能写任务书')
    const task = str(a, 'task', { required: true, pattern: /^T\d{3,}$/, hint: '重任务 T 编号' })!
    const title = str(a, 'title', { required: true, max: 120 })!
    const expected = str(a, 'expected', { required: true, max: 120 })!
    const output = str(a, 'output', { required: true })!
    if (!path.isAbsolute(output)) throw new ToolInputError('output（产物目录）要写绝对路径')
    const resume = str(a, 'resume', { required: true })!
    const body: Record<string, string> = {}
    for (const k of SPEC_SECTIONS) body[k] = str(a, k, { required: true })!
    const gates = parseGates(a.gates)
    const now = this.clock()
    const start = str(a, 'start') ?? bjtStamp(now)
    const file = `tasks/${task}.md`
    const prev = this.spec(task)
    const old = mem.docs.read(file)
    // 一次性迁移：G4 之前写的任务书（meta 里没有正文）回报只存在文件里 ⇒ 把旧文件的两节导成 spec/line 事件，之后不再读文件
    if (prev && !prev.body && old) for (const where of ['report', 'review'] as const) {
      const m = old.match(new RegExp(`\n## ${where === 'report' ? '执行回报' : '验收记录'}\n([\\s\\S]*?)(?=\n## (执行回报|验收记录)\n|$)`))
      const t = m?.[1]?.trim(); if (t) this.store.addEvent({ at: bjtIso(now), task, session: caller, type: 'spec/line', data: { where, text: t, migrated: true } })
    }
    const meta: SpecMeta = { file, title, expected, output, resume, start, writtenAt: bjtStamp(now), caller, body }
    this.store.setMeta(`spec:${task}`, JSON.stringify(meta))
    this.store.setGates(task, gates, bjtIso(now))
    this.store.addEvent({ at: bjtIso(now), task, session: caller, type: old ? 'spec/rewritten' : 'spec/written', data: { file } })
    this.renderSpec(task)
    this.renderBoard()
    return { task, file: mem.docs.abs(file) }
  }

  /** 任务书整份从库里渲染：正文在 meta、回报 / 验收是只追加的 spec/line 事件。不从 Markdown 里读回任何状态。 */
  private renderSpec(task: string): void {
    const mem = this.opts.mem; const sp = this.spec(task)
    if (!mem || !sp?.body) return
    const gates = this.store.gatesFor(task)
    const lines = (where: string) => this.store.events({ task, type: 'spec/line' }).map(e => JSON.parse(e.data)).filter(d => d.where === where).map(d => escapeHeadings(String(d.text)))
    const content = [`# ${task} ${sp.title}`, '', `- 开始：${sp.start}`, `- 预计耗时：${sp.expected}`, `- 产物目录：${sp.output}`, `- 续跑方式：${sp.resume}`, `- 写于：${sp.writtenAt}（${sp.caller}）`, '',
      ...SPEC_SECTIONS.flatMap(k => [`## ${k}`, '', escapeHeadings(sp.body![k] ?? ''), '']),
      ...(gates.length ? ['## 闸门', '', ...gates.flatMap(g => [`### ${g.gate} — ${g.title}`, `- 产物：${g.produces ? escapeHeadings(g.produces) : '（验收时补）'}`, ''])] : []), '## 执行回报', '', lines('report').join('\n'), '', '## 验收记录', '', lines('review').join('\n'), ''].join('\n').replace(/\n{3,}/g, '\n\n')
    mem.docs.write(sp.file, content, 'task')
  }

  private appendSpec(task: string, where: 'report' | 'review', text: string): void {
    const mem = this.opts.mem; const sp = this.spec(task)
    if (!mem || !sp) return
    if (sp.body) { this.store.addEvent({ at: bjtIso(this.clock()), task, type: 'spec/line', data: { where, text } }); this.renderSpec(task); return }
    // 旧格式任务书（G4 之前、还没重写过）：照旧追加到文件
    const cur = mem.docs.read(sp.file) ?? ''
    const m = where === 'report' ? cur.match(/\n## 执行回报\n([\s\S]*?)\n## 验收记录/) : undefined
    const next = m
      ? cur.replace(m[0], `\n## 执行回报\n\n${[m[1]!.trim(), text].filter(Boolean).join('\n')}\n\n## 验收记录`)
      : `${cur.replace(/\n*$/, '\n')}${cur.match(/## 验收记录\n*$/) ? '\n' : ''}${text}\n`
    mem.docs.write(sp.file, next, 'task')
  }

  handbookFile(sessionId: string, configured?: string | null): string {
    return configured && !path.isAbsolute(configured) ? configured : `handbooks/${sessionId}.md`
  }

  /** 手册骨架：建会话时就有（G3 真模型试用：守则让先读手册，文件却要等第一次 handbook_add 才出现）。已有就不动。 */
  ensureHandbook(sessionId: string): void {
    const mem = this.opts.mem; const row = this.store.getSession(sessionId)
    if (!mem || !row) return
    const file = this.handbookFile(sessionId, row.handbook)
    if (mem.docs.read(file) !== undefined) return
    mem.docs.write(file, this.handbookSkeleton(sessionId, row.title), 'handbook')
  }
  private handbookSkeleton(sessionId: string, title: string): string {
    return [`# ${sessionId} 专题经验手册`, '', `> 负责：${title}`, '> 每条 = 一句话结论 + 出处，不写流水账。', `> 最近更新：${bjtStamp(this.clock())}（建会话时生成）`, '',
      ...HANDBOOK_SECTIONS.flatMap(k => [`## ${k}`, '']), ''].join('\n')
  }

  async handbookAdd(a: Record<string, unknown>, caller: string) {
    const mem = this.opts.mem
    if (!mem) throw new ToolInputError('没有记忆层，不能写手册')
    const section = str(a, 'section', { required: true }) as (typeof HANDBOOK_SECTIONS)[number]
    if (!HANDBOOK_SECTIONS.includes(section)) throw new ToolInputError(`section 只能是：${HANDBOOK_SECTIONS.join('、')}`)
    const line = str(a, 'line', { required: true, max: 200 })!
    if (line.includes('\n')) throw new ToolInputError('一条经验一行')
    const source = str(a, 'source', { required: true, max: 200 })!
    const row = this.store.getSession(caller)!
    const file = this.handbookFile(caller, row.handbook)
    const now = bjtStamp(this.clock())
    let cur = mem.docs.read(file) ?? this.handbookSkeleton(caller, row.title)
    cur = cur.replace(/> 最近更新：.*/, `> 最近更新：${now}`)
    const header = `## ${section}\n`
    const entry = `- ${line} —— 出处 ${source}`
    const i = cur.indexOf(header)
    if (i < 0) cur = `${cur.replace(/\n*$/, '\n')}\n${header}\n${entry}\n`
    else {
      const after = cur.indexOf('\n## ', i + header.length)
      const end = after < 0 ? cur.length : after + 1
      const body = cur.slice(i + header.length, end).trim()
      cur = `${cur.slice(0, i)}${header}\n${[body, entry].filter(Boolean).join('\n')}\n\n${cur.slice(end).replace(/^\n+/, '')}`
    }
    mem.docs.write(file, cur, 'handbook')
    this.store.addEvent({ at: bjtIso(this.clock()), session: caller, type: 'handbook/add', data: { file, section, line } })
    return { file: mem.docs.abs(file), section, line }
  }

  /** 任务板（只读视图）：真实来源是库。 */
  renderBoard(): void {
    const mem = this.opts.mem
    if (!mem) return
    const tasks = this.store.listTasks()
    const sessions = this.store.listSessions()
    const lines = ['# 任务板', '', `由 dsh-master 插件生成，只读（真实来源是状态库）。更新：${bjtStamp(this.clock())}`, '',
      '## 重任务', '', '| 任务 | 负责 | 状态 | 闸门 | 标题 | 任务书 |', '|---|---|---|---|---|---|',
      ...tasks.filter(t => t.kind === 'heavy').map(t => `| ${t.id} | ${t.owner} | ${t.state} | ${t.gate ?? ''} | ${t.title} | ${this.spec(t.id) ? `tasks/${t.id}.md` : ''} |`), '',
      '## 轻任务', '', '| 任务 | 负责 | 状态 | 标题 |', '|---|---|---|---|',
      ...tasks.filter(t => t.kind === 'light').map(t => `| ${t.id} | ${t.owner} | ${t.state} | ${t.title} |`), '',
      '## 会话', '', '| 会话 | 角色 | 状态 | 工作目录 |', '|---|---|---|---|',
      ...sessions.map(x => `| ${x.id} | ${x.role} | ${x.status} | ${x.cwd} |`), '',
      '## 等你定', '', ...this.store.openAsks().map(q => `- #${q.id}（${q.task}）${q.question}`), '']
    mem.docs.write('board.md', lines.join('\n'), 'board')
  }

  /** 插件内部发的系统消息（巡检、重活结束等）。 */
  systemNotify(input: { key: string; to: string; text: string; label: string; task?: string | null; mode?: 'followup' | 'inject' }): void {
    this.enqueue({ key: input.key, from: SYSTEM_ID, to: input.to, task: input.task ?? null, mode: input.mode ?? 'followup', text: input.text, label: input.label })
  }

  /** 用户在看板上把任务标完成 / 取消（终态）。通知总管（不唤醒）和负责的执行会话。 */
  userCloseTask(task: string, to: '完成' | '取消', note?: string): { task: string; state: string } {
    const cur = this.requireTask(task)
    if (TERMINAL_TASK_STATES.has(cur.state)) throw new ToolInputError(`${task} 已经是「${cur.state}」`)
    const now = this.clock(); const at = bjtIso(now)
    this.store.tx(() => {
      this.store.updateTask(task, { state: to }, at)
      this.store.addEvent({ at, task, session: cur.owner, type: to === '完成' ? 'task/user-done' : 'task/user-cancel', data: { by: 'user', note: note ?? null } })
    })
    const why = note ? `（用户说明：${note}）` : ''
    try { this.systemNotify({ key: `user-${to}:${task}:${now}`, to: this.masterId, task, mode: 'inject', label: '看板操作', text: `用户在看板把 ${task} 标为「${to}」${why}。` }) } catch { /* 限频 */ }
    try {
      this.systemNotify({ key: `user-${to}-owner:${task}:${now}`, to: cur.owner, task, mode: to === '取消' ? 'followup' : 'inject', label: '看板操作',
        text: to === '取消' ? `用户在看板取消了 ${task}${why}：停下手上与它有关的工作，不用再回报这个任务。` : `用户在看板把 ${task} 标为完成${why}。` })
    } catch { /* 限频 */ }
    this.renderBoard()
    return { task, state: to }
  }

  // ---------------- 重活 ----------------
  async heavyRun(a: Record<string, unknown>, caller: string) {
    if (!this.opts.heavy) throw new ToolInputError('heavy_run 没有启用')
    const label = str(a, 'label', { required: true, max: 60 })!
    const command = str(a, 'command', { required: true, max: 4000 })!
    const minFreeGb = typeof a.min_free_gb === 'number' && a.min_free_gb > 0 ? a.min_free_gb : 4
    const row = this.store.getSession(caller)!
    return this.opts.heavy.submit({ session: caller, label, command, cwd: row.cwd, minFreeGb })
  }

  /** 面板 / 调试用的只读快照。 */
  snapshot() {
    return {
      now: bjtIso(this.clock()),
      sessions: this.sessions(),
      tasks: this.store.listTasks(),
      asks: this.store.openAsks(),
      deliveries: { pending: this.store.deliveriesByState('pending').length, error: this.store.deliveriesByState('error').map(d => ({ key: d.key, to: d.to_id, error: d.last_error })) },
      messages: this.store.recentMessages(30).map(m => ({ at: m.at, key: m.key, from: m.from_id, to: m.to_id, task: m.task, mode: m.mode, text: m.text.slice(0, 400) })),
      events: this.store.events({ limit: 40 }),
    }
  }
}

/** G6-4：wt 是不是 root 这个仓库的 git worktree（git 公共目录相同，且 wt 本身是一个工作树的根）。 */
export function sameRepoWorktree(wt: string, root: string): boolean {
  try {
    const common = (d: string) => path.resolve(d, execFileSync('git', ['-C', d, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim())
    const top = execFileSync('git', ['-C', wt, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    return fs.realpathSync(top) === fs.realpathSync(wt) && fs.realpathSync(common(wt)) === fs.realpathSync(common(root))
  } catch { return false }
}
