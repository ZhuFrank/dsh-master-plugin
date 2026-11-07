import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { acquireStateLock, StateDirLockedError } from '../src/lock.ts'
import { tmpdir } from './helpers.ts'

describe('状态目录锁', () => {
  it('另一个活着的进程占着 → 拒绝启动', () => {
    const dir = tmpdir('lock')
    acquireStateLock(dir, process.ppid)
    expect(() => acquireStateLock(dir)).toThrow(StateDirLockedError)
  })
  it('旧锁的进程已不在 → 接管', () => {
    const dir = tmpdir('lock')
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: 2_147_000_000 }))
    const release = acquireStateLock(dir)
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.lock'), 'utf8')).pid).toBe(process.pid)
    release()
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false)
  })
  it('同一进程可重入（插件热替换）', () => {
    const dir = tmpdir('lock')
    acquireStateLock(dir)
    expect(() => acquireStateLock(dir)).not.toThrow()
  })
})
