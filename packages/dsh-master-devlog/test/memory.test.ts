import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryLayer, samePath } from '../src/index.ts'

const INDEX = ['devlog', 'INDEX.md'].join('/')
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-mem-'))
  let now = Date.UTC(2026, 10, 2, 23, 0, 0) // 2026-11-03 07:00 BJT
  const clock = Object.assign(() => now, { advance: (ms: number) => { now += ms } })
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  return { dir, mem, clock }
}
const entry = (over: Record<string, unknown> = {}) => ({ slug: 'g3-memory-layer', hook: '记忆层上线：devlog + 决策 + 记忆 + 自动推送', tags: ['记忆层', 'devlog', 'auto-recall'],
  files_touched: ['/w/src/memory.ts'], depth: '实质' as const, sections: { 改了什么: '写了 memory.ts', 为什么: '用户要求', 坑与教训: '无' }, ...over })

describe('devlog 写入校验', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => { s = setup() })
  it('写出条目文件、索引行（北京时间）、frontmatter', () => {
    const r = s.mem.devlogAdd(entry())
    expect(r.file).toBe('devlog/2026-11-03-0700-g3-memory-layer.md')
    expect(r.line).toBe('- [2026-11-03 0700] [g3-memory-layer](2026-11-03-0700-g3-memory-layer.md) — 记忆层上线：devlog + 决策 + 记忆 + 自动推送 · 记忆层, devlog, auto-recall')
    const body = s.mem.docs.read(r.file)!
    expect(body).toMatch(/^---\ndate: 2026-11-03 0700\nslug: g3-memory-layer/)
    expect(body).toContain('## 为什么')
    expect(s.mem.docs.read(INDEX)).toContain(r.line)
  })
  it('slug / hook / tag / 深度段落都校验', () => {
    expect(() => s.mem.devlogAdd(entry({ slug: 'Bad Slug' }))).toThrow(/slug/)
    expect(() => s.mem.devlogAdd(entry({ hook: '改了' }))).toThrow(/hook/)
    expect(() => s.mem.devlogAdd(entry({ tags: ['a1x', 'b2x'] }))).toThrow(/至少 3 个/)
    expect(() => s.mem.devlogAdd(entry({ tags: ['修bug', '记忆层', 'devlog'] }))).toThrow(/含糊/)
    expect(() => s.mem.devlogAdd(entry({ depth: '基础性' }))).toThrow(/决策、遗留歧义/)
    expect(() => s.mem.devlogAdd(entry({ depth: '琐碎', sections: {} }))).toThrow(/改了什么/)
    expect(() => s.mem.devlogAdd(entry({ files_touched: [] }))).toThrow(/files_touched/)
    expect(s.mem.listDevlog()).toHaveLength(0)
  })
  it('一次请求一条：同一轮第二次 devlog_add 被拒，提示用 devlog_amend', () => {
    s.mem.devlogAdd(entry({ turnKey: 'exec-a:1' }))
    expect(() => s.mem.devlogAdd(entry({ slug: 'g3-second-entry', tags: ['别的', 'x-tool', 'y-layer'], files_touched: ['/w/other.ts'], turnKey: 'exec-a:1' }))).toThrow(/一次请求一条/)
    expect(s.mem.devlogAdd(entry({ slug: 'g3-second-entry', tags: ['别的', 'x-tool', 'y-layer'], files_touched: ['/w/other.ts'], turnKey: 'exec-a:2' })).slug).toBe('g3-second-entry')
  })
  it('回忆这一半：碰到以前碰过的文件或 tag，不引用前情也不说明理由 → 拒', () => {
    s.mem.devlogAdd(entry())
    s.clock.advance(60_000)
    const second = entry({ slug: 'g3-memory-fix', tags: ['另一个', 'x-tool', 'y-layer'], files_touched: ['src/memory.ts'] })
    expect(() => s.mem.devlogAdd(second)).toThrow(/g3-memory-layer/)
    expect(s.mem.devlogAdd({ ...second, related: ['g3-memory-layer'] }).slug).toBe('g3-memory-fix')
    const third = entry({ slug: 'g3-memory-third', tags: ['记忆层', 'z1x', 'z2x'], files_touched: ['/w/z.ts'] })
    expect(() => s.mem.devlogAdd(third)).toThrow(/related/)
    expect(s.mem.devlogAdd({ ...third, no_related_reason: '只是同名 tag，改的是另一个模块' }).slug).toBe('g3-memory-third')
  })
  it('G5-F ①：只共享泛标签（停用表 / 语言工具 / 纯数字 / 任务号 / 会话名）不要求引用；共享具体标签照样要求', () => {
    s.mem.devlogAdd(entry({ slug: 'first-generic', tags: ['单文件', 'python', '1440', 'l1103-5', 'exec-docs', 'snake'], files_touched: ['/w/a.ts'] }))
    s.clock.advance(60_000)
    // 只共享泛标签：不要求
    expect(s.mem.devlogAdd(entry({ slug: 'second-generic', tags: ['单文件', 'python', '1440', 'l1103-5', 'exec-docs', 'pong'], files_touched: ['/w/b.ts'] })).slug).toBe('second-generic')
    s.clock.advance(60_000)
    // 共享具体标签 snake：照样要求
    expect(() => s.mem.devlogAdd(entry({ slug: 'third-snake', tags: ['snake', '单文件', 'zz-x'], files_touched: ['/w/c.ts'] }))).toThrow(/first-generic/)
  })
  it('补记：追加到条目文件和索引', () => {
    s.mem.devlogAdd(entry())
    s.clock.advance(5 * 60_000)
    s.mem.devlogAmend('g3-memory-layer', '补记：修了一个错字')
    expect(s.mem.docs.read('devlog/2026-11-03-0700-g3-memory-layer.md')).toMatch(/## 补记\n\n- 2026-11-03 0705：补记：修了一个错字/)
    expect(s.mem.docs.read(INDEX)).toContain('  - 补记（2026-11-03 0705）：补记：修了一个错字')
  })
})

describe('记忆桥 / 决策 / 记忆', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => { s = setup() })
  it('lesson → 同时写一条 feedback 记忆，两边互相链接', () => {
    const r = s.mem.devlogAdd(entry({ lesson: { rule: '状态行时间只取 date 输出', why: '编过时间被抓', how: '发消息前现取' } }))
    expect(r.memory).toBe('feedback-g3-memory-layer')
    const m = s.mem.docs.read('memory/feedback-g3-memory-layer.md')!
    expect(m).toContain('type: feedback'); expect(m).toContain('[[g3-memory-layer]]'); expect(m).toContain('**Why:**')
    expect(s.mem.docs.read(r.file)).toContain('related_memories: [[[feedback-g3-memory-layer]]]')
    expect(s.mem.docs.read('memory/MEMORY.md')).toContain('feedback-g3-memory-layer')
  })
  it('决策：context 必须是已有 devlog；只追加；supersedes 指向旧行', () => {
    expect(() => s.mem.decisionAdd({ decision: 'a', reasoning: 'b', context_slug: 'nope-x' })).toThrow(/不存在/)
    s.mem.devlogAdd(entry())
    const d1 = s.mem.decisionAdd({ decision: '用 node:sqlite', reasoning: '原型也这么用', context_slug: 'g3-memory-layer' })
    expect(d1.line).toBe('[2026-11-03] DECISION: 用 node:sqlite | REASONING: 原型也这么用 | CONTEXT: see devlog/2026-11-03-0700-g3-memory-layer.md')
    const d2 = s.mem.decisionAdd({ decision: '改用 JSON', reasoning: '试试', context_slug: 'g3-memory-layer', supersedes: d1.seq })
    expect(d2.line).toContain(`SUPERSEDES: #${d1.seq}`)
    expect(() => s.mem.db.run('UPDATE decisions SET decision = ?', 'x')).toThrow(/append-only/)
    expect(() => s.mem.db.run('DELETE FROM decisions')).toThrow(/append-only/)
    expect(s.mem.docs.read('decisions.md')).toContain('（已被推翻）')
  })
  it('记忆：四类、一行摘要、feedback 要 Why；[[链接]] 被解析；更新会加版本', () => {
    expect(() => s.mem.memoryWrite({ name: 'x-y', type: 'other' as any, description: 'd', body: 'b' })).toThrow(/type/)
    expect(() => s.mem.memoryWrite({ name: 'x-y', type: 'feedback', description: 'd', body: '没有原因' })).toThrow(/Why/)
    s.mem.memoryWrite({ name: 'user-role', type: 'user', description: '用户是独立开发者', body: '见 [[feedback-x]]' })
    expect(JSON.parse(s.mem.getMemory('user-role')!.links)).toEqual(['feedback-x'])
    s.mem.memoryWrite({ name: 'user-role', type: 'user', description: '用户是独立开发者（更新）', body: 'b2' })
    expect(s.mem.getMemory('user-role')!.versions).toBe(2)
  })
})

describe('回忆与自动推送查询', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => { s = setup(); s.mem.devlogAdd(entry({ lesson: { rule: 'r', why: 'w', how: 'h' } })) })
  it('recall 只匹配 tag 段：hook 里的词不算', () => {
    expect(s.mem.recall({ term: '记忆层' }).devlog).toHaveLength(1)
    expect(s.mem.recall({ term: '自动推送' }).devlog).toHaveLength(0) // 只在 hook 里
    expect(s.mem.recall({ files: ['memory.ts'] }).devlog).toHaveLength(1)
    expect(s.mem.recall({ term: '记忆层' }).memories[0]).toContain('feedback-g3-memory-layer')
  })
  it('relatedForFiles：相对路径与绝对路径重合也算；带出决策和记忆', () => {
    s.mem.decisionAdd({ decision: '用 sqlite', reasoning: 'r', context_slug: 'g3-memory-layer' })
    const p = s.mem.relatedForFiles(['/other/w/src/memory.ts', 'src/memory.ts'])
    expect(p.map(x => x.slug)).toEqual(['g3-memory-layer'])
    expect(p[0]!.decisions[0]).toContain('用 sqlite'); expect(p[0]!.memories[0]).toContain('feedback-g3-memory-layer')
    expect(s.mem.relatedForFiles(['/w/src/other.ts'])).toEqual([])
    expect(samePath('a/memory.ts', '/x/a/memory.ts')).toBe(true); expect(samePath('memory.ts', '/x/notmemory.ts')).toBe(false)
  })
  it('relatedForText：命中 tag / 文件名 / 任务 ID', () => {
    expect(s.mem.relatedForText('我们来看看 auto-recall 的实现')[0]!.reason).toContain('auto-recall')
    expect(s.mem.relatedForText('memory.ts 有个问题')[0]!.reason).toContain('memory.ts')
    expect(s.mem.relatedForText('完全无关的话')).toEqual([])
  })
  it('常驻摘要有上限', () => {
    for (let i = 0; i < 40; i++) { s.clock.advance(60_000); s.mem.devlogAdd(entry({ slug: `bulk-entry-${i}`, tags: [`t${i}a`, `t${i}b`, `t${i}c`], files_touched: [`/w/f${i}.ts`], hook: 'x'.repeat(300) })) }
    const sum = s.mem.residentSummary({ maxChars: 3000 })
    expect(sum.length).toBeLessThanOrEqual(3000)
    expect(sum).toContain('记忆层摘要')
  })
})

describe('一致性核对与带外改动', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => { s = setup(); s.mem.devlogAdd(entry()) })
  it('删掉条目文件 / 多出一个条目文件 → check 报出来', () => {
    fs.rmSync(s.mem.docs.abs('devlog/2026-11-03-0700-g3-memory-layer.md'))
    fs.writeFileSync(s.mem.docs.abs('devlog/2026-11-03-0800-stray-entry.md'), 'x')
    const c = s.mem.check()
    expect(c.problems.join('\n')).toMatch(/索引有、文件没有：devlog\/2026-11-03-0700-g3-memory-layer\.md[\s\S]*文件有、索引没有：devlog\/2026-11-03-0800-stray-entry\.md/)
    expect(c.drift.map(d => `${d.path}:${d.problem}`)).toContain('devlog/2026-11-03-0700-g3-memory-layer.md:missing')
  })
  it('插件外改了受管文件 → verify 报 modified；插件再写时另存外部版本并记 docs/drift', () => {
    const f = s.mem.docs.abs(INDEX)
    fs.appendFileSync(f, '\n手改的一行\n')
    expect(s.mem.docs.verify().map(d => `${d.path}:${d.problem}`)).toEqual([`${INDEX}:modified`])
    const before = s.mem.docs.lastLogSeq()
    s.mem.devlogAmend('g3-memory-layer', '补一句') // 会重写索引
    const absorbed = s.mem.docs.absorbedDrift(before)
    expect(absorbed).toHaveLength(1)
    expect(absorbed[0]!.path).toBe(INDEX)
    expect(fs.readFileSync(absorbed[0]!.saved!, 'utf8')).toContain('手改的一行')
    expect(s.mem.docs.verify()).toEqual([])
  })
})
