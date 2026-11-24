/**
 * G16-2：Windows 兼容（W8 重活排队、W9 PowerShell 守卫、W10 总管等待）+ 三处跨平台修补（Q5）。
 * 守卫的用例用 path.win32 跑，所以在 Mac / Linux 上也按 Windows 路径的规则测；真起 PowerShell 的只在 Windows 上跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { guardDecision, bashWriteTargets, effectiveCwd, NO_WAIT, NO_GIT, NO_SECRET, USE_HEAVY_RUN, type GuardConfig } from '../src/guard.ts'
import { lexPwsh, commands, notReadOnly, normalizePwsh, expandPwsh, normPathToken, pwshWriteTargets } from '../src/guard-pwsh.ts'
import { HeavyQueue, resolvePwsh, pwshArgv, freeHow, PWSH_EPILOGUE } from '../src/heavy.ts'
import { Store } from '../src/store.ts'
import { MemoryLayer } from 'dsh-master-devlog'

const W = path.win32
const STATE = 'E:\\dsh-home\\dsh-master'
const DOT = 'E:\\w\\.dsh-master'
const OUT = 'E:\\w\\.dsh-master\\out'
const LOGS = 'E:\\dsh-home\\logs'
const env = { HOME: 'C:\\Users\\u', USERPROFILE: 'C:\\Users\\u', DSH_HOME: 'E:\\dsh-home' }
const cfg: GuardConfig = { protectedPaths: [STATE, DOT], allowPaths: [OUT], secretPaths: [LOGS], env, noGit: true, pathImpl: W }
type Role = 'master' | 'exec' | undefined
const pw = (command: string, role: Role = 'exec', extra: Record<string, unknown> = {}, c: GuardConfig = cfg) =>
  guardDecision({ name: 'pwsh', args: { command, ...extra }, role, cwd: 'E:\\w' }, c)
/** 改前的行为：pwsh 以前和 bash 走同一支（guard.ts 的 bash 分支逻辑没变，路径实现换成 win32 就是 Windows 上的旧行为）。
 *  例外：bash 分支现在也认 workdir（Q5），所以带 workdir 的那几行「现在」一列不是真正的旧代码——那几行旧代码按会话工作目录算，结果都是放行。 */
const old = (command: string, role: Role = 'exec', extra: Record<string, unknown> = {}, c: GuardConfig = cfg) =>
  guardDecision({ name: 'bash', args: { command, ...extra }, role, cwd: 'E:\\w' }, c)
const PROTECT = /总管状态目录只能通过 dsh-master 工具改/

// ---------------- §2.3 对照表 ----------------
type Row = [command: string, role: Role, now: 'deny' | 'allow', after: 'deny' | 'allow' | string, extra?: Record<string, unknown>]
const TABLE: Row[] = [
  // 新拦下的
  ['Set-Content .dsh-master\\docs\\board.md x', 'exec', 'allow', 'deny'],
  ['SET-CONTENT .dsh-master\\docs\\board.md x', 'exec', 'allow', 'deny'],
  ['sc .dsh-master\\docs\\board.md x', 'exec', 'allow', 'deny'],
  ['Add-Content .dsh-master\\docs\\board.md x', 'exec', 'allow', 'deny'],
  ['RM .dsh-master\\master.db', 'exec', 'allow', 'deny'],
  ['Remove-Item -Recurse -Force .dsh-master', 'exec', 'allow', 'deny'],
  ['"x" | Out-File -FilePath:E:\\w\\.dsh-master\\a.md', 'exec', 'allow', 'deny'],
  ['"x" | Out-File -Fi:.dsh-master\\a.md', 'exec', 'allow', 'deny'],
  ['Add-Content $env:DSH_HOME\\dsh-master\\memory.db x', 'exec', 'allow', 'deny'],
  ["[IO.File]::WriteAllText('E:/W/.DSH-MASTER/a.md','x')", 'exec', 'allow', 'deny'],
  ['Copy-Item src\\a.md -Destination .dsh-master\\docs\\', 'exec', 'allow', 'deny'],
  ['Set-Content board.md x', 'exec', 'allow', 'deny', { workdir: 'E:\\w\\.dsh-master\\docs' }],
  ['& $c', 'exec', 'allow', 'deny', { workdir: 'E:\\w\\.dsh-master\\docs' }], // 没有路径词，只有工作目录碰到
  ['Set-Content "$PWD\\.dsh-master\\a" x', 'exec', 'allow', 'deny'],
  ['Remove-Item .dsh-m* -Recurse', 'exec', 'allow', 'deny'],
  ['Remove-Item * -Recurse -Force', 'exec', 'allow', 'deny', { workdir: 'E:\\w' }],
  ["& ('Set-'+'Content') .dsh-master\\a x", 'exec', 'allow', 'deny'],
  ['iex "sc .dsh-master\\a x"', 'exec', 'allow', 'deny'],
  ['S`et-Content .dsh-master\\a x', 'exec', 'allow', 'deny'],
  ['Set\u2013Content .dsh-master\\a x', 'exec', 'allow', 'deny'],
  ['gi .dsh-master\\a | % Delete', 'exec', 'allow', 'deny'],
  ['gi .dsh-master\\a | ForEach-Object -MemberName Delete', 'exec', 'allow', 'deny'],
  ['(gi .dsh-master\\a).Delete()', 'exec', 'allow', 'deny'],
  ['(gi .dsh-master\\a).OpenWrite()', 'exec', 'allow', 'deny'],
  ["(gi .dsh-master\\a).ForEach('Delete')", 'exec', 'allow', 'deny'],
  ['(gi .dsh-master\\a).IsReadOnly=$true', 'exec', 'allow', 'deny'],
  ['$f = gi .dsh-master\\a; $f.LastWriteTime = Get-Date', 'exec', 'allow', 'deny'],
  ["Set-Content '.dsh-master\\docs\\board.md::$DATA' x", 'exec', 'allow', 'deny'],
  ['Set-Content .dsh-master.\\docs\\board.md x', 'exec', 'allow', 'deny'],
  ['Set-Content \\\\?\\E:\\w\\.dsh-master\\a x', 'exec', 'allow', 'deny'],
  ['Set-Content \\\\localhost\\E$\\w\\.dsh-master\\a x', 'exec', 'allow', 'deny'],
  ['Set-Content FileSystem::E:\\w\\.dsh-master\\a x', 'exec', 'allow', 'deny'],
  ['Set-Content \u2018.dsh-master\\a\u2019 x', 'exec', 'allow', 'deny'],
  ['$p = $x; Set-Content "$p\\.dsh-master\\a" y', 'exec', 'allow', 'deny'],
  ['cmd /c del %DSH_HOME%\\dsh-master\\master.db', 'exec', 'allow', 'deny'],
  ['Get-Content $env:DSH_HOME\\logs\\dsh.log', 'exec', 'allow', NO_SECRET],
  ['GIT commit -m x', 'exec', 'allow', NO_GIT],
  ['git.exe add .', 'exec', 'allow', NO_GIT],
  ["& 'C:\\Program Files\\Git\\cmd\\git.exe' commit -m x", 'exec', 'allow', NO_GIT],
  ['FFMPEG.exe -i a.mp4 b.mp4', 'exec', 'allow', USE_HEAVY_RUN],
  ["& 'C:\\tools\\ffmpeg.exe' -i a.mp4 b.mp4", 'exec', 'allow', USE_HEAVY_RUN],
  ['Start-Sleep 20', 'master', 'allow', NO_WAIT],
  ['Sleep 20', 'master', 'allow', NO_WAIT],
  // 独立审稿（G16-2）找出的绕过：拆词吞掉后面的命令、拼路径、foreach in、字符串成员名、git 只读子命令写文件、带路径的脚本、cd 之后的相对路径
  ['Get-Content .dsh-master\\a[0; Remove-Item .dsh-master\\b -Force; echo ]', 'exec', 'allow', 'deny'],
  ['Get-Content [0; Remove-Item .dsh-master\\b; echo ]', 'exec', 'allow', 'deny'], // [ 在词首
  ["& ('Remove-Item') -Path .dsh-master\\a", 'exec', 'allow', 'deny'], // 只有动态调用拦得住
  ['Write-Output "a`""; Remove-Item .dsh-master\\b', 'exec', 'allow', 'deny'],
  ["Write-Output \"$( ')' ; Remove-Item .dsh-master\\a )\"", 'exec', 'allow', 'deny'],
  ["Set-Content (Join-Path $env:DSH_HOME 'dsh-master\\a') x", 'exec', 'allow', 'deny'],
  ["Set-Content ([IO.Path]::Combine($env:DSH_HOME,'dsh-master','a')) x", 'exec', 'allow', 'deny'],
  ["Set-Content ($PWD.Path + '\\.dsh-master\\a') x", 'exec', 'allow', 'deny'],
  ["Set-Content ((Get-Location).Path + '\\.dsh-master\\a') x", 'exec', 'allow', 'deny'],
  ['foreach ($f in Remove-Item .dsh-master\\a) {}', 'exec', 'allow', 'deny'],
  ["$f = gi .dsh-master\\a; $f.'Delete'()", 'exec', 'allow', 'deny'],
  ["[IO.File]::'WriteAllText'('E:\\w\\.dsh-master\\a','x')", 'exec', 'allow', 'deny'],
  ["$t=[IO.File]; $t::WriteAllText('E:\\w\\.dsh-master\\a','x')", 'exec', 'allow', 'deny'],
  ["$f = gi .dsh-master\\a; $f.'IsReadOnly'=$true", 'exec', 'allow', 'deny'],
  ["$f = gi .dsh-master\\a; $f.Attributes+='ReadOnly'", 'exec', 'allow', 'deny'],
  ['gi .dsh-master\\a | % -MemberName:Delete', 'exec', 'allow', 'deny'],
  ["$m='Delete'; gi .dsh-master\\a | % $m", 'exec', 'allow', 'deny'],
  ["(gi .dsh-master\\a).Replace('E:\\w\\.dsh-master\\b',$null)", 'exec', 'allow', 'deny'],
  ['git diff --output=.dsh-master\\x', 'exec', 'allow', 'deny'],
  ['git -c diff.external=evil.exe diff .dsh-master', 'exec', 'allow', 'deny'],
  ['.\\Get-Fix.ps1 .dsh-master\\a', 'exec', 'allow', 'deny'],
  ['.dsh-master\\x.ps1', 'exec', 'allow', 'deny'],
  ['cd E:\\dsh-home; Remove-Item dsh-master -Recurse', 'exec', 'allow', 'deny'],
  ['cd E:\\dsh-home; Get-Content logs\\dsh.log', 'exec', 'allow', NO_SECRET], // 查实例日志时没有路径段名规则，只靠跟踪 cd
  // 审稿找出的误拦（改后要放行）
  ['$n = 2 * 3; Set-Content a.txt $n', 'exec', 'allow', 'allow'],
  ['Get-Process | Select-Object * | Export-Csv p.csv', 'exec', 'allow', 'allow'],
  ["gci src | Where-Object Name -like '*s*' | Remove-Item", 'exec', 'allow', 'allow'],
  ["Get-ChildItem .dsh-master | Select-Object Name, @{n='KB';e={$_.Length/1KB}}", 'exec', 'allow', 'allow'],
  ['Get-ChildItem .dsh-master | Where-Object LastWriteTime -gt (Get-Date).AddHours(-1)', 'exec', 'allow', 'allow'],
  ['Get-Content .dsh-master\\a | find "x"', 'exec', 'allow', 'allow'],
  ['Get-Content $root\\logs\\app.log', 'exec', 'allow', 'allow'],
  ['npm i dsh-master', 'exec', 'allow', 'allow'],
  ['Set-Content E:\\code\\dsh-master\\a.txt x', 'exec', 'allow', 'allow'],
  // 现在拦、改后照拦（底线）
  ['rm .dsh-master\\x', 'exec', 'deny', 'deny'],
  ['echo x > .dsh-master\\a', 'exec', 'deny', 'deny'],
  ['cmd /c "echo x > .dsh-master\\a.md"', 'exec', 'deny', 'deny'],
  ['git commit -m x', 'exec', 'deny', NO_GIT],
  ['ffmpeg -i a b', 'exec', 'deny', USE_HEAVY_RUN],
  ['sleep 20', 'master', 'deny', NO_WAIT],
  ['ls', 'master', 'deny', NO_WAIT, { timeoutMs: 60_000 }],
  ['Get-Content E:\\dsh-home\\logs\\dsh.log', 'exec', 'deny', NO_SECRET],
  // 放行的（防误拦）
  ['Get-Content .dsh-master\\docs\\board.md', 'exec', 'allow', 'allow'],
  ['gc .dsh-master\\docs\\board.md', 'exec', 'allow', 'allow'],
  ['cat .dsh-master\\docs\\board.md', 'exec', 'allow', 'allow'],
  ['type .dsh-master\\docs\\board.md', 'exec', 'allow', 'allow'],
  ['ls .dsh-master', 'exec', 'allow', 'allow'],
  ['dir .dsh-master', 'exec', 'allow', 'allow'],
  ['gci .dsh-master -Recurse | Select-Object FullName', 'exec', 'allow', 'allow'],
  ["Select-String -Path .dsh-master\\docs\\* -Pattern '->'", 'exec', 'deny', 'allow'], // 改前误拦：引号里的 > 被当成重定向
  ['Test-Path .dsh-master', 'exec', 'allow', 'allow'],
  ['Get-FileHash .dsh-master\\master.db', 'exec', 'allow', 'allow'],
  ["[IO.File]::ReadAllText('.dsh-master\\a.md')", 'exec', 'allow', 'allow'],
  ['(gi .dsh-master\\a).Length', 'exec', 'allow', 'allow'],
  ['gi .dsh-master\\a | % FullName', 'exec', 'allow', 'allow'],
  ['Get-Content .dsh-master\\a.md | Out-Null', 'exec', 'allow', 'allow'],
  ['Get-Content .dsh-master\\docs\\board.md', 'exec', 'allow', 'allow', { workdir: 'E:\\w' }],
  ['Get-Content board.md', 'exec', 'allow', 'allow', { workdir: 'E:\\w\\.dsh-master\\docs' }],
  ['cd .dsh-master; ls', 'exec', 'allow', 'allow'],
  ['if (Test-Path .dsh-master\\a) { Get-Content .dsh-master\\a }', 'exec', 'allow', 'allow'],
  ['foreach ($f in gci .dsh-master) { $f.Name }', 'exec', 'allow', 'allow'],
  ['git status', 'exec', 'allow', 'allow'],
  ['git diff -- .dsh-master', 'exec', 'allow', 'allow'],
  ['git log -3 --format=%H -- .dsh-master', 'exec', 'allow', 'allow'],
  ['Set-Content E:\\w\\src\\a.txt x', 'exec', 'allow', 'allow'],
  ['md src\\new', 'exec', 'allow', 'allow'],
  ['Remove-Item *.txt', 'exec', 'allow', 'allow'],
  ['Out-File .dsh-master\\out\\r.md', 'exec', 'allow', 'allow'],
  ['Get-Content $env:USERPROFILE\\notes.txt', 'exec', 'allow', 'allow'],
  ['Get-Content E:\\dsh-home\\logs\\dsh.log', 'master', 'allow', 'allow'],
  ['ffmpeg -i a b', 'master', 'allow', 'allow'],
  ['Start-Sleep 2', 'exec', 'allow', 'allow'],
  // 以前误拦、现在放行（有意的变化，见下面「改前拦、改后放」的清单）
  ['Get-Content .dsh-master\\a.md 2>$null', 'exec', 'deny', 'allow'],
  ['Get-Content .dsh-master\\a.md > NUL', 'exec', 'deny', 'allow'],
  ['echo x > E:\\w\\.dsh-master\\out\\r.md', 'exec', 'deny', 'allow'],
  ['echo x > E:\\w\\.DSH-MASTER\\OUT\\r.md', 'exec', 'allow', 'allow'], // 改前就放行（win32 比路径不分大小写）
  ['Get-Content .dsh-master\\install.md', 'exec', 'deny', 'allow'],
  // 有意拦的（取舍）
  ['Copy-Item .dsh-master\\docs\\board.md E:\\tmp\\', 'exec', 'allow', 'deny'],
  ['icacls .dsh-master', 'exec', 'allow', 'deny'],
  ['cmd /c type .dsh-master\\a', 'exec', 'allow', 'deny'],
]

describe('G16 PowerShell 守卫：对照表（path.win32）', () => {
  it.each(TABLE)('%s（%s）', (command, role, now, after, extra) => {
    const o = old(command, role, extra), n = pw(command, role, extra)
    expect(o === undefined ? 'allow' : 'deny', `改前：${o}`).toBe(now)
    if (after === 'allow') expect(n, '改后应放行').toBeUndefined()
    else if (after === 'deny') expect(n, '改后应拦').toMatch(PROTECT)
    else expect(n).toBe(after)
  })
  it('拦的提示里让用 read 工具读', () => {
    expect(pw('Set-Content .dsh-master\\a x')).toMatch(/读取可以用 read 工具/)
  })
})

// ---------------- 超集：改前拦的，改后照拦（只有列出来的那几类误拦例外） ----------------
describe('G16 PowerShell 守卫：改前能拦的改后照拦', () => {
  const CMDS = ['cat {P}', 'Get-Content {P}', 'echo x > {P}', 'echo x >> {P}', 'x | tee {P}', 'cp a {P}', 'mv {P} b', 'rm -r {P}', 'sed -i s/a/b/ {P}',
    'touch {P}', 'sqlite3 {P} x', 'python -c x {P}', 'node x.js {P}', 'tar xf a -C {P}', 'Set-Content {P} x', 'Remove-Item {P}', 'ls {P} 2>$null',
    'Get-Content {P} 2>$null', 'Get-Content {P} *>$null', 'Get-Content {P} > NUL', 'cmd /c "echo x > {P}"', 'git add {P}', 'git commit -m x', 'git status',
    'ffmpeg -i {P} b', 'whisper {P}', 'sleep 3', 'Start-Sleep 3', 'npm test > {P}', 'Get-Content {P}\\install.md', 'Get-Content {P}\\node.md']
  const PATHS = [`${STATE}\\master.db`, '$DSH_HOME\\dsh-master\\x', '${DSH_HOME}\\dsh-master\\x', '.dsh-master\\docs\\board.md', '.dsh-master\\out\\r.md',
    `${OUT}\\r.md`, 'E:\\w\\.DSH-MASTER\\OUT\\r.md', 'src\\a.md', `${LOGS}\\dsh.log`, '$DSH_HOME\\logs\\dsh.log', 'E:\\dsh-home\\dsh-master-other\\x']
  /** 改前拦、改后放的：只许是这几类误拦。 */
  const LOOSER = [
    /2>\$null|\*>\$null|> NUL/, // 重定向到 $null / NUL 不写文件
    /\\out\\r\.md|\\OUT\\r\.md/, // 产物目录写成反斜杠 / 大写（以前放行规则只认 /）
    /\\(install|node)\.md$/, // 写操作的词只出现在文件名里（以前全文找 install / node）
    /dsh-master-other/, // 名字开头一样的别的目录（以前不看边界）
  ]
  it('逐条：改前拦 ⇒ 改后拦，例外只在上面几类', () => {
    const looser: string[] = []
    let n = 0
    for (const role of ['master', 'exec', undefined] as Role[]) for (const t of CMDS) for (const p of PATHS) {
      const c = t.replaceAll('{P}', p); n++
      if (old(c, role) !== undefined && pw(c, role) === undefined && !LOOSER.some(r => r.test(c))) looser.push(`${role}｜${c}｜改前：${old(c, role)}`)
    }
    expect(n).toBeGreaterThan(1000)
    expect(looser).toEqual([])
  })
})

// ---------------- 拆词 ----------------
describe('G16 PowerShell 拆词', () => {
  const names = (c: string) => commands(lexPwsh(normalizePwsh(c))).map(x => x.name)
  it('命令位置：行首、管道、分号、括号、调用符、赋值之后；文件名里的 md / del 不是命令', () => {
    expect(names('Get-Content board.md | Select-String x; (Test-Path a.del)')).toEqual(['get-content', 'select-string', 'test-path'])
    expect(names('$x = Get-Item a')).toEqual(['get-item'])
    expect(names("& 'C:\\x\\ffmpeg.exe' -i a")).toEqual(['ffmpeg'])
    expect(names('Microsoft.PowerShell.Management\\Set-Content a b')).toEqual(['set-content'])
    expect(names('.\\run.ps1 a')).toEqual(['run'])
    expect(names('return Remove-Item a')).toEqual(['remove-item'])
    expect(names('"$(Remove-Item a)"')).toEqual(['remove-item'])
    expect(names('S`et-Content a')).toEqual(['set-content'])
    expect(names('Set\u2013Content a')).toEqual(['set-content'])
  })
  it('只读判断：重定向到 $null / NUL、2>&1 不算写', () => {
    expect(notReadOnly(lexPwsh('Get-Content a 2>$null'))).toBeUndefined()
    expect(notReadOnly(lexPwsh('Get-Content a *>&1'))).toBeUndefined()
    expect(notReadOnly(lexPwsh('Get-Content a > NUL'))).toBeUndefined()
    expect(notReadOnly(lexPwsh('Get-Content a > b'))).toMatch(/重定向/)
  })
  it('变量展开：$env: 不分大小写、${env:X}、$HOME、~\\、$PWD、%X%', () => {
    const e = { DSH_HOME: 'E:\\h', HOME: 'C:\\U' }
    expect(expandPwsh('$ENV:dsh_home\\a ${env:DSH_HOME}\\b $home\\c ~\\d $PWD\\e %DSH_HOME%\\f', e, 'E:\\w')).toBe('E:\\h\\a E:\\h\\b C:\\U\\c C:\\U\\d E:\\w\\e E:\\h\\f')
  })
  it('路径词规范化', () => {
    expect(normPathToken('-Path:E:\\x', W)).toBe('E:\\x')
    expect(normPathToken('--output=.dsh-master\\x', W)).toBe('.dsh-master\\x')
    expect(normPathToken('a.md::$DATA', W)).toBe('a.md')
    expect(normPathToken('E:\\a.md:stream', W)).toBe('E:\\a.md')
    expect(normPathToken('E:', W)).toBe('E:')
    expect(normPathToken('.dsh-master.\\docs ', W)).toBe('.dsh-master\\docs')
    expect(normPathToken('-Recurse', W)).toBeUndefined()
    expect(normPathToken('\\\\localhost\\E$\\w\\a', W)).toBe('E:\\w\\a')
    expect(normPathToken('\\\\127.0.0.1\\e$\\w', W)).toBe('e:\\w')
    expect(normPathToken('$x\\a', W)).toBeUndefined()
  })
})

// ---------------- 写目标（认领检查 / 前情推送） ----------------
describe('G16 PowerShell 写目标', () => {
  const t = (c: string) => pwshWriteTargets(c, 'E:\\w', env, W)
  it('认重定向、写文件 cmdlet 的路径参数 / 位置参数 / 别名', () => {
    expect(t('echo x > a.md')).toEqual(['E:\\w\\a.md'])
    expect(t('Set-Content -Path src\\a.ts -Value x')).toEqual(['E:\\w\\src\\a.ts'])
    expect(t('sc src\\a.ts x')).toEqual(['E:\\w\\src\\a.ts'])
    expect(t('"x" | Out-File -FilePath:E:\\w\\b.md')).toEqual(['E:\\w\\b.md'])
    expect(t('Copy-Item a.md b.md')).toEqual(['E:\\w\\b.md'])
    expect(t('Copy-Item a.md -Destination c.md')).toEqual(['E:\\w\\c.md'])
    expect(t('Rename-Item src\\a.ts b.ts')).toEqual(['E:\\w\\src\\a.ts', 'E:\\w\\src\\b.ts'])
    expect(t('New-Item -ItemType File n.md')).toEqual(['E:\\w\\n.md'])
    expect(t('Remove-Item -Recurse -Force old')).toEqual(['E:\\w\\old'])
    expect(t('Copy-Item -Path src\\a.md -Destination b.md')).toEqual(['E:\\w\\b.md']) // 复制的源不算写
    expect(t('npm test | Tee-Object -Variable out')).toEqual([]) // -Variable 的值是变量名
    expect(t('New-Item -Path src -Name n.md -ItemType File')).toEqual(['E:\\w\\src\\n.md'])
  })
  it('读命令、写到 $null 的不算', () => {
    expect(t('Get-Content a.md 2>$null')).toEqual([])
    expect(t('gc a.md | Out-Null')).toEqual([])
    expect(t('Remove-Item *.tmp')).toEqual([]) // 通配符不当成写目标（宁缺勿滥）
  })
  it('workdir：写目标按命令的实际工作目录解析', () => {
    expect(effectiveCwd({ name: 'pwsh', args: { workdir: 'src' }, cwd: 'E:\\w' }, env, W)).toBe('E:\\w\\src')
    expect(effectiveCwd({ name: 'bash', args: { workdir: 'src' }, cwd: '/w' }, env, path.posix)).toBe('/w/src')
    expect(effectiveCwd({ name: 'bash', args: {}, cwd: '/w' }, env, path.posix)).toBe('/w')
  })
})

// ---------------- Q5：bash 也认 workdir（Mac / Linux 的预期变化） ----------------
describe('G16 Q5：bash 的 workdir 不再能绕过守卫', () => {
  const bcfg: GuardConfig = { protectedPaths: ['/home/u/.dsh/dsh-master'], env: { HOME: '/home/u' }, pathImpl: path.posix }
  it('workdir 指进状态目录 ⇒ 相对路径的写被拦；没 workdir 时和以前一样', () => {
    expect(guardDecision({ name: 'bash', args: { command: 'echo x > board.md', workdir: '/home/u/.dsh/dsh-master/docs' }, role: 'exec', cwd: '/w' }, bcfg)).toMatch(PROTECT)
    expect(guardDecision({ name: 'bash', args: { command: 'echo x > board.md' }, role: 'exec', cwd: '/w' }, bcfg)).toBeUndefined()
    expect(guardDecision({ name: 'bash', args: { command: 'cat board.md', workdir: '/home/u/.dsh/dsh-master/docs' }, role: 'exec', cwd: '/w' }, bcfg)).toBeUndefined()
  })
  it('workdir 指进实例日志目录 ⇒ 成员读也拦', () => {
    expect(guardDecision({ name: 'bash', args: { command: 'cat dsh.log', workdir: '/home/u/.dsh/logs' }, role: 'exec', cwd: '/w' }, { ...bcfg, secretPaths: ['/home/u/.dsh/logs'] })).toBe(NO_SECRET)
  })
  it('bashWriteTargets 按传进来的工作目录解析（index.ts 传的是 workdir 之后的）', () => {
    expect(bashWriteTargets('echo x > a.md', '/w/src', {}, path.posix)).toEqual(['/w/src/a.md'])
  })
})

// ---------------- Q5：heavy_run 提交前的检查带角色 ----------------
describe('G16 Q5：heavy_run 的守卫（context=heavy）', () => {
  const posix: GuardConfig = { protectedPaths: ['/home/u/.dsh/dsh-master', '/w/.dsh-master'], allowPaths: ['/w/.dsh-master/out'], secretPaths: ['/home/u/.dsh/logs'], env: { HOME: '/home/u' }, noGit: true, pathImpl: path.posix, context: 'heavy' }
  const hv = (command: string, role: Role, name = 'bash', c: GuardConfig = posix) => guardDecision({ name, args: { command }, role, cwd: '/w' }, c)
  it('成员不能借 heavy_run 动 git、读实例日志；本来就是重活的不拦；总管带 sleep 的重活不拦', () => {
    expect(hv('git commit -m x', 'exec')).toBe(NO_GIT)
    expect(hv('cat /home/u/.dsh/logs/dsh.log', 'exec')).toBe(NO_SECRET)
    expect(hv('ffmpeg -i a.mp4 b.mp4', 'exec')).toBeUndefined()
    expect(hv('sleep 5 && ffmpeg -i a b', 'master')).toBeUndefined()
    expect(hv('ffmpeg -i a b > /w/.dsh-master/out/log.txt', 'exec')).toBeUndefined()
    expect(hv('echo x > /w/.dsh-master/board.md', 'exec')).toMatch(PROTECT)
  })
  it('Windows：按 pwsh 的规则判', () => {
    const wc: GuardConfig = { ...cfg, context: 'heavy' }
    expect(guardDecision({ name: 'pwsh', args: { command: 'Set-Content .dsh-master\\a x' }, role: 'exec', cwd: 'E:\\w' }, wc)).toMatch(PROTECT)
    expect(guardDecision({ name: 'pwsh', args: { command: 'FFMPEG.exe -i a b' }, role: 'exec', cwd: 'E:\\w' }, wc)).toBeUndefined()
    expect(guardDecision({ name: 'pwsh', args: { command: 'GIT commit -m x' }, role: 'exec', cwd: 'E:\\w' }, wc)).toBe(NO_GIT)
  })
})

// ---------------- W8 重活：Windows 上用 PowerShell ----------------
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `g16-${n}-`))
const clock = () => Date.parse('2026-11-24T08:00:00+08:00')

function fakeChild() {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {}
  return { on(ev: string, f: (...a: any[]) => void) { (handlers[ev] ??= []).push(f); return this }, emit(ev: string, ...a: any[]) { for (const f of handlers[ev] ?? []) f(...a) } }
}
function queue(platform: NodeJS.Platform, spawnImpl: any, extra: Record<string, unknown> = {}) {
  const store = new Store(path.join(tmp('db'), 'master.db'))
  const done: any[] = []
  const q = new HeavyQueue(store, clock, { logDir: tmp('log'), freeGb: () => 16, totalGb: () => 32, guard: () => undefined, onDone: j => done.push(j), platform, spawn: spawnImpl, ...extra })
  return { store, q, done }
}

describe('G16 W8 重活排队', () => {
  it('Windows：PowerShell（7 → PATH → 5.1）、-Command、windowsHide、NO_COLOR；日志开头 UTF-8 BOM', async () => {
    const calls: any[] = []
    const child = fakeChild()
    const h = queue('win32', (exe: string, argv: string[], opts: any) => { calls.push({ exe, argv, opts }); return child }, { env: { ProgramFiles: 'C:\\Nope', SystemRoot: 'C:\\Windows', PATH: '' } })
    const r = await h.q.submit({ session: 's', label: 'x', command: 'echo 中文', cwd: tmp('cwd'), minFreeGb: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].exe).toMatch(/powershell\.exe$/i)
    expect(calls[0].argv).toHaveLength(5)
    expect(calls[0].argv.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    expect(calls[0].argv[4]).toContain('[Console]::OutputEncoding')
    expect(calls[0].argv[4]).toContain('echo 中文\n$__dshOk = $?')
    expect(calls[0].opts).toMatchObject({ windowsHide: true, env: { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' } })
    child.emit('exit', 0)
    expect(fs.readFileSync(r.log, 'utf8').charCodeAt(0)).toBe(0xfeff)
  })
  it('Mac / Linux：照旧 /bin/bash -lc，选项不变（不带 windowsHide、env），日志没有 BOM', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const calls: any[] = []
      const child = fakeChild()
      const h = queue(platform, (exe: string, argv: string[], opts: any) => { calls.push({ exe, argv, opts }); return child })
      const cwd = tmp('cwd')
      const r = await h.q.submit({ session: 's', label: 'x', command: 'echo hi', cwd, minFreeGb: 1 })
      expect(calls[0].exe).toBe('/bin/bash')
      expect(calls[0].argv).toEqual(['-lc', 'echo hi'])
      expect(Object.keys(calls[0].opts).sort()).toEqual(['cwd', 'stdio'])
      child.emit('exit', 0)
      expect(fs.readFileSync(r.log, 'utf8').startsWith('# heavy_run')).toBe(true)
    }
  })
  it('程序都没起来：原因写进日志和完成通知；exit 和 error 都来时只记一次', async () => {
    const child = fakeChild()
    const h = queue('win32', () => child, { env: { SystemRoot: 'C:\\Nope', PATH: '' } })
    const r = await h.q.submit({ session: 's', label: 'x', command: 'echo hi', cwd: tmp('cwd'), minFreeGb: 1 })
    child.emit('error', new Error('spawn powershell.exe ENOENT'))
    child.emit('exit', -2)
    expect(h.done).toHaveLength(1)
    expect(h.done[0]).toMatchObject({ state: 'failed', exit_code: -1, start_error: 'spawn powershell.exe ENOENT' })
    expect(fs.readFileSync(r.log, 'utf8')).toContain('# 启动失败：spawn powershell.exe ENOENT')
    expect(h.store.heavyJob(r.id)!.state).toBe('failed')
  })
  it('Mac 上真的找不到程序（opts.shell 指向不存在的路径）也写原因', async () => {
    if (process.platform === 'win32') return
    const h = queue(process.platform, undefined, { shell: '/nonexistent/bash-g16' })
    const r = await h.q.submit({ session: 's', label: 'x', command: 'echo hi', cwd: tmp('cwd'), minFreeGb: 1 })
    for (let i = 0; i < 100 && !h.done.length; i++) await new Promise(res => setTimeout(res, 20))
    expect(h.done[0]?.start_error).toMatch(/ENOENT/)
    expect(fs.readFileSync(r.log, 'utf8')).toMatch(/# 启动失败：.*ENOENT/)
  })
  it('resolvePwsh：PowerShell 7 → PATH 上的 pwsh.exe → 5.1；都没有就 powershell.exe', () => {
    const e = { ProgramFiles: 'C:\\PF', SystemRoot: 'C:\\Win', PATH: 'C:\\a;"C:\\b"' }
    const has = (list: string[]) => (p: string) => list.includes(p)
    expect(resolvePwsh(e, has(['C:\\PF\\PowerShell\\7\\pwsh.exe', 'C:\\b\\pwsh.exe']))).toBe('C:\\PF\\PowerShell\\7\\pwsh.exe')
    expect(resolvePwsh(e, has(['C:\\b\\pwsh.exe', 'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']))).toBe('C:\\b\\pwsh.exe')
    expect(resolvePwsh(e, has(['C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']))).toBe('C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(resolvePwsh(e, has([]))).toBe('powershell.exe')
  })
  it('可用内存口径按平台写（macOS 和以前一样）', () => {
    expect(freeHow('darwin')).toBe('插件口径：vm_stat 的 free + inactive + speculative 页（不是只看 free 页），开跑判断用的就是这个数')
    expect(freeHow('win32')).toMatch(/os\.freemem\(\)[\s\S]*Windows/)
    expect(freeHow('linux')).toMatch(/MemAvailable/)
  })
  it('收尾：用户命令后面先换行（以 # 注释结尾也不吞掉收尾）', () => {
    const s = pwshArgv('echo a # 注释')[4]!
    expect(s.endsWith(`echo a # 注释${PWSH_EPILOGUE}`)).toBe(true)
    expect(PWSH_EPILOGUE.startsWith('\n$__dshOk = $?')).toBe(true)
  })
})

// ---------------- 给模型看的文字：Windows 上写 pwsh ----------------
describe('G16 给模型看的文字按平台', () => {
  const real = process.platform
  afterEach(() => { Object.defineProperty(process, 'platform', { value: real }); vi.resetModules() })
  it('win32：守则 / 认领提示 / 重活工具说明写 pwsh，不提 vm_stat', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' }); vi.resetModules()
    const { rolePrompt } = await import('../src/prompts.ts')
    const { CONFLICT_HINT, denyText } = await import('../src/claims.ts')
    for (const role of ['master', 'exec'] as const) {
      const t = rolePrompt(role, role === 'master' ? 'm' : 'e', undefined, 'm', { root: 'E:\\w' })
      expect(t).not.toMatch(/\bbash\b|vm_stat/)
    }
    expect(CONFLICT_HINT.stale).toContain('不要用 pwsh 直接覆盖')
    expect(denyText('E:\\w\\a.md', { claim: { task: 'T1', owner: 'x', paths: ['E:\\w\\a.md'], at: 'x' }, path: 'E:\\w\\a.md' }, 'E:\\w')).toContain('（pwsh / 脚本）')
  })
})

// ---------------- 真起 PowerShell（只在 Windows 上） ----------------
const pwshExes = process.platform === 'win32' ? [
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
].filter(p => fs.existsSync(p)) : []

describe.runIf(process.platform === 'win32')('G16 W8 真起 PowerShell', () => {
  it('至少找到一个 PowerShell', () => { expect(pwshExes.length).toBeGreaterThan(0) })
  for (const exe of pwshExes) {
    const run = async (command: string) => {
      const store = new Store(path.join(tmp('db'), 'master.db'))
      const done: any[] = []
      const q = new HeavyQueue(store, clock, { logDir: tmp('log'), freeGb: () => 16, totalGb: () => 32, guard: () => undefined, onDone: j => done.push(j), shell: exe })
      const r = await q.submit({ session: 's', label: 'x', command, cwd: tmp('cwd'), minFreeGb: 1 })
      for (let i = 0; i < 600 && !done.length; i++) await new Promise(res => setTimeout(res, 50))
      const log = fs.readFileSync(r.log, 'utf8')
      store.close()
      return { job: done[0], log }
    }
    it(`${path.basename(exe)}：echo 成功 ⇒ 0；中文输出是 UTF-8`, async () => {
      const { job, log } = await run('Write-Output "ok 中文"')
      expect(job).toMatchObject({ state: 'done', exit_code: 0 })
      expect(log).toContain('ok 中文')
    }, 60_000)
    it(`${path.basename(exe)}：原生程序退出码原样带回（cmd /c exit 3 ⇒ 3）`, async () => {
      const { job } = await run('cmd /c exit 3')
      expect(job).toMatchObject({ state: 'failed', exit_code: 3 })
    }, 60_000)
    it(`${path.basename(exe)}：cmdlet 报错 ⇒ 1；前面失败、最后一条成功 ⇒ 0；以注释结尾也正常`, async () => {
      expect((await run('Write-Error boom')).job).toMatchObject({ exit_code: 1 })
      expect((await run('cmd /c exit 2; Write-Output fine')).job).toMatchObject({ exit_code: 0 })
      expect((await run('cmd /c exit 4 # 注释')).job).toMatchObject({ exit_code: 4 })
    }, 120_000)
    it(`${path.basename(exe)}：日志里没有报错、没有 CLIXML（进度条、Write-Error）`, async () => {
      const { log } = await run('Write-Progress -Activity a -PercentComplete 50; Write-Output 中文ok; Write-Error boom')
      expect(log).toContain('中文ok')
      expect(log).not.toMatch(/#< CLIXML|OutputEncoding|句柄无效|handle is invalid/i)
    }, 60_000)
    it(`${path.basename(exe)}：反斜杠紧跟引号`, async () => {
      const { job, log } = await run('Write-Output "E:\\d\\"')
      expect(job).toMatchObject({ exit_code: 0 })
      expect(log).toContain('E:\\d\\')
    }, 60_000)
    it(`${path.basename(exe)}：带双引号、反斜杠、单引号的命令照原样执行`, async () => {
      const { job, log } = await run(`$a = "x\\y 'q'"; Write-Output "[$a]"`)
      expect(job).toMatchObject({ exit_code: 0 })
      expect(log).toContain(`[x\\y 'q']`)
    }, 60_000)
  }
})

describe.runIf(process.platform === 'win32')('G16 Windows 环境冒烟', () => {
  it('git 在 PATH 上（CI 的 Windows 机器）', () => { expect(execFileSync('git', ['--version'], { encoding: 'utf8' })).toMatch(/git version/) })
})

// ---------------- CRLF：用户用会存 CRLF 的编辑器改过受管文档 ----------------
describe('G16 受管文档的 CRLF', () => {
  it('读内容时 CRLF 统一成 LF（按 \\n## 找节能找到）；带外改动检测照原样算', () => {
    const dir = tmp('crlf')
    const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
    mem.docs.write('handbooks/a.md', '# 手册\n\n## 标准做法\n- 先读\n', 'handbook')
    expect(mem.docs.verify()).toEqual([])
    fs.writeFileSync(path.join(dir, 'docs', 'handbooks', 'a.md'), '# 手册\r\n\r\n## 标准做法\r\n- 先读\r\n')
    const text = mem.docs.read('handbooks/a.md')!
    expect(text).toBe('# 手册\n\n## 标准做法\n- 先读\n')
    expect(text.match(/\n## 标准做法\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim()).toBe('- 先读')
    expect(mem.docs.verify().map(d => d.problem)).toEqual(['modified'])
    mem.close()
  })
})
