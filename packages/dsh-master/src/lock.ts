/** 状态目录防双开：两个 DSH 进程不能同时用同一个 dsh-master 状态目录。同一进程（热替换）可以重入。 */
import fs from 'node:fs'
import path from 'node:path'

export class StateDirLockedError extends Error {}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export function acquireStateLock(dir: string, pid = process.pid): () => void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, '.lock')
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
      return () => release(file, pid)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let owner = NaN
      try { owner = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid) } catch {}
      if (owner === pid) return () => release(file, pid)
      if (Number.isFinite(owner) && alive(owner)) throw new StateDirLockedError(`dsh-master 状态目录 ${dir} 已被进程 ${owner} 占用（另一个 DSH 在用同一个 DSH_HOME？）`)
      fs.rmSync(file, { force: true }) // 旧锁的进程已经不在了
    }
  }
  throw new StateDirLockedError(`无法获取状态目录锁：${file}`)
}

function release(file: string, pid: number): void {
  try { if (Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid) === pid) fs.rmSync(file, { force: true }) } catch {}
}
