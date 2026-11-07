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

export interface HeavyOptions {
  logDir: string
  freeGb?: () => number
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
    const at = bjtIso(this.clock())
    const id = this.store.addHeavyJob({ session: input.session, label: input.label, command: input.command, cwd: input.cwd, min_free_gb: input.minFreeGb, log: '', created_at: at })
    const log = path.join(this.opts.logDir, `${id}.log`)
    this.store.db.prepare('UPDATE heavy_jobs SET log = ? WHERE id = ?').run(log, id)
    const ahead = this.store.heavyJobs().filter(j => j.id < id && (j.state === 'queued' || j.state === 'running')).length
    this.tick()
    return { id, log, queued_ahead: ahead, note: '排上了；跑完会自动发消息给你，不要等，先结束本轮或做别的。' }
  }

  /** 心跳：没有在跑的、内存够，就开跑下一件。 */
  tick(): void {
    if (this.running || this.store.heavyJobs('running').length) return
    const next = this.store.heavyJobs('queued')[0]
    if (!next) return
    const free = (this.opts.freeGb ?? freeMemGb)()
    if (free < next.min_free_gb) return
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
