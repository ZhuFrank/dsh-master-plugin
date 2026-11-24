/**
 * G16（W9）：PowerShell 命令的守卫判断。纯函数；路径实现可注入（生产上按 process.platform，单测传 path.win32）。
 *
 * 思路和 bash 不同：PowerShell 的别名、.NET 写法、动态调用太多，写操作名单补不全；它的命令是「动词-名词」，只读的反而列得全。
 * ⇒ 命令里一旦碰到受保护路径，命令位置上的每个词、每个方法调用、每个属性赋值、每个重定向都必须是只读的，否则拦。
 * 拿不准的一律算「不是只读」（宁可多拦：拒绝提示里让用 read 工具读）。认不出的写法靠带外检测兜底（见 guard.ts 头注释）。
 */
import nodePath from 'node:path'

export type PathImpl = typeof nodePath.posix

// ---------------- 拆词 ----------------

export interface Tok { t: 'word' | 'str' | 'op' | 'redir'; v: string; adj: boolean }

const OP_CHARS = new Set([';', '|', '&', '(', ')', '{', '}', ','])
const QUOTE_MAP: Record<string, string> = { '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u201c': '"', '\u201d': '"', '\u201e': '"' }
const DASHES = /[\u2013\u2014\u2015]/g

/** 弯引号 → 直引号，长破折号 → `-`（PowerShell 都认）。反引号转义在拆词时按位置处理（单引号里它是普通字符）。 */
export function normalizePwsh(command: string): string {
  return command.replace(/[\u2018\u2019\u201a\u201b\u201c\u201d\u201e]/g, c => QUOTE_MAP[c]!).replace(DASHES, '-')
}

/** 拆成词 / 字符串 / 操作符 / 重定向；双引号里的 `$( … )` 子表达式拆出来接在后面（它会执行命令）。 */
export function lexPwsh(src: string): Tok[] { return lexAt(src, 0, false).toks }

function lexAt(src: string, start: number, untilParen: boolean): { toks: Tok[]; end: number } {
  const out: Tok[] = []
  let i = start
  let ws = true
  let depth = 0
  const push = (t: Tok['t'], v: string) => { out.push({ t, v, adj: !ws }); ws = false }
  while (i < src.length) {
    const c = src[i]!
    if (c === '`' && (src[i + 1] === '\n' || src[i + 1] === '\r')) { i += src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2; ws = true; continue } // 续行
    if (c === ' ' || c === '\t') { i++; ws = true; continue }
    if (c === '\n' || c === '\r') { push('op', ';'); i++; ws = true; continue }
    if (c === '<' && src[i + 1] === '#') { const e = src.indexOf('#>', i + 2); i = e < 0 ? src.length : e + 2; ws = true; continue }
    if (c === '#' && ws) { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '@' && (src[i + 1] === "'" || src[i + 1] === '"') && /^[ \t]*\r?\n/.test(src.slice(i + 2))) { // here-string
      const q = src[i + 1]!; const end = src.indexOf(`\n${q}@`, i + 2)
      const body = src.slice(i + 2, end < 0 ? src.length : end).replace(/^[ \t]*\r?\n/, '')
      if (q === '"') { const r = dqScan(body, 0, false); push('str', r.v); out.push(...r.sub) } else push('str', body)
      i = end < 0 ? src.length : end + 3; continue
    }
    if (c === "'") {
      let j = i + 1; let v = ''
      while (j < src.length) { if (src[j] === "'" && src[j + 1] === "'") { v += "'"; j += 2; continue } if (src[j] === "'") break; v += src[j]; j++ }
      push('str', v); i = j + 1; continue
    }
    if (c === '"') { const r = dqScan(src, i + 1, true); push('str', r.v); out.push(...r.sub); i = r.end + 1; continue }
    const rd = /^(?:\d|\*)?>>?(?:&\d)?/.exec(src.slice(i))
    if (rd) { push('redir', rd[0]); i += rd[0].length; continue }
    if ((c === '$' || c === '@') && src[i + 1] === '(') { push('op', '('); depth++; i += 2; continue }
    if (c === '@' && src[i + 1] === '{') { push('op', '@{'); i += 2; continue }
    if (c === '&' && src[i + 1] === '&') { push('op', '&&'); i += 2; continue }
    if (c === '|' && src[i + 1] === '|') { push('op', '||'); i += 2; continue }
    if (c === '(') { push('op', '('); depth++; i++; continue }
    if (c === ')') { if (untilParen && depth === 0) return { toks: out, end: i }; depth--; push('op', ')'); i++; continue }
    if (OP_CHARS.has(c)) { push('op', c); i++; continue }
    if (c === '=') { push('op', '='); i++; continue }
    // 词：到空白 / 操作符 / 引号为止；反引号转义下一个字符；`$x=` `.Prop=` `$x+=` 里的 = 单独成操作符（赋值），别的词里的 = 照留（--format=x）
    let j = i; let v = ''
    while (j < src.length) {
      const d = src[j]!
      if (d === '`' && j + 1 < src.length && src[j + 1] !== '\n' && src[j + 1] !== '\r') { v += src[j + 1]; j += 2; continue }
      if (d === ' ' || d === '\t' || d === '\n' || d === '\r' || OP_CHARS.has(d) || d === '"' || d === "'") break
      const varLike = v.startsWith('$') || v.startsWith('.')
      if (d === '=' && (varLike || /^[+\-*/%]$/.test(v) || v === '')) break
      if ('+-*/%'.includes(d) && src[j + 1] === '=' && varLike) break
      if (d === '>' && v !== '') break
      if (d === '[' && v === '') { // 只在词首认类型字面量 [IO.File]、[string[]]；中间不许有空白和操作符
        let k = j; let dep = 0
        for (; k < src.length; k++) { const e = src[k]!; if (e === '[') dep++; else if (e === ']') { dep--; if (dep === 0) break } else if (!/[\w.,`]/.test(e)) { k = -1; break } }
        if (k > j && dep === 0) { v += src.slice(j, k + 1); j = k + 1; continue }
      }
      v += d; j++
    }
    if (/^[+\-*/%]$/.test(v) && src[j] === '=') { push('op', '='); i = j + 1; continue } // += -= …
    if (v === '' && j === i) { push('word', c); i++; continue }
    push('word', v); i = j
  }
  return { toks: out, end: i }
}

/** 双引号字符串：`x 转义、"" 是一个引号、$( … ) 用拆词器自己配对括号（括号在引号里也不乱）。closeOnQuote=false 用于 here-string 正文。 */
function dqScan(src: string, start: number, closeOnQuote: boolean): { v: string; sub: Tok[]; end: number } {
  let k = start; let v = ''; const sub: Tok[] = []
  while (k < src.length) {
    const ch = src[k]!
    if (ch === '`' && k + 1 < src.length) { v += src[k + 1]; k += 2; continue }
    if (closeOnQuote && ch === '"') { if (src[k + 1] === '"') { v += '"'; k += 2; continue } break }
    if (ch === '$' && src[k + 1] === '(') {
      const r = lexAt(src, k + 2, true)
      sub.push({ t: 'op', v: ';', adj: false }, ...r.toks, { t: 'op', v: ';', adj: false })
      v += ' '; k = r.end + 1; continue
    }
    v += ch; k++
  }
  return { v, sub, end: k }
}

// ---------------- 名字 ----------------

/** 结构关键字：不是命令。return / throw / exit / in（foreach (… in <管道>)）后面接的是命令位置。 */
const KEYWORDS = new Set(['if', 'elseif', 'else', 'switch', 'while', 'for', 'foreach', 'do', 'until', 'try', 'catch', 'finally', 'trap', 'return', 'throw', 'break', 'continue', 'exit', 'param', 'begin', 'process', 'end', 'function', 'filter', 'in', 'data', 'dynamicparam'])
const KEYWORD_THEN_CMD = new Set(['return', 'throw', 'exit', 'in'])
/** 只读别名 → 规范名（只读白名单用）。 */
const READ_ALIASES: Record<string, string> = {
  gc: 'get-content', cat: 'get-content', type: 'get-content', ls: 'get-childitem', dir: 'get-childitem', gci: 'get-childitem', gi: 'get-item',
  gp: 'get-itemproperty', gl: 'get-location', pwd: 'get-location', gu: 'get-unique', gm: 'get-member', gcm: 'get-command', gal: 'get-alias', gv: 'get-variable',
  gps: 'get-process', ps: 'get-process', gdr: 'get-psdrive', sls: 'select-string', select: 'select-object', where: 'where-object', '?': 'where-object',
  '%': 'foreach-object', foreach: 'foreach-object', sort: 'sort-object', group: 'group-object', measure: 'measure-object', fl: 'format-list', ft: 'format-table',
  fw: 'format-wide', fc: 'format-custom', echo: 'write-output', write: 'write-output', cd: 'set-location', chdir: 'set-location', sl: 'set-location',
  pushd: 'push-location', popd: 'pop-location', rvpa: 'resolve-path', compare: 'compare-object', diff: 'compare-object', sleep: 'start-sleep', oh: 'out-host',
}
const READ_VERBS = ['get-', 'select-', 'test-', 'measure-', 'compare-', 'resolve-', 'split-', 'join-', 'format-', 'convertto-', 'convertfrom-']
const READ_CMDLETS = new Set(['out-string', 'out-null', 'out-host', 'out-default', 'where-object', 'foreach-object', 'sort-object', 'group-object',
  'write-output', 'write-host', 'write-verbose', 'write-warning', 'write-error', 'write-information', 'write-debug', 'set-location', 'push-location', 'pop-location', 'start-sleep'])
/** 只读的原生程序（git 另按子命令判）。 */
const READ_NATIVE = new Set(['findstr', 'find', 'more', 'whoami', 'hostname'])
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'cat-file', 'version', 'help'])
/** 只读子命令也能写文件 / 跑程序的参数（--output、外部 diff、grep 用分页器打开文件……）。 */
const GIT_UNSAFE_ARG = /^(--output|--ext-diff|--textconv|-O|--open-files-in-pager|--exec-path|--config-env|--upload-pack|--receive-pack)/
const GIT_MUTATE = new Set(['add', 'commit', 'push', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'stash', 'tag', 'am', 'switch'])
/** 只读的实例成员（方法调用、`% 成员名`）。不含 Replace（FileInfo.Replace 会覆盖文件；字符串替换用 -replace 运算符）。 */
const READ_MEMBERS = new Set(['tostring', 'trim', 'trimstart', 'trimend', 'split', 'substring', 'tolower', 'toupper', 'tolowerinvariant', 'toupperinvariant',
  'contains', 'startswith', 'endswith', 'indexof', 'lastindexof', 'gettype', 'equals', 'padleft', 'padright', 'where', 'foreach', 'readtoend', 'readline',
  'adddays', 'addhours', 'addminutes', 'addseconds', 'addmilliseconds', 'addmonths', 'addyears', 'getenumerator', 'toarray',
  'name', 'fullname', 'basename', 'extension', 'length', 'directoryname', 'directory', 'exists', 'lastwritetime', 'creationtime', 'mode', 'pspath', 'count', 'getfiles', 'getdirectories', 'enumeratefiles'])
/** 只读的静态调用：类型（去掉 System. 前缀，小写）→ 方法；'*' = 这个类型的方法都只读。 */
const READ_STATIC: Record<string, Set<string> | '*'> = {
  'io.file': new Set(['readalltext', 'readalllines', 'readallbytes', 'readlines', 'exists', 'openread', 'opentext', 'getattributes', 'getlastwritetime', 'getcreationtime', 'getlastaccesstime']),
  'io.directory': new Set(['exists', 'getfiles', 'getdirectories', 'getfilesystementries', 'enumeratefiles', 'enumeratedirectories', 'enumeratefilesystementries', 'getcurrentdirectory', 'getparent', 'getlastwritetime']),
  'io.path': '*', string: '*', math: '*', regex: '*', datetime: '*', guid: '*', char: '*', int: '*', convert: '*', 'text.encoding': '*', timespan: '*',
}
/** 写文件的 cmdlet 和别名 → 规范名（写目标解析、通配符判断用）。 */
const WRITERS: Record<string, string> = {
  'set-content': 'set-content', sc: 'set-content', 'add-content': 'add-content', ac: 'add-content', 'clear-content': 'clear-content', clc: 'clear-content',
  'out-file': 'out-file', 'tee-object': 'tee-object', tee: 'tee-object', 'export-csv': 'export-csv', epcsv: 'export-csv', 'export-clixml': 'export-clixml',
  'new-item': 'new-item', ni: 'new-item', mkdir: 'new-item', md: 'new-item', 'remove-item': 'remove-item', ri: 'remove-item', rm: 'remove-item', rmdir: 'remove-item',
  rd: 'remove-item', del: 'remove-item', erase: 'remove-item', 'copy-item': 'copy-item', cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item',
  'move-item': 'move-item', mv: 'move-item', move: 'move-item', mi: 'move-item', 'rename-item': 'rename-item', ren: 'rename-item', rni: 'rename-item',
  'clear-item': 'clear-item', cli: 'clear-item', 'set-item': 'set-item', si: 'set-item',
}
const LOCATION_CMDS = new Set(['set-location', 'push-location'])
const PATH_PARAMS = ['path', 'literalpath', 'filepath', 'pspath', 'lp']
const DEST_PARAMS = ['destination', 'outfile']
/** 带值的非路径参数（解析位置参数时跳过它们的值）；其余没列的当开关（-Force、-Recurse…）。 */
const VALUE_PARAMS = ['value', 'itemtype', 'encoding', 'filter', 'include', 'exclude', 'credential', 'delimiter', 'inputobject', 'stream', 'width', 'type', 'target',
  'variable', 'outvariable', 'errorvariable', 'warningvariable', 'informationvariable', 'pipelinevariable']

export interface Cmd { name: string; raw: string; args: Tok[]; dynamic: boolean; pathLike: boolean }

/** 命令位置上的词 → 规范名：去掉模块前缀，路径形式的取文件名、去掉 .exe 等后缀；小写。pathLike = 带路径或扩展名（是程序 / 脚本，不是 cmdlet）。 */
export function commandName(word: string): { name: string; pathLike: boolean } {
  const w = word.toLowerCase()
  const ext = /\.(exe|cmd|bat|com|ps1|psm1|vbs|js|py)$/.test(w)
  const sep = /[\\/]/.test(w)
  // 模块限定的 cmdlet：Microsoft.PowerShell.Management\Set-Content（前缀不是盘符 / . / ~ 开头，最后一段是 动词-名词、没有扩展名）
  const moduleQualified = sep && !ext && /^[a-z][\w.]*\\[a-z]+-[a-z]+$/.test(w)
  const last = sep ? (w.split(/[\\/]/).pop() ?? w) : w
  return { name: last.replace(/\.(exe|cmd|bat|com|ps1)$/, ''), pathLike: (sep && !moduleQualified) || ext }
}

// ---------------- 语句 ----------------

/** 按命令位置切出每条命令（名字 + 后面的参数，到下一个 ; | && || ( ) { } = 为止）。hashtable @{ 键 = 值 } 的键不是命令。 */
export function commands(toks: Tok[]): Cmd[] {
  const out: Cmd[] = []
  const stack: string[] = []
  let atCmd = true
  let cur: Cmd | undefined
  let afterCall = false
  const inHash = () => stack[stack.length - 1] === '@{'
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k]!
    if (afterCall && tk.t === 'op' && (tk.v === '(' || tk.v === '{')) { // & (…) / & { … }：动态调用
      afterCall = false; cur = { name: '(', raw: `& ${tk.v}`, args: [], dynamic: true, pathLike: false }; out.push(cur); stack.push(tk.v); atCmd = true; continue
    }
    if (tk.t === 'op') {
      if (tk.v === '(' || tk.v === '{' || tk.v === '@{') stack.push(tk.v)
      if (tk.v === ')' || tk.v === '}') stack.pop()
      if ([';', '|', '&&', '||', '(', ')', '{', '}', '=', '@{'].includes(tk.v)) {
        cur = undefined; afterCall = false
        atCmd = tk.v === '=' ? true : !inHash()
        continue
      }
      if (tk.v === '&') { cur = undefined; atCmd = true; afterCall = true; continue } // 调用符（或后台运行）：下一个是被调用的东西
    }
    if (atCmd) {
      atCmd = false
      if (afterCall) {
        afterCall = false
        const dyn = !(tk.t === 'str' || (tk.t === 'word' && !tk.v.startsWith('$')))
        const cn = commandName(tk.v)
        cur = { name: cn.name, raw: tk.v, args: [], dynamic: dyn, pathLike: cn.pathLike || tk.t === 'str' }; out.push(cur); continue
      }
      if (tk.t === 'word') {
        const lw = tk.v.toLowerCase()
        if (lw === '.') { atCmd = true; afterCall = true; continue } // 点调用（dot-source）
        if (KEYWORDS.has(lw) && !(lw === 'foreach' && toks[k + 1]?.v !== '(')) {
          if (KEYWORD_THEN_CMD.has(lw)) atCmd = true
          if (lw === 'function' || lw === 'filter') k++
          continue
        }
        // 表达式：变量、类型、数字、运算符、成员访问 .Name（.\x.ps1、..\x、.dsh-master\x.ps1 是命令）
        if (lw.startsWith('$') || lw.startsWith('[') || /^\.[a-z_]\w*$/.test(lw) || (lw.startsWith('-') && lw !== '-') || /^\d/.test(lw)) continue
        const cn = commandName(tk.v)
        cur = { name: cn.name, raw: tk.v, args: [], dynamic: false, pathLike: cn.pathLike }; out.push(cur); continue
      }
      continue // 字符串 / 重定向开头：表达式
    }
    if (!cur && tk.t === 'word' && tk.v.toLowerCase() === 'in') { atCmd = true; continue } // foreach ($x in <管道>)：in 前面是表达式
    if (cur) cur.args.push(tk)
  }
  return out
}

function isReadCmd(c: Cmd): boolean {
  if (c.dynamic) return false
  if (c.pathLike) return READ_NATIVE.has(c.name) || (c.name === 'git' && gitReadOnly(c)) // 带路径 / 扩展名的是程序或脚本，不按 cmdlet 名判
  const n = READ_ALIASES[c.name] ?? c.name
  if (READ_CMDLETS.has(n) || READ_VERBS.some(v => n.startsWith(v))) {
    if (n === 'foreach-object') return foreachMemberOk(c)
    return true
  }
  if (READ_NATIVE.has(n)) return true
  if (n === 'git') return gitReadOnly(c)
  return false
}

function gitReadOnly(c: Cmd): boolean {
  const sub = gitSub(c)
  if (!sub || !GIT_READ.has(sub)) return false
  return !c.args.some(t => t.v === '-c' || GIT_UNSAFE_ARG.test(t.v))
}

/** `% Delete` / `ForEach-Object -MemberName Delete`：调的成员必须只读；`% $变量`（成员名放在变量里）不算只读；带 { } 的脚本块里的命令另算。 */
function foreachMemberOk(c: Cmd): boolean {
  const memberParam = /^-m(?:e(?:m(?:b(?:e(?:r(?:n(?:a(?:m(?:e)?)?)?)?)?)?)?)?)?(?::(.*))?$/i
  for (let k = 0; k < c.args.length; k++) {
    const t = c.args[k]!
    if (t.t === 'op') return true
    if (t.t === 'word' && memberParam.test(t.v)) {
      const v = memberParam.exec(t.v)![1] ?? c.args[k + 1]?.v
      return !!v && !v.startsWith('$') && READ_MEMBERS.has(v.toLowerCase())
    }
    if (t.t === 'word' && t.v.startsWith('$')) return false
    if (t.t === 'word' && t.v.startsWith('-')) continue
    return READ_MEMBERS.has(t.v.toLowerCase())
  }
  return true
}

function gitSub(c: Cmd): string | undefined {
  const a = c.args.filter(t => t.t === 'word' || t.t === 'str').map(t => t.v)
  for (let k = 0; k < a.length; k++) {
    const w = a[k]!
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree') { k++; continue }
    if (w.startsWith('-')) continue
    return w.toLowerCase()
  }
  return undefined
}

/** 成员 noGit：会改暂存区 / 提交 / 分支的 git 子命令（`checkout -- 文件`、restore 放行，和 bash 一样）。 */
export function pwshGitMutates(toks: Tok[]): boolean {
  return commands(toks).some(c => {
    if (c.name !== 'git') return false
    const sub = gitSub(c)
    if (!sub) return false
    if (GIT_MUTATE.has(sub)) return true
    const rest = c.args.map(t => t.v)
    if (sub === 'branch') return rest.some(w => /^-[dDmM]$/.test(w))
    if (sub === 'checkout') { const i = rest.findIndex(w => w.toLowerCase() === 'checkout'); return rest[i + 1] !== '--' }
    return false
  })
}

const HEAVY_NAMES = new Set(['ffmpeg', 'mlx_whisper', 'whisper', 'demucs'])
/** 成员直接跑重活（要走 heavy_run）：程序名不分大小写、可带路径和 .exe。 */
export function pwshHeavy(toks: Tok[]): boolean {
  return commands(toks).some(c => {
    if (HEAVY_NAMES.has(c.name)) return true
    const a = c.args.map(t => t.v.toLowerCase())
    if (c.name === 'hyperframes' && a[0] === 'render') return true
    if (c.name === 'blender' && a.some(w => w === '-b' || w === '--background')) return true
    return a.includes('mlx_audio.tts')
  })
}

/** 总管等待：Start-Sleep / sleep（不分大小写）、cmd 的 timeout。 */
export function pwshSleeps(toks: Tok[]): boolean {
  return commands(toks).some(c => (!c.pathLike && (READ_ALIASES[c.name] ?? c.name) === 'start-sleep') || c.name === 'timeout')
}

/** 不是只读的地方（拿来说明拦的原因）；全是只读返回 undefined。 */
export function notReadOnly(toks: Tok[]): string | undefined {
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k]!
    const next = toks[k + 1]
    if (tk.t === 'redir') {
      if (/&\d$/.test(tk.v)) continue // 2>&1：合并输出流
      if (next && /^(\$null|nul:?)$/i.test(next.v)) { k++; continue }
      return `重定向 ${tk.v}`
    }
    // 成员名写成字符串：$f.'Delete'()、[IO.File]::'WriteAllText'(…)、$f.'IsReadOnly'=…
    const prev = toks[k - 1]
    if (tk.t === 'str' && tk.adj && prev?.t === 'word' && /(\.|::)$/.test(prev.v)) return `用字符串写的成员 ${prev.v}'${tk.v}'`
    if (tk.t !== 'word') continue
    if (next?.t === 'op' && next.v === '=' && /^(?:\$[\w:]+(?:\.[\w]+)*|)\.[A-Za-z_]\w*$/.test(tk.v)) return `给属性赋值 ${tk.v}`
    if (next?.t === 'op' && next.adj && (next.v === '(' || next.v === '{')) {
      const st = /^\[([^\]]+)\]::([A-Za-z_]\w*)$/.exec(tk.v)
      if (st) {
        const type = st[1]!.toLowerCase().replace(/^system\./, '')
        const ok = READ_STATIC[type]
        if (ok === '*' || ok?.has(st[2]!.toLowerCase())) continue
        return `静态调用 ${tk.v}`
      }
      if (/^\$[\w:]+::/.test(tk.v)) return `静态调用 ${tk.v}（类型放在变量里）`
      const m = /\.([A-Za-z_]\w*|\$\w*)?$/.exec(tk.v)
      if (m && !/^\d/.test(tk.v)) {
        const name = m[1] ?? ''
        if (!name || name.startsWith('$')) return `动态方法调用 ${tk.v}`
        const ln = name.toLowerCase()
        if (!READ_MEMBERS.has(ln)) return `方法调用 ${tk.v}`
        if ((ln === 'foreach' || ln === 'where') && next.v !== '{' && toks[k + 2]?.v !== '{') return `方法调用 ${tk.v}（按名字调成员）`
      }
    }
  }
  for (const c of commands(toks)) if (!isReadCmd(c)) return `命令 ${c.raw}`
  return undefined
}

// ---------------- 变量和路径 ----------------

function envGet(env: Record<string, string | undefined>, name: string): string | undefined {
  const hit = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase())
  return hit ? env[hit] : undefined
}

/** 展开 $env:X / ${env:X}、$HOME、$PWD、(Get-Location)、~、cmd 的 %X%。展不开的原样留着。 */
export function expandPwsh(command: string, env: Record<string, string | undefined>, cwd: string | undefined): string {
  const home = envGet(env, 'HOME') ?? envGet(env, 'USERPROFILE')
  let s = command.replace(/\$\{env:([^}]+)\}|\$env:([A-Za-z_][\w]*)/gi, (m, a, b) => envGet(env, a ?? b) ?? m)
  s = s.replace(/%([A-Za-z_][\w]*)%/g, (m, a) => envGet(env, a) ?? m)
  if (home) s = s.replace(/\$\{?home\}?(?![\w:])/gi, home).replace(/(^|[\s=:'"(,;|&])~(?=[\\/]|$|[\s'",;|)])/g, (_m, pre) => pre + home)
  if (cwd) s = s.replace(/\$\{?pwd\}?(?![\w:])/gi, cwd).replace(/\(\s*(?:get-location|pwd|gl)\s*\)/gi, cwd)
  return s
}

/** 路径词规范化：去 provider 前缀、\\?\、本机管理共享、数据流后缀、段末尾的点和空格；`-参数:值`、`--x=值` 取值。 */
export function normPathToken(tok: string, P: PathImpl): string | undefined {
  let t = tok.trim()
  const pm = /^-[A-Za-z][\w]*:(.+)$/.exec(t)
  const eq = /^--?[\w-]+=(.+)$/.exec(t)
  if (pm) t = pm[1]!
  else if (eq) t = eq[1]!
  else if (t.startsWith('-')) return undefined
  t = t.replace(/::\$data$/i, '')
  t = t.replace(/^['"]+|['"]+$/g, '')
  if (!t || /^\d+$/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return undefined
  if (P.sep === '\\') {
    t = t.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, '')
    t = t.replace(/^[\\/]{2}[?.][\\/]/, '')
    t = t.replace(/^[\\/]{2}(?:localhost|127\.0\.0\.1)[\\/]([a-z])\$(?=[\\/]|$)/i, '$1:')
    const drive = /^[a-z]:/i.test(t) ? t.slice(0, 2) : ''
    const ci = t.slice(drive.length).indexOf(':')
    if (ci >= 0) t = drive + t.slice(drive.length, drive.length + ci) // 数据流后缀 a.md:流名
    t = t.split(/([\\/])/).map(seg => seg === '\\' || seg === '/' ? seg : seg.replace(/[. ]+$/, '') || seg).join('')
  }
  if (t.includes('$')) return undefined // 没展开的变量：另由「路径段名」那条兜
  return t
}

function hasGlob(p: string): boolean { return /[*?[]/.test(p) }
function globRe(seg: string): RegExp {
  return new RegExp('^' + seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
}
/** 通配符路径可能落进受保护目录（逐段比，受保护目录那几段都要匹配得上）。 */
function globHits(resolved: string, dir: string, P: PathImpl): boolean {
  const a = resolved.split(/[\\/]+/).filter(Boolean)
  const b = P.resolve(dir).split(/[\\/]+/).filter(Boolean)
  if (a.length < b.length) return false
  return b.every((seg, i) => globRe(a[i]!).test(seg))
}

export function underP(file: string, dir: string, P: PathImpl): boolean {
  const rel = P.relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel))
}

const lowerSlash = (s: string) => s.toLowerCase().replace(/\//g, '\\')
const BOUNDARY = /^($|[\\\s'";|&)},])/

export interface TouchOpts {
  P: PathImpl; cwd: string | undefined; allow: string[]
  /** 「路径段名」宽规则（守状态目录时开；查实例日志目录时关：logs 太常见）。默认开。 */
  nameRules?: boolean
}

/**
 * 命令有没有碰到这些目录。按顺序：
 * ① 原文包含（不分大小写、斜杠统一，产物目录先拿掉，要有边界）；② 工作目录在目录里；
 * ③ 路径词解析后在目录里：按工作目录，也按命令里 cd / Set-Location / Push-Location 去过的目录；通配符只看写文件命令 / 程序的参数和重定向目标；
 * ④ 路径段名：任何词里有一段等于受保护目录的名字（.dsh-master；状态目录的 dsh-master 要命令里同时出现它的上级目录或没展开的变量）——Join-Path、字符串拼接、"$p\.dsh-master"。返回命中的说明。
 */
export function pwshTouches(expanded: string, toks: Tok[], dirs: string[], o: TouchOpts): string | undefined {
  const { P, cwd, allow } = o
  const allowed = (p: string) => allow.some(a => underP(p, a, P))
  let probe = lowerSlash(expanded)
  for (const a of allow) {
    const na = lowerSlash(a.replace(/[\\/]+$/, ''))
    for (let at = probe.indexOf(na); at >= 0; at = probe.indexOf(na, at + 1)) {
      if (BOUNDARY.test(probe.slice(at + na.length))) probe = probe.slice(0, at) + ' __allowed__' + probe.slice(at + na.length)
    }
  }
  for (const d of dirs) {
    const nd = lowerSlash(d.replace(/[\\/]+$/, ''))
    for (let at = probe.indexOf(nd); at >= 0; at = probe.indexOf(nd, at + 1)) if (BOUNDARY.test(probe.slice(at + nd.length))) return d
  }
  if (cwd && !allowed(cwd)) { const d = dirs.find(x => underP(cwd, x, P)); if (d) return `${cwd}（工作目录就在状态目录里）` }
  const fallback = cwd ?? (P.sep === '\\' ? 'C:\\' : '/')
  const cmds = commands(toks)
  // cd 去过的目录（保守：后面的相对路径按原工作目录和这些目录都算一遍）
  const bases = [fallback]
  for (const c of cmds) if (!c.pathLike && LOCATION_CMDS.has(READ_ALIASES[c.name] ?? c.name)) {
    const a = c.args.find(t => (t.t === 'word' || t.t === 'str') && !(t.t === 'word' && /^-(?!(?:path|literalpath):)/i.test(t.v)))
    const n = a ? normPathToken(a.v, P) : undefined
    if (n) { const b = P.resolve(fallback, n); bases.push(b); if (!allowed(b)) { const d = dirs.find(x => underP(b, x, P)); if (d) return `${b}（cd 到了状态目录里）` } }
  }
  const globOk = new Set<Tok>()
  for (const c of cmds) if (WRITERS[c.name] || c.pathLike || c.dynamic) c.args.forEach(t => globOk.add(t))
  toks.forEach((t, k) => { if (t.t === 'redir') { const n = toks[k + 1]; if (n) globOk.add(n) } })
  for (const tk of toks) {
    if (tk.t !== 'word' && tk.t !== 'str') continue
    for (const part of tk.t === 'word' ? tk.v.split(',') : [tk.v]) {
      const t = normPathToken(part, P)
      if (!t) continue
      for (const base of bases) {
        const r = P.resolve(base, t)
        if (allowed(r)) continue
        if (hasGlob(t)) {
          if (!globOk.has(tk) && !/[\\/]/.test(t) && !t.startsWith('.')) continue // 2 * 3、Select-Object *、-like '*s*' 不是路径
          const d = dirs.find(x => globHits(r, x, P)); if (d) return r
          continue
        }
        if (dirs.some(x => underP(r, x, P))) return r
      }
    }
  }
  if (o.nameRules !== false) {
    const segsOf = (v: string) => v.split(/[\\/]+/).map(s => s.toLowerCase().replace(/[. ]+$/, ''))
    for (const d of dirs) {
      const base = P.basename(d.replace(/[\\/]+$/, '')).toLowerCase()
      const parent = lowerSlash(P.dirname(d.replace(/[\\/]+$/, '')))
      // .dsh-master 这种带点的名字够特别，出现就算；dsh-master 太常见：要命令里同时出现上级目录或没展开的变量
      if (!base.startsWith('.') && !probe.includes(parent) && !expanded.includes('$')) continue
      for (const tk of toks) {
        if (tk.t !== 'word' && tk.t !== 'str') continue
        if (!segsOf(tk.v).includes(base)) continue
        const t = normPathToken(tk.v, P)
        if (t && bases.some(b => allowed(P.resolve(b, t)))) continue
        return `${d}（拼出来的路径里有 ${base}）`
      }
    }
  }
  return undefined
}

/** 写目标（认领检查 / 前情推送用，宁缺勿滥）：重定向、写文件 cmdlet 的路径 / 目标参数或位置参数。复制、移动只算目标。 */
export function pwshWriteTargets(command: string, cwd: string | undefined, env: Record<string, string | undefined>, P: PathImpl): string[] {
  const expanded = expandPwsh(normalizePwsh(command), env, cwd)
  const toks = lexPwsh(expanded)
  const base = cwd ?? (P.sep === '\\' ? 'C:\\' : '/')
  const out = new Set<string>()
  const add = (v: string | undefined) => { const t = v ? normPathToken(v, P) : undefined; if (t && !hasGlob(t) && !/^(\$null|nul:?)$/i.test(t)) out.add(P.resolve(base, t)) }
  toks.forEach((tk, k) => { if (tk.t === 'redir' && !/&\d$/.test(tk.v)) { const n = toks[k + 1]; if (n && (n.t === 'word' || n.t === 'str')) add(n.v) } })
  for (const c of commands(toks)) {
    const kind = WRITERS[c.name]
    if (!kind || c.pathLike) continue
    const paths: string[] = []; const dests: string[] = []; const pos: string[] = []
    let newName: string | undefined; let itemName: string | undefined
    for (let k = 0; k < c.args.length; k++) {
      const a = c.args[k]!
      if (a.t === 'redir' || a.t === 'op') break
      const m = a.t === 'word' ? /^-([A-Za-z]+)(?::(.+))?$/.exec(a.v) : null
      if (!m) { pos.push(a.v); continue }
      const pname = m[1]!.toLowerCase()
      const nextVal = () => { const n = c.args[k + 1]; if (n && (n.t === 'word' || n.t === 'str') && !(n.t === 'word' && n.v.startsWith('-'))) { k++; return n.v } return undefined }
      const isP = (list: string[]) => pname.length >= 2 && list.some(p => p.startsWith(pname))
      if (pname.length >= 3 && 'newname'.startsWith(pname)) { newName = m[2] ?? nextVal(); continue }
      if (kind === 'new-item' && pname.length >= 2 && 'name'.startsWith(pname)) { itemName = m[2] ?? nextVal(); continue }
      if (isP(DEST_PARAMS)) { const v = m[2] ?? nextVal(); if (v) dests.push(v); continue }
      if (isP(PATH_PARAMS)) { const v = m[2] ?? nextVal(); if (v) paths.push(v); continue }
      if (m[2] === undefined && VALUE_PARAMS.some(p => pname.length >= 2 && p.startsWith(pname))) nextVal() // 带值的其他参数：跳过值
    }
    if (kind === 'copy-item' || kind === 'move-item') { if (dests.length) dests.forEach(add); else if (pos.length >= 2 || (paths.length && pos.length)) add(pos[pos.length - 1]); continue }
    if (kind === 'rename-item') { const src = paths[0] ?? pos[0]; add(src); const nn = newName ?? pos[1]; if (src && nn) add(P.join(P.dirname(normPathToken(src, P) ?? src), nn)); continue }
    if (kind === 'tee-object') { add(paths[0] ?? pos[0]); continue }
    const targets = paths.length ? paths : pos.slice(0, 1)
    for (const t of targets) add(itemName ? P.join(normPathToken(t, P) ?? t, itemName) : t)
    if (!targets.length && itemName) add(itemName)
  }
  return [...out]
}
