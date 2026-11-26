/**
 * 守卫（tools/pre-execute）：纯函数，便于单测。
 * pre-execute 在参数校验之前跑（spike G1 e），所以任何字段都可能缺失或类型不对——拿不准就放行给 DSH 自己校验。
 * 守卫只能拦常见写法；兜底是受管文件的带外改动检测（dsh-master-devlog/docs.ts + 巡检）。
 */
import path from 'node:path'
import { normalizePwsh, lexPwsh, expandPwsh, pwshTouches, notReadOnly, pwshHeavy, pwshGitMutates, pwshSleeps, underP, normPathToken, type PathImpl } from './guard-pwsh.ts'

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
  /**
   * G18：凭据文件 / 目录（$DSH_HOME/.credentials.yaml 存模型 key 和网页登录 cookie 的签名密钥；$DSH_HOME/.env；liveshare/ 的管理 token）。
   * 任何会话都不能直接读写，总管也不行（总管的活用不着 key）。读整个目录树时只拦凭据所在目录本身和它们之间的目录，不拦更上级（见 README 已知问题）。
   */
  credentialPaths?: string[]
  /** G16：路径实现（默认 node:path，跟运行平台走；单测传 path.win32 在 Mac 上测 Windows 路径）。 */
  pathImpl?: PathImpl
  /** G16：'heavy' = heavy_run 提交前的检查：不查「成员直接跑重活」和「总管等待」（重活本来就排队在后台跑）。 */
  context?: 'tool' | 'heavy'
}

/** 会改文件的命令或解释器。 */
const WRITE_OPS = /(>|\btee\b|\bsed\b[^|;&]*\s-i|\bmv\b|\bcp\b|\brm\b|\brsync\b|\btruncate\b|\bdd\b|\bsqlite3\b|\bln\b|\bchmod\b|\bchown\b|\btouch\b|\binstall\b|\bpython3?\b|\bnode\b|\bperl\b|\bruby\b|\bdeno\b|\bbun\b|\bosascript\b|\bunzip\b|\btar\b|\bpatch\b)/
/** sleep 出现在命令位置（照官方原型）。 */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env|timeout)\s)\s*(?:\S*\/)?sleep\b/
const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])
export const DEFAULT_HEAVY = /(^|[\s;&|(])(ffmpeg|mlx_whisper|whisper|demucs|hyperframes\s+render|blender\s+(-b|--background)|mlx_audio\.tts)(?=\s|$)/

/** G16-4：写清 sleep 一律拦（G16-3 真机上模型看到「≤30 秒」以为 20 秒的 sleep 会放行）。 */
export const NO_WAIT = '[dsh-master 守卫] 总管不等待：回报、空闲提醒、后台任务结束都会自己作为消息到达，结束本轮即可。sleep / Start-Sleep 一律拦，和时长无关；单条命令不超过 30 秒，等后台任务不超过 5 秒。'
export const NO_GIT = '[dsh-master 守卫] 项目成员不提交、不动暂存区和分支（同一个仓库的成员共用一个暂存区，git add / commit / checkout 会互相干扰，也会撞 index.lock）。改完在 master_report 的 body 里列出改了哪些文件，由总管统一提交。只读的 git status / diff / log / show 可以用。'
/** 会改暂存区、提交、分支、工作树整体的 git 子命令（只读的 status / diff / log / show / blame / grep 放行；`checkout -- 文件` / `restore` 只动单个文件，放行）。 */
const GIT_MUTATE = /(?:^|[;&|({!`\n]|\b(?:then|do|else|exec|command|env|nohup|time)\s)\s*(?:\S*\/)?git\b((?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+(add|commit|push|pull|merge|rebase|cherry-pick|revert|reset|stash|tag|am|switch|branch\s+-[dDmM]|checkout(?!\s+--\s))\b/
export const NO_SECRET = '[dsh-master 守卫] 实例日志目录（$DSH_HOME/logs）里有登录令牌，只有总管能读。要查日志里的东西请回报总管，由总管来看。'
export const NO_CREDENTIAL = '[dsh-master 守卫] 这是 DSH 的凭据文件（$DSH_HOME/.credentials.yaml、.env 等，存着模型 key 和网页登录的签名密钥），任何会话都不能直接读写或整个目录打包、递归搜索，总管也不行。要看或改模型 key，请让用户到「设置 → 模型」里操作；连不上模型这类问题，把现象回报给用户。'
export const USE_HEAVY_RUN = '[dsh-master 守卫] 这是重活（渲染 / 转写 / 分离音轨等），请用 heavy_run 工具排队跑：它会先看系统可用内存，同一时间只跑一件，跑完自动通知你。'

function obj(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} }

function under(file: string, dir: string, P: PathImpl = path): boolean {
  const rel = P.relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel))
}

/** G16（Q5）：工具参数 workdir 改的是这条命令的工作目录（DSH 的 bash / pwsh 工具都有），守卫按它算相对路径。 */
export function effectiveCwd(call: GuardCall, env: Record<string, string | undefined>, P: PathImpl = path): string | undefined {
  const wd = obj(call.args).workdir
  if (typeof wd !== 'string' || !wd.trim()) return call.cwd
  const w = call.name === 'pwsh' ? expandPwsh(wd, env, call.cwd) : expandVars(wd, env)
  return P.resolve(call.cwd ?? (P.sep === '\\' ? 'C:\\' : '/'), w)
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
export function bashWriteTargets(command: string, cwd: string | undefined, env: Record<string, string | undefined>, P: PathImpl = path): string[] {
  const cmd = expandVars(command, env)
  const out = new Set<string>()
  const add = (t: string | undefined) => { if (t && !t.startsWith('-') && !t.includes('$') && t !== '/dev/null') out.add(P.resolve(cwd ?? '/', t.replace(/^['"]+|['"]+$/g, ''))) }
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
  const P = cfg.pathImpl ?? path
  const cwd = effectiveCwd(call, env, P)
  if (cfg.credentialPaths?.length && touchesCredential({ ...call, cwd }, cfg.credentialPaths, env, P)) return NO_CREDENTIAL
  if (call.role !== 'master' && cfg.secretPaths?.length && readsSecret({ ...call, cwd }, cfg.secretPaths, env, P)) return NO_SECRET
  if (call.name === 'pwsh') { const r = pwshDecision(call, cfg, env, P, cwd); if (r) return r }
  if (call.name === 'bash') {
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
        const hitCwd = !hitAbs && cwd && !allow.some(a => under(cwd, a, P)) ? cfg.protectedPaths.find(p => under(cwd, p, P)) : undefined
        const hitRel = !hitAbs && !hitCwd && cwd ? pathTokens(expanded).map(t => P.resolve(cwd, t)).find(t => !allow.some(a => under(t, a, P)) && cfg.protectedPaths.some(p => under(t, p, P))) : undefined
        const hit = hitAbs ?? (hitCwd ? `${cwd}（工作目录就在状态目录里）` : undefined) ?? hitRel
        if (hit) return protectedMsg(hit)
      }
      if (cfg.context !== 'heavy' && call.role === 'exec' && (cfg.heavyPattern ?? DEFAULT_HEAVY).test(expanded)) return USE_HEAVY_RUN
      if (call.role === 'exec' && cfg.noGit && GIT_MUTATE.test(expanded)) return NO_GIT
      if (cfg.context !== 'heavy' && call.role === 'master') {
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

const protectedMsg = (hit: string) => `[dsh-master 守卫] 总管状态目录只能通过 dsh-master 工具改，不能用命令直接写：${hit}（读取可以用 read 工具）`

/**
 * G16（W9）：PowerShell 命令。碰到受保护路径时只放行只读命令（guard-pwsh.ts）；成员直接跑重活 / 动 git、总管等待照 bash 的规则，
 * 另外不分大小写、认 .exe 和路径前缀。bash 的旧正则也照样过一遍（pwsh 现在能拦的改后照拦）。
 */
function pwshDecision(call: GuardCall, cfg: GuardConfig, env: Record<string, string | undefined>, P: PathImpl, cwd: string | undefined): string | undefined {
  const args = obj(call.args)
  const command = args.command
  if (typeof command !== 'string') return undefined
  const expanded = expandPwsh(normalizePwsh(command), env, cwd)
  const toks = lexPwsh(expanded)
  const bashish = expandVars(command, env)
  const allow = cfg.allowPaths ?? []
  const hit = pwshTouches(expanded, toks, cfg.protectedPaths, { P, cwd, allow })
    ?? (cwd ? pathTokens(bashish).map(t => P.resolve(cwd, t)).find(t => !allow.some(a => underP(t, a, P)) && cfg.protectedPaths.some(p => underP(t, p, P))) : undefined)
  if (hit && notReadOnly(toks)) return protectedMsg(hit)
  if (cfg.context !== 'heavy' && call.role === 'exec') {
    const custom = cfg.heavyPattern
    if (pwshHeavy(toks) || (custom ?? DEFAULT_HEAVY).test(bashish) || (custom && new RegExp(custom.source, custom.flags.includes('i') ? custom.flags : custom.flags + 'i').test(bashish))) return USE_HEAVY_RUN
  }
  if (call.role === 'exec' && cfg.noGit && (pwshGitMutates(toks) || GIT_MUTATE.test(bashish))) return NO_GIT
  if (cfg.context !== 'heavy' && call.role === 'master') {
    if (SLEEP.test(command) || pwshSleeps(toks)) return NO_WAIT
    if (typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
  }
  return undefined
}

/** G7：这次调用会不会读到只有总管能读的目录（命令里的路径、工作目录、读类工具的路径参数）。宁可多拦：成员和未入编会话本来就用不着实例日志。 */
function readsSecret(call: GuardCall, secret: string[], env: Record<string, string | undefined>, P: PathImpl = path): boolean {
  const dirs = secret.map(d => d.replace(/\/+$/, ''))
  const hit = (p: string) => dirs.some(d => under(p, d, P))
  const args = obj(call.args)
  if (call.cwd && hit(call.cwd)) return true
  if (call.name === 'bash' || call.name === 'pwsh') {
    const command = args.command
    if (typeof command !== 'string') return false
    const full = expandVars(command, env)
    if (dirs.some(d => full.includes(d))) return true
    if (pathTokens(full).some(t => hit(P.resolve(call.cwd ?? '/', t)))) return true
    if (call.name !== 'pwsh') return false
    const ex = expandPwsh(normalizePwsh(command), env, call.cwd)
    return !!pwshTouches(ex, lexPwsh(ex), dirs, { P, cwd: call.cwd, allow: [], nameRules: false }) // logs 太常见：不用「路径段名」宽规则
  }
  const home = env.HOME
  const vals: string[] = []
  for (const k of ['file_path', 'path', 'paths', 'dir', 'directory', 'cwd']) {
    const v = args[k]
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) vals.push(x)
  }
  return vals.some(raw => hit(P.resolve(call.cwd ?? '/', raw.startsWith('~/') && home ? path.join(home, raw.slice(2)) : expandVars(raw, env))))
}

// ---------------- G18：凭据文件 ----------------

/** 会读整棵目录内容的 bash 写法（递归 grep、rg / ag、打包、复制目录、find -exec、xargs）。只列名字的 ls -R / find（不带 -exec）不算。 */
const RECURSIVE_BASH = /(?:^|[\s;&|(`!])(?:(?:e|f)?grep\b[^;&|\n]*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive|--directories=recurse|-d\s*recurse)(?=[\s'"]|$)|(?:rg|ag|ack|tar|zip|7z|rsync|scp|zstd|gzip|base64|xxd|od|strings)\b|cp\b[^;&|\n]*\s-[a-zA-Z]*[rRa][a-zA-Z]*(?=\s|$)|find\b[^;&|\n]*\s-(?:exec|execdir|ok|fprint)\b|xargs\b)/
/** PowerShell 里会读整棵目录内容的写法。 */
const RECURSIVE_PWSH = /(?:-r(?:ecurse)?\b|-depth\b|compress-archive|robocopy|xcopy|\btar\b|copy-item|\bcpi\b|\bcopy\b|\bcp\b|select-string|\bsls\b|findstr\b[^;|]*\/s\b|::(?:getfiles|enumeratefiles|getfilesystementries|enumeratefilesystementries)\b|io\.compression|\bzip\b|\brg\b)/i
/** 按内容递归搜索的读类工具（DSH 的 grep 一类）；glob / ls 只列名字。 */
const RECURSIVE_TOOL = /grep|search|ripgrep|find_in/i

/** 路径通配（* ? [..]）→ 正则；* 也匹配点开头的名字（宁可多拦），** 跨目录。Windows 不分大小写、两种斜杠都认。 */
function globToRe(p: string, P: PathImpl): RegExp {
  const win = P.sep === '\\'
  const sep = win ? '[\\\\/]' : '/'
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!
    if (ch === '*') { if (p[i + 1] === '*') { re += '.*'; i++ } else re += win ? '[^\\\\/]*' : '[^/]*'; continue }
    if (ch === '?') { re += win ? '[^\\\\/]' : '[^/]'; continue }
    if (ch === '[') { const j = p.indexOf(']', i + 1); if (j > i) { re += '[' + p.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; continue } }
    if (win && (ch === '\\' || ch === '/')) { re += sep; continue }
    re += ch.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$', win ? 'i' : '')
}
const hasGlobChar = (t: string) => /[*?]|\[[^\]]+\]/.test(t)

/** 凭据 c 和它所在目录（DSH_HOME）之间的目录（含两头）：对这些目录做递归读 = 读到凭据。 */
function credDirs(c: string, P: PathImpl): string[] {
  const root = P.dirname(c)
  const out = [root]
  for (let d = c; d !== root && P.dirname(d) !== d; d = P.dirname(d)) out.push(d)
  return out
}

/**
 * G18：这次调用会不会读到（或改到）凭据文件。
 * ① 命令原文（展开变量、去引号后）包含凭据路径；② 工作目录 / cd / workdir 之后的相对路径、路径词解析后正好是凭据（或在凭据目录里）；
 * ③ 通配符匹配到凭据；④ 递归读（grep -r、打包、复制目录……）的目标是凭据所在目录；⑤ 「.credentials.yaml」这个名字和没展开的变量 / ~ / DSH_HOME 一起出现；
 * ⑥ 读类工具的路径参数。拿不准的放行（凭据守卫只是减速带，见 README 已知问题）。
 */
export function touchesCredential(call: GuardCall, creds: string[], env: Record<string, string | undefined>, P: PathImpl = path): boolean {
  const win = P.sep === '\\'
  const files = creds.map(c => P.resolve(c.replace(/[\\/]+$/, '')))
  const norm = (s: string) => win ? s.toLowerCase().replace(/\//g, '\\') : s
  const inCred = (p: string) => files.some(c => under(p, c, P))
  const inDirRange = (p: string) => files.some(c => credDirs(c, P).some(d => P.relative(d, p) === ''))
  const globHit = (abs: string, recursive: boolean) => { const re = globToRe(abs, P); return files.some(c => re.test(c) || (recursive && credDirs(c, P).some(d => re.test(d)))) }
  const named = files.map(c => P.basename(c)).filter(b => b.startsWith('.') && b.toLowerCase() !== '.env')
  const roots = [...new Set(files.map(c => norm(P.dirname(c))))]
  const args = obj(call.args)
  const cwd = call.cwd

  if (call.name === 'bash' || call.name === 'pwsh') {
    const command = args.command
    if (typeof command !== 'string') return false
    const isPwsh = call.name === 'pwsh'
    const full = isPwsh ? expandPwsh(normalizePwsh(command), env, cwd) : expandVars(command, env)
    const flat = norm(full.replace(/['"`]/g, '').replace(/\\ /g, ' '))
    // ① 原文包含（后面要有边界：.env 不能命中 .envrc）
    for (const c of files) {
      const nc = norm(c)
      for (let at = flat.indexOf(nc); at >= 0; at = flat.indexOf(nc, at + 1)) if (/^($|[\\/\s;|&)}\],>])/.test(flat.slice(at + nc.length))) return true
    }
    const recursive = (isPwsh ? RECURSIVE_PWSH : RECURSIVE_BASH).test(full)
    // ② cwd / cd 去过的目录
    const bases: string[] = [cwd ?? (win ? 'C:\\' : '/')]
    if (isPwsh) {
      const ex = full
      if (pwshTouches(ex, lexPwsh(ex), files, { P, cwd, nameRules: false, allow: [] })) return true
      for (const m of ex.matchAll(/(?:^|[;|&({\s])(?:cd|chdir|sl|set-location|pushd|push-location)\s+(?:-(?:literal)?path\s+)?(['"]?)([^'";|&)\s]+)\1/gi)) bases.push(P.resolve(bases[0]!, m[2]!))
    } else {
      for (const m of full.matchAll(/(?:^|[;&|(\n!]|\b(?:then|do|else)\s)\s*(?:cd|pushd)\s+(['"]?)([^'";&|)\s]+)\1/g)) bases.push(P.resolve(bases[0]!, m[2]!))
      if (typeof args.workdir === 'string' && cwd) bases.push(cwd)
    }
    if (bases.some(b => inCred(b))) return true
    if (recursive && bases.some(b => inDirRange(b))) return true
    const toks = isPwsh ? lexPwsh(full).filter(t => t.t === 'word' || t.t === 'str').flatMap(t => t.v.split(',')).map(v => normPathToken(v, P)).filter((v): v is string => !!v)
      : full.split(/[\s;&|()<>`=]+/).map(t => t.replace(/^['"]+|['"]+$/g, '').replace(/^--?[\w-]+=/, '')).filter(t => t && !t.startsWith('-') && !t.includes('$') && !/^[a-z]+:\/\//i.test(t))
    for (const t of toks) {
      for (const b of bases) {
        const r = P.resolve(b, t)
        if (hasGlobChar(t)) { if (globHit(r, recursive)) return true; continue }
        if (inCred(r)) return true // ② 正好是凭据 / 在凭据目录里
        if (recursive && inDirRange(r)) return true // ④ 递归读凭据所在目录
      }
    }
    // ⑤ 名字 + 没展开的变量 / ~ / DSH_HOME 一起出现（Join-Path $x '.credentials.yaml'、"$D/.credentials.yaml"）
    const low = full.toLowerCase()
    if (named.some(n => low.includes(n.toLowerCase())) && (/[$~%]/.test(full) || roots.some(r => flat.includes(r)))) return true
    return false
  }

  // ⑥ 读类工具（read / grep / 其他插件的工具）：路径参数
  const home = env.HOME
  const vals: string[] = []
  for (const k of ['file_path', 'path', 'paths', 'dir', 'directory', 'file', 'files', 'filename', 'target', 'cwd', 'workdir']) {
    const v = args[k]
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) vals.push(x)
  }
  const recursive = RECURSIVE_TOOL.test(String(call.name ?? ''))
  for (const raw of vals) {
    const ex = raw.startsWith('~/') && home ? P.join(home, raw.slice(2)) : (call.name === 'pwsh' ? raw : expandVars(raw, env))
    const r = P.resolve(cwd ?? (win ? 'C:\\' : '/'), ex)
    if (hasGlobChar(ex)) { if (globHit(r, recursive)) return true; continue }
    if (inCred(r)) return true
    if (recursive && inDirRange(r)) return true
  }
  // grep 类工具：路径没给就是在工作目录里搜
  if (recursive && !vals.length && cwd && inDirRange(cwd)) return true
  return false
}
