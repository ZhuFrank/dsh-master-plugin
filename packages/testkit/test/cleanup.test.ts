/**
 * G8（测试工具）：端到端跑完自己清理现场。旧位置 ~/dsh_master/.tmp/e2e-work 留了 588 轮、13G（几乎全是无头 Chrome 的用户目录）。
 * - 通过的那个测试文件：删掉它跑的时候新建的工作目录 / 沙盒目录；失败的留着排查；
 * - 每个文件开跑前：每个根目录只留最近 keep 个，更早的（而且至少 minAgeMs 没动过的）删掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it, expect } from 'vitest'
import { removeCreatedSince, pruneOld } from '../src/cleanup.ts'

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-clean-'))
const mk = (r: string, name: string, mtimeMs?: number) => { const d = path.join(r, name); fs.mkdirSync(path.join(d, 'sub'), { recursive: true }); fs.writeFileSync(path.join(d, 'sub', 'f'), 'x'); if (mtimeMs) fs.utimesSync(d, mtimeMs / 1000, mtimeMs / 1000); return d }

it('removeCreatedSince：只删这次新建的目录（连里面的文件），之前就有的不动；根目录不存在也不报错', async () => {
  const a = root(); const b = root()
  const old = mk(a, 'old-1')
  await new Promise(r => setTimeout(r, 30))
  const since = Date.now()
  await new Promise(r => setTimeout(r, 30))
  const n1 = mk(a, 'new-1'); const n2 = mk(b, 'new-2')
  const removed = removeCreatedSince([a, b, path.join(a, 'nope')], since)
  expect(removed.sort()).toEqual([n1, n2].sort())
  expect(fs.existsSync(old)).toBe(true)
  expect(fs.existsSync(n1)).toBe(false)
  expect(fs.existsSync(n2)).toBe(false)
})

it('pruneOld：每个根目录留最近 keep 个；更早的只删放了足够久的', () => {
  const r = root(); const now = Date.now(); const min = 60_000
  const dirs = [0, 1, 2, 3, 4, 5, 6].map(i => mk(r, `run-${i}`, now - (10 - i) * 3600_000)) // run-6 最新
  const fresh = mk(r, 'run-fresh', now - 10_000) // 最新的，刚动过
  const removed = pruneOld([r], { keep: 3, minAgeMs: min, now })
  // 留：run-fresh、run-6、run-5（最近 3 个）；删：run-0 … run-4
  expect(removed.map(d => path.basename(d)).sort()).toEqual(['run-0', 'run-1', 'run-2', 'run-3', 'run-4'])
  expect(fs.readdirSync(r).sort()).toEqual(['run-5', 'run-6', 'run-fresh'])
  expect(dirs.length + 1).toBe(8); expect(fs.existsSync(fresh)).toBe(true)
})

it('pruneOld：超过 keep 但还没放够 minAgeMs 的不删（可能是别的进程正在跑的）', () => {
  const r = root(); const now = Date.now()
  for (const i of [0, 1, 2]) mk(r, `busy-${i}`, now - 5_000)
  expect(pruneOld([r], { keep: 1, minAgeMs: 60_000, now })).toEqual([])
  expect(fs.readdirSync(r)).toHaveLength(3)
})
