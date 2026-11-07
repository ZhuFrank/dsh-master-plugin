/**
 * 守卫（tools/pre-execute）：纯函数，便于单测。
 * pre-execute 在参数校验之前跑（spike G1 e），所以任何字段都可能缺失或类型不对——拿不准就放行给 DSH 自己校验。
 * 守卫只能拦常见写法；兜底是受管文件的带外改动检测（dsh-master-devlog/docs.ts + 巡检）。
 */
import path from 'node:path'

export interface GuardCall { name: string; args: unknown; role?: 'master' | 'exec' | undefined; cwd?: string | undefined }
export interface GuardConfig {
  protectedPaths: string[]
  /** 命令里可能出现的变量（G3：`$DSH_HOME/dsh-master` 这类写法曾经绕过守卫）。 */
  env?: Record<string, string | undefined>
  /** 执行会话不许直接跑的重活命令（要走 heavy_run）。 */
  heavyPattern?: RegExp
  /** G6-4：受保护目录里放行写的子目录（项目的 <根>/.dsh-master/out/ 产物目录）。 */
  allowPaths?: string[]
  /** G6-4：这个会话是项目成员（工作目录是项目根）⇒ 不许动 git 的暂存区、提交、分支。 */
  noGit?: boolean
  /** G7：只有总管能读的目录（实例日志目录 $DSH_HOME/logs：dsh.log 里有登录令牌，11-06 一个普通会话从这里读到令牌并用 curl 调了接口）。 */
  secretPaths?: string[]
}

/** 会改文件的命令或解释器。 */
const WRITE_OPS = /(>|\btee\b|\bsed\b[^|;&]*\s-i|\bmv\b|\bcp\b|\brm\b|\brsync\b|\btruncate\b|\bdd\b|\bsqlite3\b|\bln\b|\bchmod\b|\bchown\b|\btouch\b|\binstall\b|\bpython3?\b|\bnode\b|\bperl\b|\bruby\b|\bdeno\b|\bbun\b|\bosascript\b|\bunzip\b|\btar\b|\bpatch\b)/
/** sleep 出现在命令位置（照官方原型）。 */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env|timeout)\s)\s*(?:\S*\/)?sleep\b/
const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])
export const DEFAULT_HEAVY = /(^|[\s;&|(])(ffmpeg|mlx_whisper|whisper|demucs|hyperframes\s+render|blender\s+(-b|--background)|mlx_audio\.tts)(?=\s|$)/

export const NO_WAIT = '[dsh-master 守卫] 总管不等待：回报、空闲提醒、后台任务结束都会自己作为消息到达；结束本轮即可，不要 sleep 或长时间等待（单条命令 ≤30 秒，等后台任务 ≤5 秒）。'
export const NO_GIT = '[dsh-master 守卫] 项目成员不提交、不动暂存区和分支（同一个仓库的成员共用一个暂存区，git add / commit / checkout 会互相干扰，也会撞 index.lock）。改完在 master_report 的 body 里列出改了哪些文件，由总管统一提交。只读的 git status / diff / log / show 可以用。'
/** 会改暂存区、提交、分支、工作树整体的 git 子命令（只读的 status / diff / log / show / blame / grep 放行；`checkout -- 文件` / `restore` 只动单个文件，放行）。 */
const GIT_MUTATE = /(?:^|[;&|({!`\n]|\b(?:then|do|else|exec|command|env|nohup|time)\s)\s*(?:\S*\/)?git\b((?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+(add|commit|push|pull|merge|rebase|cherry-pick|revert|reset|stash|tag|am|switch|branch\s+-[dDmM]|checkout(?!\s+--\s))\b/
export const NO_SECRET = '[dsh-master 守卫] 实例日志目录（$DSH_HOME/logs）里有登录令牌，只有总管能读。要查日志里的东西请回报总管，由总管来看。'
export const USE_HEAVY_RUN = '[dsh-master 守卫] 这是重活（渲染 / 转写 / 分离音轨等），请用 heavy_run 工具排队跑：它会先看系统可用内存，同一时间只跑一件，跑完自动通知你。'

function obj(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} }

function under(file: string, dir: string): boolean {
  const rel = path.relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 展开 $VAR / ${VAR} / 开头或空白后的 ~。未知变量原样保留。 */
export function expandVars(command: string, env: Record<string, string | undefined>): string {
  const home = env.HOME
  let out = command.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => env[a ?? b] ?? m)
  if (home) out = out.replace(/(^|[\s=:'"(<>|;&])~(?=\/|$|[\s'"])/g, (_m, pre) => pre + home)
  return out
}

/** 把命令切成「像路径的词」（去引号，按空白和 shell 操作符切）。 */
export function pathTokens(command: string): string[] {
  return command.split(/[\s;&|()<>`]+/).map(t => t.replace(/^['"]+|['"]+$/g, '')).filter(t => t && !t.startsWith('-') && !t.includes('$') && !/^[a-z]+:\/\//i.test(t) && !/^\d+$/.test(t))
}

/** 命令里会被写的目标（重定向、tee、cp/mv 的最后一个参数、sed -i 的文件）——给前情推送用，宁缺勿滥。 */
export function bashWriteTargets(command: string, cwd: string | undefined, env: Record<string, string | undefined>): string[] {
  const cmd = expandVars(command, env)
  const out = new Set<string>()
  const add = (t: string | undefined) => { if (t && !t.startsWith('-') && !t.includes('$') && t !== '/dev/null') out.add(path.resolve(cwd ?? '/', t.replace(/^['"]+|['"]+$/g, ''))) }
  for (const m of cmd.matchAll(/(?:^|[^0-9&>])>{1,2}\s*([^\s;&|<>()]+)/g)) add(m[1])
  for (const seg of cmd.split(/[;&|]+/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean)
    const head = words[0]
    if (head === 'tee') words.slice(1).filter(w => !w.startsWith('-')).forEach(add)
    if ((head === 'cp' || head === 'mv') && words.length >= 3) add(words[words.length - 1])
    if (head === 'sed' && words.some(w => w.startsWith('-i'))) add(words[words.length - 1])
  }
  return [...out]
}

/** write / edit 的目标文件。 */
export function fileToolTarget(call: GuardCall, home?: string): string | undefined {
  if (!FILE_TOOLS.has(call.name)) return undefined
  const args = obj(call.args)
  const raw = args.file_path ?? args.path
  if (typeof raw !== 'string' || !raw) return undefined
  return path.resolve(call.cwd ?? '/', raw.startsWith('~/') && home ? path.join(home, raw.slice(2)) : raw)
}

/** 返回拒绝原因；放行返回 undefined。 */
export function guardDecision(call: GuardCall, cfg: GuardConfig): string | undefined {
  const args = obj(call.args)
  const env = { HOME: process.env.HOME, ...cfg.env }
  if (call.role !== 'master' && cfg.secretPaths?.length && readsSecret(call, cfg.secretPaths, env)) return NO_SECRET
  if (call.name === 'bash' || call.name === 'pwsh') {
    const command = args.command
    if (typeof command === 'string') {
      const expanded = expandVars(command, env)
      // 不写文件的重定向（`2>/dev/null`、`>/dev/null`、`2>&1`）不算写操作（G3 真模型试用：只读的 ls 被误拦）
      const writeProbe = expanded.replace(/\d*>>?\s*\/dev\/null\b/g, ' ').replace(/\d*>&\d+/g, ' ')
      if (WRITE_OPS.test(writeProbe)) {
        // ① 绝对路径（含 $VAR / ~ 展开后的）；② 相对路径按 cwd 解析；③ cwd 本身就在状态目录里
        // 放行的子目录（.dsh-master/out/）先从命令里拿掉，再看剩下的有没有碰受保护目录
        const allow = cfg.allowPaths ?? []
        const probe = allow.reduce((s, a) => s.replace(new RegExp(a.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + `(?=/|$|[\\s'"';&|)])`, 'g'), ' __allowed__'), expanded)
        const hitAbs = cfg.protectedPaths.find(p => probe.includes(p.replace(/\/+$/, '')))
        const hitCwd = !hitAbs && call.cwd && !allow.some(a => under(call.cwd!, a)) ? cfg.protectedPaths.find(p => under(call.cwd!, p)) : undefined
        const hitRel = !hitAbs && !hitCwd && call.cwd ? pathTokens(expanded).map(t => path.resolve(call.cwd!, t)).find(t => !allow.some(a => under(t, a)) && cfg.protectedPaths.some(p => under(t, p))) : undefined
        const hit = hitAbs ?? (hitCwd ? `${call.cwd}（工作目录就在状态目录里）` : undefined) ?? hitRel
        if (hit) return `[dsh-master 守卫] 总管状态目录只能通过 dsh-master 工具改，不能用命令直接写：${hit}（读取可以用 read 工具）`
      }
      if (call.role === 'exec' && (cfg.heavyPattern ?? DEFAULT_HEAVY).test(expanded)) return USE_HEAVY_RUN
      if (call.role === 'exec' && cfg.noGit && GIT_MUTATE.test(expanded)) return NO_GIT
      if (call.role === 'master') {
        if (SLEEP.test(command)) return NO_WAIT
        if (typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
      }
    }
  }
  const target = fileToolTarget(call, env.HOME)
  if (target) {
    const hit = (cfg.allowPaths ?? []).some(a => under(target, a)) ? undefined : cfg.protectedPaths.find(p => under(target, p))
    if (hit) return `[dsh-master 守卫] 总管状态目录只能通过 dsh-master 工具改，不能直接写：${target}`
  }
  if (call.role === 'master' && call.name === 'job_output' && args.wait === true && typeof args.timeout_ms === 'number' && args.timeout_ms > 5_000) return NO_WAIT
  return undefined
}

/** G7：这次调用会不会读到只有总管能读的目录（命令里的路径、工作目录、读类工具的路径参数）。宁可多拦：成员和未入编会话本来就用不着实例日志。 */
function readsSecret(call: GuardCall, secret: string[], env: Record<string, string | undefined>): boolean {
  const dirs = secret.map(d => d.replace(/\/+$/, ''))
  const hit = (p: string) => dirs.some(d => under(p, d))
  const args = obj(call.args)
  if (call.cwd && hit(call.cwd)) return true
  if (call.name === 'bash' || call.name === 'pwsh') {
    const command = args.command
    if (typeof command !== 'string') return false
    const full = expandVars(command, env)
    if (dirs.some(d => full.includes(d))) return true
    return pathTokens(full).some(t => hit(path.resolve(call.cwd ?? '/', t)))
  }
  const home = env.HOME
  const vals: string[] = []
  for (const k of ['file_path', 'path', 'paths', 'dir', 'directory', 'cwd']) {
    const v = args[k]
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) vals.push(x)
  }
  return vals.some(raw => hit(path.resolve(call.cwd ?? '/', raw.startsWith('~/') && home ? path.join(home, raw.slice(2)) : expandVars(raw, env))))
}
