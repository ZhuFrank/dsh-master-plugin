/**
 * G7 ②：受阻、没改文件的那一轮也要能写 devlog——files_touched 可以留空，但要在 no_files_reason 写为什么没改文件；
 * 两样都没有照样拒（防止改了文件却忘了列）。工具层（devlog_add 的参数表）也不再把 files_touched 当必填。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer, memoryTools } from '../src/index.ts'

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-g7-'))
  const now = Date.UTC(2026, 10, 7, 4, 0, 0) // 2026-11-07 12:00 BJT
  return new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock: () => now })
}
const blocked = { slug: 'g7-blocked-no-files', hook: '受阻：要往项目外写，等用户批', tags: ['受阻', '权限', 'sandbox'], depth: '琐碎' as const, sections: { 改了什么: '没改，受阻' } }

describe('G7 ② devlog_add 没改文件', () => {
  it('files_touched 留空 + no_files_reason ⇒ 写得进去，frontmatter 写明没改文件', () => {
    const mem = setup()
    const r = mem.devlogAdd({ ...blocked, files_touched: [], no_files_reason: '受阻，没改文件' })
    const body = mem.docs.read(r.file)!
    expect(body).toContain('files_touched: []')
    expect(body).toContain('no_files_reason: 受阻，没改文件')
  })
  it('files_touched 留空、也没写 no_files_reason ⇒ 拒，并说清怎么写', () => {
    const mem = setup()
    expect(() => mem.devlogAdd({ ...blocked, files_touched: [] })).toThrow(/no_files_reason/)
  })
  it('工具参数表里 files_touched 不再是必填，有 no_files_reason', () => {
    const t = memoryTools(setup(), { turnKey: () => undefined } as any).find(x => x.name === 'devlog_add')!
    const p = t.parameters as any
    expect(p.required).not.toContain('files_touched')
    expect(Object.keys(p.properties)).toContain('no_files_reason')
  })
})
