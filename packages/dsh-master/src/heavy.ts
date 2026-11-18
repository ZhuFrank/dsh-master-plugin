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

/** G14 ① ④：开跑判断用的可用内存口径（返回、巡检、提示里都写这一句，免得模型自己读 vm_stat 的 free 页读成只剩一百多 MB） */
export const FREE_HOW = '插件口径：vm_stat 的 free + inactive + speculative 页（不是只看 free 页），开跑判断用的就是这个数'
export const totalMemGb = (): number => os.totalmem() / 2 ** 30

export interface HeavyOptions {
  logDir: string
  freeGb?: () => number
  /** 整机内存（测试可替换）；门槛高于它的活永远跑不了，提交时直接拒 */
  totalGb?: () => number
  /** G14 ⑤：排第一的够不着时先跑后面够得着的（默认开；false = 严格先进先出） */
  skipAhead?: boolean
  guard: (command: string, cwd: string) => string | undefined
  onDone: (job: HeavyJobRow) => void
  shell?: string
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
    const reason = this.opts.guard(input.command, input.cwd)
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
    const fd = fs.openSync(next.log, 'a', 0o600)
    fs.writeSync(fd, `# heavy_run #${next.id} ${next.label}\n# cwd ${next.cwd}\n# 可用内存 ${free.toFixed(1)} GB\n$ ${next.command}\n`)
    const child = nodeSpawn(this.opts.shell ?? '/bin/bash', ['-lc', next.command], { cwd: next.cwd, stdio: ['ignore', fd, fd] })
    const finish = (code: number | null) => {
      try { fs.closeSync(fd) } catch {}
      this.store.updateHeavyJob(next.id, { state: code === 0 ? 'done' : 'failed', exit_code: code, ended_at: bjtIso(this.clock()) })
      this.running = false
      this.opts.onDone({ ...next, state: code === 0 ? 'done' : 'failed', exit_code: code })
      this.tick()
    }
    child.on('exit', code => finish(code))
    child.on('error', () => finish(-1))
  }
}
