/**
 * 重活排队：同一时间只跑一件；开跑前只读查系统可用内存（不碰 Claude Code 侧的锁和任何文件）；跑完给提交的会话发消息。
 * 命令不走 DSH 的 bash 工具（插件进程 spawn），提交前过同一个守卫。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn, execFileSync } from 'node:child_process'
import type { Store, HeavyJobRow } from './store.ts'
import { bjtIso, type Clock } from './time.ts'
import type { HeavyRunner } from './core.ts'

/** macOS：vm_stat 的 free + inactive + speculative 页；其他平台退回 os.freemem()。只读。 */
export function freeMemGb(): number {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('vm_stat', { encoding: 'utf8' })
      const page = Number(out.match(/page size of (\d+)/)?.[1] ?? 16384)
      const pages = (k: string) => Number(out.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1] ?? 0)
      return ((pages('free') + pages('inactive') + pages('speculative')) * page) / 2 ** 30
    }
  } catch { /* 读不到就用下面的 */ }
  return os.freemem() / 2 ** 30
}

/** G14 ① ④：开跑判断用的可用内存口径（返回、巡检、提示里都写这一句，免得模型自己读 vm_stat 的 free 页读成只剩一百多 MB）。G16：按平台写。 */
export function freeHow(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '插件口径：vm_stat 的 free + inactive + speculative 页（不是只看 free 页），开跑判断用的就是这个数'
  return platform === 'win32'
    ? '插件口径：Node 的 os.freemem()（Windows 报告的可用物理内存），开跑判断用的就是这个数'
    : '插件口径：Node 的 os.freemem()（Linux 的 MemAvailable），开跑判断用的就是这个数'
}
export const FREE_HOW = freeHow()
/** G16：完成通知里怎么读日志（Windows PowerShell 5.1 的 Get-Content 默认按系统代码页读，会把 UTF-8 读成乱码）。 */
export const LOG_READ_HINT = process.platform === 'win32' ? '（用 read 工具读；用 PowerShell 读要加 -Encoding UTF8）' : ''

// ---------------- G16（W8）：Windows 上用 PowerShell 跑 ----------------

/** 照 DSH 的 dsh-pwsh-local：PowerShell 7 → PATH 上的 pwsh.exe → Windows PowerShell 5.1；用 lstat 判断（Microsoft Store 装的是应用别名）。 */
export function resolvePwsh(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = lexists): string {
  const pf = env.ProgramFiles ?? 'C:\\Program Files'
  const sr = env.SystemRoot ?? 'C:\\Windows'
  const cands = [path.win32.join(pf, 'PowerShell', '7', 'pwsh.exe')]
  for (const e of (env.PATH ?? env.Path ?? '').split(';')) { const t = e.trim().replace(/^"|"$/g, ''); if (t) cands.push(path.win32.join(t, 'pwsh.exe')) }
  cands.push(path.win32.join(sr, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return cands.find(exists) ?? 'powershell.exe'
}
function lexists(p: string): boolean { try { const st = fs.lstatSync(p); return st.isFile() || st.isSymbolicLink() } catch { return false } }

/** DSH 同款的 UTF-8 前缀 + 关进度条（单独一行：PowerShell 5.1 报错时会把出错那一行原样打进日志，不让前缀混进去；代价是报错行号比用户命令多 1）；
 *  用户命令后面先换行（命令以 # 注释结尾时收尾不被注释掉），收尾按「最后一条命令」定退出码：
 *  成功 ⇒ 0；失败且原生程序退出码非 0 ⇒ 原样（-Command 会把它压成 1）；其余失败 ⇒ 1。 */
export const PWSH_PREAMBLE = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ProgressPreference = 'SilentlyContinue'; $global:LASTEXITCODE = 0\n"
export const PWSH_EPILOGUE = "\n$__dshOk = $?; if ($__dshOk) { exit 0 } elseif ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }"
export function pwshArgv(command: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${PWSH_PREAMBLE}${command}${PWSH_EPILOGUE}`]
}
export const totalMemGb = (): number => os.totalmem() / 2 ** 30

export interface HeavyOptions {
  logDir: string
  freeGb?: () => number
  /** 整机内存（测试可替换）；门槛高于它的活永远跑不了，提交时直接拒 */
  totalGb?: () => number
  /** G14 ⑤：排第一的够不着时先跑后面够得着的（默认开；false = 严格先进先出） */
  skipAhead?: boolean
  guard: (command: string, cwd: string, session?: string) => string | undefined
  /** G16：start_error = 程序都没起来时的报错原文（只在内存里带给通知，不进库）。 */
  onDone: (job: HeavyJobRow & { start_error?: string }) => void
  shell?: string
  /** G16：测试注入（默认 process.platform / node:child_process.spawn / process.env）。 */
  platform?: NodeJS.Platform
  spawn?: typeof nodeSpawn
  env?: NodeJS.ProcessEnv
}

export class HeavyQueue implements HeavyRunner {
  private running = false
  constructor(private readonly store: Store, private readonly clock: Clock, private readonly opts: HeavyOptions) {
    fs.mkdirSync(opts.logDir, { recursive: true, mode: 0o700 })
  }

  /** 上个进程留下的「运行中」任务：DSH 重启时被中断了，标失败并通知。 */
  recover(): void {
    for (const j of this.store.heavyJobs('running')) {
      this.store.updateHeavyJob(j.id, { state: 'failed', exit_code: null, ended_at: bjtIso(this.clock()) })
      this.opts.onDone({ ...j, state: 'failed' })
    }
  }

  async submit(input: { session: string; label: string; command: string; cwd: string; minFreeGb: number }) {
    const reason = this.opts.guard(input.command, input.cwd, input.session)
    if (reason) throw new Error(reason)
    const total = (this.opts.totalGb ?? totalMemGb)()
    if (input.minFreeGb > total) throw new Error(`min_free_gb=${input.minFreeGb} 比整机内存 ${total.toFixed(1)} GB 还大，这件活永远跑不起来；一般用默认 4 就够`)
    const at = bjtIso(this.clock())
    const id = this.store.addHeavyJob({ session: input.session, label: input.label, command: input.command, cwd: input.cwd, min_free_gb: input.minFreeGb, log: '', created_at: at })
    const log = path.join(this.opts.logDir, `${id}.log`)
    this.store.db.prepare('UPDATE heavy_jobs SET log = ? WHERE id = ?').run(log, id)
    const ahead = this.store.heavyJobs().filter(j => j.id < id && (j.state === 'queued' || j.state === 'running')).length
    const free = this.free()
    this.tick()
    const low = free < input.minFreeGb ? `现在可用 ${free.toFixed(1)} GB，低于你设的门槛 ${input.minFreeGb} GB，会一直排着直到内存够（${FREE_HOW}）；门槛设高了就 heavy_cancel 后用低一点的重提，一般默认 4 就够。` : ''
    return { id, log, queued_ahead: ahead, note: `${low}排上了；跑完会自动发消息给你，不要等，先结束本轮或做别的。` }
  }

  private free(): number { return (this.opts.freeGb ?? freeMemGb)() }

  /** G14 ③：取消一件排队中的活（权限在 Core 里判）；跑着的不管，停到一半可能留下半截文件。 */
  cancel(id: number, by: string): { id: number; state: 'cancelled'; label: string } {
    const j = this.store.heavyJob(id)
    if (!j || j.state !== 'queued') throw new Error(`重活 #${id} 不在排队中（${j ? `现在是 ${j.state}` : '没有这一件'}），只能取消排队中的`)
    this.store.updateHeavyJob(id, { state: 'cancelled', ended_at: bjtIso(this.clock()) })
    this.opts.onDone({ ...j, state: 'cancelled', cancelled_by: by } as HeavyJobRow)
    return { id, state: 'cancelled', label: j.label }
  }

  job(id: number): HeavyJobRow | undefined { return this.store.heavyJob(id) }
  jobs(): HeavyJobRow[] { return this.store.heavyJobs() }
  /** G14 ① ④：当前可用内存（插件口径）和整机内存。 */
  memory(): { free_gb: number; total_gb: number; how: string } {
    return { free_gb: Math.round(this.free() * 10) / 10, total_gb: Math.round((this.opts.totalGb ?? totalMemGb)() * 10) / 10, how: FREE_HOW }
  }

  /** 心跳：没有在跑的、内存够，就开跑下一件。 */
  tick(): void {
    if (this.running || this.store.heavyJobs('running').length) return
    const queued = this.store.heavyJobs('queued')
    if (!queued.length) return
    const free = this.free()
    // G14 ⑤：按顺序找第一件够得着的（排第一的够得着就一定是它）；skipAhead=false 退回严格先进先出
    const next = this.opts.skipAhead === false ? (queued[0]!.min_free_gb <= free ? queued[0] : undefined) : queued.find(j => j.min_free_gb <= free)
    if (!next) return
    this.running = true
    this.store.updateHeavyJob(next.id, { state: 'running', started_at: bjtIso(this.clock()) })
    const win = (this.opts.platform ?? process.platform) === 'win32'
    const fd = fs.openSync(next.log, 'a', 0o600)
    // G16：Windows 上日志开头写 UTF-8 BOM（PowerShell 5.1 的 Get-Content 靠它认出 UTF-8）
    fs.writeSync(fd, `${win ? '\uFEFF' : ''}# heavy_run #${next.id} ${next.label}\n# cwd ${next.cwd}\n# 可用内存 ${free.toFixed(1)} GB\n$ ${next.command}\n`)
    const spawn = this.opts.spawn ?? nodeSpawn
    const env = this.opts.env ?? process.env
    const child = win
      ? spawn(this.opts.shell ?? resolvePwsh(env), pwshArgv(next.command), { cwd: next.cwd, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...env, NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' } })
      : spawn(this.opts.shell ?? '/bin/bash', ['-lc', next.command], { cwd: next.cwd, stdio: ['ignore', fd, fd] })
    let finished = false
    const finish = (code: number | null, startError?: string) => {
      if (finished) return // G16：exit 和 error 都来时只记一次
      finished = true
      // G16（W8）：程序都没起来（找不到 /bin/bash、powershell.exe…）⇒ 原因写进日志和完成通知，不然只看到 failed
      if (startError) { try { fs.writeSync(fd, `# 启动失败：${startError}\n`) } catch {} }
      try { fs.closeSync(fd) } catch {}
      this.store.updateHeavyJob(next.id, { state: code === 0 ? 'done' : 'failed', exit_code: code, ended_at: bjtIso(this.clock()) })
      this.running = false
      this.opts.onDone({ ...next, state: code === 0 ? 'done' : 'failed', exit_code: code, ...(startError ? { start_error: startError } : {}) })
      this.tick()
    }
    child.on('exit', code => finish(code))
    child.on('error', (err: Error) => finish(-1, err.message))
  }
}
