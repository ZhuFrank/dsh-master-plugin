/**
 * 记忆层：devlog（条目 + 索引）、决策日志、记忆文件（四类 + 索引 + [[链接]]）、记忆桥、回忆、自动推送用的「相关前情」查询。
 * 索引不进上下文，靠检索；渲染出的 INDEX.md / decisions.md / memory/MEMORY.md 只给人看。
 */
import fs from 'node:fs'
import path from 'node:path'
import { tagWeights, linkCandidates, entryTasks, mentionsWord, type TagWeights, type LinkCandidate } from './weights.ts'
import { MemoryDb } from './db.ts'
import { ManagedDocs, type Drift } from './docs.ts'
import { bjtIso, bjtStamp, type Clock } from './time.ts'

export class MemoryInputError extends Error {}

export const DEPTHS = ['琐碎', '实质', '基础性'] as const
export type Depth = (typeof DEPTHS)[number]
export const SECTIONS = ['改了什么', '为什么', '决策', '坑与教训', '遗留歧义'] as const
/** 每种深度必须有的段落（深度匹配改动分量，不一刀切）。 */
export const REQUIRED_SECTIONS: Record<Depth, readonly string[]> = {
  琐碎: ['改了什么'],
  实质: ['改了什么', '为什么', '坑与教训'],
  基础性: ['改了什么', '为什么', '决策', '坑与教训', '遗留歧义'],
}
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
/** 含糊 tag 对回忆毫无价值。 */
const VAGUE_TAGS = new Set(['修bug', 'bug', 'fix', '修复', '更新', '更新文件', 'update', '修改', '优化', '杂项', 'misc', '其他', 'wip'])
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){1,7}$/
const MEM_NAME = /^[a-z0-9]+(?:-[a-z0-9]+){0,9}$/

export interface DevlogRow { slug: string; at: string; at_ms: number; file: string; hook: string; tags: string; files_touched: string; depth: Depth; session: string | null; task: string | null; turn_key: string | null; related: string; memories: string }
export interface DecisionRow { seq: number; at: string; decision: string; reasoning: string; context_slug: string; supersedes: number | null; line: string }
export interface MemoryRow { name: string; type: MemoryType; description: string; file: string; links: string; created_at: string; updated_at: string; versions: number }
export interface Prior { slug: string; line: string; reason: string; decisions: string[]; memories: string[] }

export interface DevlogInput {
  slug: string; hook: string; tags: string[]; files_touched: string[]; depth: Depth; sections: Record<string, string>
  related?: string[]; no_related_reason?: string; no_files_reason?: unknown; lesson?: { rule: string; why: string; how: string }
  task?: string; session?: string; turnKey?: string
}

const J = <T>(s: string): T => JSON.parse(s) as T
const norm = (p: string) => p.replace(/\/+$/, '')
/** 路径重合：完全相同，或一方以「/另一方」结尾（相对路径 vs 绝对路径）。 */
export function samePath(a: string, b: string): boolean {
  a = norm(a); b = norm(b)
  if (!a || !b) return false
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
}

export class MemoryLayer {
  readonly db: MemoryDb
  readonly docs: ManagedDocs
  constructor(opts: { dbFile: string; docsRoot: string; clock: Clock }, private readonly clock: Clock = opts.clock) {
    this.db = new MemoryDb(opts.dbFile)
    this.docs = new ManagedDocs(opts.docsRoot, this.db, () => bjtIso(this.clock()))
  }
  close(): void { this.db.close() }
  private log(type: string, data: unknown, session?: string | null) {
    this.db.run('INSERT INTO log(at, session, type, data) VALUES(?,?,?,?)', bjtIso(this.clock()), session ?? null, type, JSON.stringify(data ?? {}))
  }

  // ---------------- devlog ----------------
  getDevlog(slug: string): DevlogRow | undefined { return this.db.get<DevlogRow>('SELECT * FROM devlog WHERE slug = ?', slug) }
  listDevlog(): DevlogRow[] { return this.db.all<DevlogRow>('SELECT * FROM devlog ORDER BY at_ms DESC, slug') }

  indexLine(r: DevlogRow): string { return `- [${bjtStamp(r.at_ms)}] [${r.slug}](${path.basename(r.file)}) — ${r.hook} · ${J<string[]>(r.tags).join(', ')}` }

  /**
   * 与这些文件 / tag 重合的旧条目（不含 exclude）。
   * G5-F ①：tag 只算「具体标签」（同 weights.ts：停用表、纯数字、任务号、会话名、太常见的都不算），
   * 只共享「单文件」「python」这类泛标签不要求引用；文件重合照旧算。
   */
  priorFor(files: string[], tags: string[], exclude?: string): DevlogRow[] {
    const out = new Map<string, DevlogRow>()
    const w = this.tagWeights()
    const topic = tags.map(t => t.toLowerCase()).filter(t => w.isTopic(t))
    for (const r of this.listDevlog()) {
      if (r.slug === exclude) continue
      const rf = J<string[]>(r.files_touched); const rt = J<string[]>(r.tags).map(t => t.toLowerCase())
      if (files.some(f => rf.some(g => samePath(f, g))) || topic.some(t => rt.includes(t))) out.set(r.slug, r)
    }
    return [...out.values()]
  }

  devlogAdd(input: DevlogInput): { slug: string; file: string; line: string; memory?: string } {
    const slug = (input.slug ?? '').trim()
    if (!SLUG.test(slug)) throw new MemoryInputError('slug 要 2–8 个小写英文/数字词，用连字符连起来，例如 g3-memory-layer')
    if (this.getDevlog(slug)) throw new MemoryInputError(`slug ${slug} 已存在；同一件事的补充用 devlog_amend`)
    const hook = (input.hook ?? '').trim()
    if (hook.length < 8 || hook.length > 400) throw new MemoryInputError('hook 写一句具体的话（8–400 字）：点名产物、决策或坑，而不只是动词')
    const tags = [...new Set((input.tags ?? []).map(t => String(t).trim()).filter(Boolean))]
    if (tags.length < 3) throw new MemoryInputError('tags 至少 3 个，要具体：脚本名、层、工具、领域')
    const vague = tags.filter(t => VAGUE_TAGS.has(t.toLowerCase()))
    if (vague.length) throw new MemoryInputError(`这些 tag 太含糊，对回忆没用：${vague.join('、')}`)
    if (tags.some(t => t.length > 40 || /[·,，]/.test(t))) throw new MemoryInputError('单个 tag 不超过 40 字，且不能含「·」或逗号')
    const depth = input.depth
    if (!DEPTHS.includes(depth)) throw new MemoryInputError(`depth 只能是：${DEPTHS.join('、')}`)
    const sections = input.sections ?? {}
    const missing = REQUIRED_SECTIONS[depth].filter(k => !String(sections[k] ?? '').trim())
    if (missing.length) throw new MemoryInputError(`depth=${depth} 必须写这些段落：${missing.join('、')}`)
    const files = [...new Set((input.files_touched ?? []).map(f => norm(String(f).trim())).filter(Boolean))]
    // G7 ②：受阻、没改文件的那一轮也要能记——files_touched 留空时必须在 no_files_reason 写为什么没改文件
    const noFiles = String(input.no_files_reason ?? '').trim()
    if (!files.length && !noFiles) throw new MemoryInputError('files_touched 至少一个路径（改了或新建了哪些文件）；这一轮确实没改文件（比如受阻）就留空 files_touched，并在 no_files_reason 写为什么')
    const related = [...new Set((input.related ?? []).map(String))]
    for (const r of related) if (!this.getDevlog(r)) throw new MemoryInputError(`related 里的 ${r} 不存在`)
    // 回忆这一半：动以前碰过的地方，必须把前情摆出来（引用至少一条）或说明为什么无关
    const priors = this.priorFor(files, tags)
    if (priors.length && !priors.some(p => related.includes(p.slug)) && !(input.no_related_reason ?? '').trim()) {
      throw new MemoryInputError(`这次改动碰到了以前碰过的地方，先看前情并在 related 里引用（或在 no_related_reason 说明为什么无关）：\n${priors.slice(0, 8).map(p => this.indexLine(p)).join('\n')}`)
    }
    if (input.turnKey) {
      const same = this.db.get<{ slug: string }>('SELECT slug FROM devlog WHERE turn_key = ?', input.turnKey)
      if (same) throw new MemoryInputError(`这一轮已经写过 ${same.slug}（一次请求一条）；追加内容用 devlog_amend`)
    }
    if (input.lesson && (!input.lesson.rule?.trim() || !input.lesson.why?.trim() || !input.lesson.how?.trim())) throw new MemoryInputError('lesson 要三项都写：rule（以后怎么做）、why、how')

    const now = this.clock(); const stamp = bjtStamp(now)
    const file = `devlog/${stamp.replace(' ', '-')}-${slug}.md`
    const memName = input.lesson ? `feedback-${slug}`.slice(0, 80) : undefined
    const relatedLinks = related.map(r => `[[${r}]]`)
    const body = [
      '---', `date: ${stamp}`, `slug: ${slug}`, `depth: ${depth}`, `tags: [${tags.join(', ')}]`, ...(files.length ? ['files_touched:', ...files.map(f => `  - ${f}`)] : ['files_touched: []', `no_files_reason: ${noFiles.replace(/\s+/g, ' ')}`]),
      `related_devlogs: [${relatedLinks.join(', ')}]`, `related_memories: [${memName ? `[[${memName}]]` : ''}]`,
      ...(input.task ? [`task: ${input.task}`] : []), ...(input.session ? [`session: ${input.session}`] : []), '---', '',
      `# ${hook}`, '',
      ...SECTIONS.filter(k => String(sections[k] ?? '').trim()).flatMap(k => [`## ${k}`, '', String(sections[k]).trim(), '']),
      ...(input.no_related_reason && priors.length ? ['## 与前情的关系', '', input.no_related_reason.trim(), ''] : []),
    ].join('\n')
    this.db.tx(() => {
      this.db.run(`INSERT INTO devlog(slug, at, at_ms, file, hook, tags, files_touched, depth, session, task, turn_key, related, memories) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        slug, bjtIso(now), now, file, hook, JSON.stringify(tags), JSON.stringify(files), depth, input.session ?? null, input.task ?? null, input.turnKey ?? null, JSON.stringify(related), JSON.stringify(memName ? [memName] : []))
      for (const t of tags) this.db.run('INSERT INTO devlog_tags(slug, tag) VALUES(?,?)', slug, t.toLowerCase())
      for (const f of files) this.db.run('INSERT INTO devlog_files(slug, path) VALUES(?,?)', slug, f)
      this.docs.write(file, body, 'devlog')
      if (input.lesson && memName) {
        this.memoryWrite({ name: memName, type: 'feedback', description: input.lesson.rule.trim().split('\n')[0]!.slice(0, 160),
          body: `${input.lesson.rule.trim()}\n\n**Why:** ${input.lesson.why.trim()}\n\n**How to apply:** ${input.lesson.how.trim()}\n\n出处：[[${slug}]]`, session: input.session }, false)
      }
      this.log('devlog/add', { slug, file, memory: memName }, input.session)
      this.renderIndex(); this.renderMemoryIndex()
    })
    return { slug, file, line: this.indexLine(this.getDevlog(slug)!), ...(memName ? { memory: memName } : {}) }
  }

  devlogAmend(slug: string, line: string, session?: string): { slug: string; line: string } {
    const r = this.getDevlog(slug)
    if (!r) throw new MemoryInputError(`没有 devlog ${slug}`)
    const text = (line ?? '').trim()
    if (!text || text.length > 600) throw new MemoryInputError('补记写一句（1–600 字）')
    const at = bjtStamp(this.clock())
    this.db.tx(() => {
      const cur = this.docs.read(r.file) ?? ''
      const sep = cur.includes('\n## 补记\n') ? '' : '\n## 补记\n\n'
      this.docs.write(r.file, `${cur.replace(/\n*$/, '\n')}${sep}- ${at}：${text}\n`, 'devlog')
      this.db.run('INSERT INTO devlog_amends(slug, at, line) VALUES(?,?,?)', slug, at, text)
      this.log('devlog/amend', { slug, line: text }, session)
      this.renderIndex()
    })
    return { slug, line: text }
  }

  private renderIndex(): void {
    const amends = this.db.all<{ slug: string; at: string; line: string }>('SELECT slug, at, line FROM devlog_amends ORDER BY seq')
    const lines = ['# Dev Log Index', '', '由 dsh-master 插件生成，只读。最新在前；回忆请用 devlog_recall（只匹配 tag 段）。', '']
    for (const r of this.listDevlog()) {
      lines.push(this.indexLine(r))
      for (const a of amends.filter(x => x.slug === r.slug)) lines.push(`  - 补记（${a.at}）：${a.line}`)
    }
    this.docs.write('devlog/INDEX.md', lines.join('\n') + '\n', 'index')
  }

  // ---------------- 决策 ----------------
  decisionAdd(input: { decision: string; reasoning: string; context_slug: string; supersedes?: number; session?: string }): DecisionRow {
    const decision = (input.decision ?? '').trim(); const reasoning = (input.reasoning ?? '').trim(); const ctx = (input.context_slug ?? '').trim()
    if (!decision || !reasoning) throw new MemoryInputError('decision 和 reasoning 都要写（一句话）')
    if (/[|\n]/.test(decision + reasoning)) throw new MemoryInputError('decision / reasoning 不能含「|」或换行（一行一条）')
    if (!this.getDevlog(ctx)) throw new MemoryInputError(`context_slug ${ctx} 不存在：长推理先写进 devlog，决策行指回它`)
    if (input.supersedes !== undefined && !this.db.get('SELECT seq FROM decisions WHERE seq = ?', input.supersedes)) throw new MemoryInputError(`没有第 ${input.supersedes} 条决策`)
    const at = bjtIso(this.clock())
    const line = `[${at.slice(0, 10)}] DECISION: ${decision} | REASONING: ${reasoning} | CONTEXT: see devlog/${path.basename(this.getDevlog(ctx)!.file)}${input.supersedes ? ` | SUPERSEDES: #${input.supersedes}` : ''}`
    const seq = this.db.tx(() => {
      const r = this.db.run('INSERT INTO decisions(at, decision, reasoning, context_slug, supersedes, line) VALUES(?,?,?,?,?,?)', at, decision, reasoning, ctx, input.supersedes ?? null, line)
      this.log('decision/add', { seq: Number(r.lastInsertRowid), line }, input.session)
      this.renderDecisions()
      return Number(r.lastInsertRowid)
    })
    return this.db.get<DecisionRow>('SELECT * FROM decisions WHERE seq = ?', seq)!
  }
  private renderDecisions(): void {
    const rows = this.db.all<DecisionRow>('SELECT * FROM decisions ORDER BY seq')
    const superseded = new Set(rows.map(r => r.supersedes).filter((x): x is number => x !== null))
    this.docs.write('decisions.md', ['# Decisions log', '', '由 dsh-master 插件生成，只追加；被推翻的决策不改，新行用 SUPERSEDES 指向它。', '',
      ...rows.map(r => `${r.seq}. ${r.line}${superseded.has(r.seq) ? '（已被推翻）' : ''}`)].join('\n') + '\n', 'decisions')
  }

  // ---------------- 记忆 ----------------
  getMemory(name: string): MemoryRow | undefined { return this.db.get<MemoryRow>('SELECT * FROM memories WHERE name = ?', name) }
  listMemories(): MemoryRow[] { return this.db.all<MemoryRow>('SELECT * FROM memories ORDER BY updated_at DESC, name') }

  memoryWrite(input: { name: string; type: MemoryType; description: string; body: string; session?: string }, ownTx = true): { name: string; file: string; created: boolean } {
    const name = (input.name ?? '').trim()
    if (!MEM_NAME.test(name)) throw new MemoryInputError('name 用小写英文/数字和连字符，例如 feedback-no-guess-time')
    if (!MEMORY_TYPES.includes(input.type)) throw new MemoryInputError(`type 只能是：${MEMORY_TYPES.join(' / ')}`)
    const description = (input.description ?? '').trim()
    if (!description || description.length > 200 || description.includes('\n')) throw new MemoryInputError('description 一行（1–200 字），用来决定回忆时相不相关')
    const body = (input.body ?? '').trim()
    if (!body) throw new MemoryInputError('body 不能为空')
    if ((input.type === 'feedback' || input.type === 'project') && !/\*\*Why:\*\*/.test(body)) throw new MemoryInputError('feedback / project 记忆要写 **Why:** 和 **How to apply:**')
    const links = [...new Set([...body.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]!.trim()))]
    const file = `memory/${name}.md`
    const at = bjtIso(this.clock())
    const run = () => {
      const old = this.getMemory(name)
      this.docs.write(file, ['---', `name: ${name}`, `description: ${description}`, 'metadata:', `  type: ${input.type}`, '---', '', body, ''].join('\n'), 'memory')
      if (old) this.db.run('UPDATE memories SET type = ?, description = ?, links = ?, updated_at = ?, versions = versions + 1 WHERE name = ?', input.type, description, JSON.stringify(links), at, name)
      else this.db.run('INSERT INTO memories(name, type, description, file, links, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', name, input.type, description, file, JSON.stringify(links), at, at)
      this.log(old ? 'memory/update' : 'memory/add', { name, type: input.type }, input.session)
      this.renderMemoryIndex()
      return { name, file, created: !old }
    }
    return ownTx ? this.db.tx(run) : run()
  }
  private renderMemoryIndex(): void {
    this.docs.write('memory/MEMORY.md', ['# Memory Index', '', ...this.listMemories().map(m => `- [${m.name}](${path.basename(m.file)}) — ${m.type} · ${m.description}`)].join('\n') + '\n', 'index')
  }
  memoryIndexText(max = 40): string {
    return this.listMemories().slice(0, max).map(m => `- ${m.name}（${m.type}）— ${m.description}`).join('\n')
  }

  // ---------------- 回忆 ----------------
  /** 只匹配 tag 段（整行 grep 误报随索引增长暴涨）；files 按路径重合匹配。 */
  recall(q: { term?: string; files?: string[]; session?: string }): { devlog: string[]; decisions: string[]; memories: string[] } {
    const term = (q.term ?? '').trim().toLowerCase(); const files = (q.files ?? []).map(String)
    if (!term && !files.length) throw new MemoryInputError('term 和 files 至少给一个')
    const rows = this.listDevlog().filter(r =>
      (term && J<string[]>(r.tags).some(t => t.toLowerCase().includes(term))) ||
      (files.length && files.some(f => J<string[]>(r.files_touched).some(g => samePath(f, g)))))
    const slugs = new Set(rows.map(r => r.slug))
    const decisions = this.db.all<DecisionRow>('SELECT * FROM decisions ORDER BY seq').filter(d => slugs.has(d.context_slug) || (term && (d.decision + d.reasoning).toLowerCase().includes(term)))
    const memories = this.listMemories().filter(m => J<string[]>(m.links).some(l => slugs.has(l)) || (term && (m.name + m.description).toLowerCase().includes(term)))
    this.log('recall', { term, files, hits: rows.length }, q.session)
    return { devlog: rows.map(r => `${this.indexLine(r)}  （${r.file}）`), decisions: decisions.map(d => `#${d.seq} ${d.line}`), memories: memories.map(m => `${m.name}（${m.type}）— ${m.description}  （${m.file}）`) }
  }
  memorySearch(term: string): string[] {
    const t = (term ?? '').trim().toLowerCase()
    if (!t) throw new MemoryInputError('term 不能为空')
    return this.listMemories().filter(m => (m.name + m.description + (this.docs.read(m.file) ?? '')).toLowerCase().includes(t)).map(m => `${m.name}（${m.type}）— ${m.description}  （${m.file}）`)
  }

  private prior(r: DevlogRow, reason: string): Prior {
    const decisions = this.db.all<DecisionRow>('SELECT * FROM decisions WHERE context_slug = ? ORDER BY seq', r.slug).map(d => d.line)
    const memories = this.listMemories().filter(m => J<string[]>(m.links).includes(r.slug) || J<string[]>(r.memories).includes(m.name)).map(m => `${m.name} — ${m.description}`)
    return { slug: r.slug, line: this.indexLine(r), reason, decisions, memories }
  }
  /** 自动推送 ①：要改的文件以前碰过吗。 */
  relatedForFiles(paths: string[], max = 5): Prior[] {
    const out: Prior[] = []
    for (const r of this.listDevlog()) {
      const hit = paths.find(p => J<string[]>(r.files_touched).some(g => samePath(p, g)))
      if (hit) out.push(this.prior(r, `改的是 ${hit}`))
      if (out.length >= max) break
    }
    return out
  }
  /** 自动推送 ②：对话里出现的 tag / 任务 ID / 文件名。 */
  /** 标签权重（IDF + 停用表），按话题推送和跨任务关联共用。sessions：会话名，当标签时不算主题。 */
  tagWeights(sessions: ReadonlySet<string> = new Set()): TagWeights {
    return tagWeights(this.listDevlog().map(r => ({ tags: J<string[]>(r.tags), at_ms: r.at_ms })), this.clock(), sessions)
  }

  /** 跨任务关联候选（巡检用）。 */
  linkCandidates(opts: { eligible: (task: string) => boolean; linked?: ReadonlySet<string>; sessions?: ReadonlySet<string> }): LinkCandidate[] {
    const rows = this.listDevlog()
    return linkCandidates(rows.map(r => ({ slug: r.slug, task: r.task, tags: J<string[]>(r.tags), at_ms: r.at_ms })), this.tagWeights(opts.sessions), opts)
  }
  /** 某个任务最近一条 devlog 的时间（没有返回 0）。 */
  lastEntryMs(task: string): number {
    let m = 0
    for (const r of this.listDevlog()) if (entryTasks({ slug: r.slug, task: r.task, tags: J<string[]>(r.tags), at_ms: r.at_ms }).includes(task.toUpperCase())) m = Math.max(m, r.at_ms)
    return m
  }

  /**
   * 按话题推送（G5-E ⑥ 降噪）：文字里出现了某条 devlog 的「具体标签」，按 IDF 加总打分，过门槛才推；
   * 泛用标签（停用表、太常见的、纯数字、任务号、会话名）不计分。文件名、任务号命中照旧直接算（各 3 分）。
   */
  relatedForText(text: string, max = 5, sessions: ReadonlySet<string> = new Set()): Prior[] {
    const t = (text ?? '').toLowerCase()
    if (!t.trim()) return []
    const w = this.tagWeights(sessions)
    const scored: Array<{ r: DevlogRow; score: number; why: string }> = []
    for (const r of this.listDevlog()) {
      const hits = [...new Set(J<string[]>(r.tags).map(x => x.toLowerCase()))].filter(x => w.isTopic(x) && mentionsWord(t, x))
      let score = hits.reduce((a, x) => a + (w.idf.get(x) ?? 0), 0)
      const file = J<string[]>(r.files_touched).map(f => path.basename(f)).find(b => b.length >= 5 && mentionsWord(t, b.toLowerCase()))
      const task = r.task && mentionsWord(t, r.task.toLowerCase()) ? r.task : undefined
      if (file) score += 3
      if (task) score += 3
      if (score <= 0) continue
      const why = [hits.length ? `提到了 tag${hits.map(x => `「${x}」`).join('')}` : '', file ? `提到了文件 ${file}` : '', task ? `提到了任务 ${task}` : ''].filter(Boolean).join('、')
      scored.push({ r, score, why: `${why}（权重 ${score.toFixed(1)}）` })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, max).map(x => this.prior(x.r, x.why))
  }
  formatPriors(priors: Prior[]): string {
    return priors.map(p => [`- ${p.line}（${p.reason}）`, ...p.decisions.map(d => `  - 决策：${d}`), ...p.memories.map(m => `  - 记忆：${m}`)].join('\n')).join('\n')
  }

  /** 系统提示常驻小摘要：最近 N 条 + 高频 tag + 记忆索引（上限约 6KB）。 */
  residentSummary(opts: { recent?: number; tags?: number; maxChars?: number } = {}): string {
    const rows = this.listDevlog()
    if (!rows.length && !this.listMemories().length) return ''
    const freq = new Map<string, number>()
    for (const r of this.db.all<{ tag: string; c: number }>('SELECT tag, count(*) AS c FROM devlog_tags GROUP BY tag ORDER BY c DESC, tag LIMIT ?', opts.tags ?? 15)) freq.set(r.tag, r.c)
    const parts = [
      '## 记忆层摘要（dsh-master 自动注入；完整内容用 devlog_recall / memory_search 查）',
      rows.length ? `最近的 devlog：\n${rows.slice(0, opts.recent ?? 15).map(r => `- [${bjtStamp(r.at_ms)}] ${r.slug} — ${r.hook.slice(0, 80)}`).join('\n')}` : '',
      freq.size ? `高频 tag：${[...freq].map(([t, c]) => `${t}(${c})`).join('、')}` : '',
      this.listMemories().length ? `记忆索引：\n${this.memoryIndexText()}` : '',
    ].filter(Boolean)
    const text = parts.join('\n\n')
    const max = opts.maxChars ?? 6000
    return text.length > max ? text.slice(0, max - 20) + '\n…（截断）' : text
  }

  // ---------------- 核对 ----------------
  check(): { problems: string[]; drift: Drift[] } {
    const problems: string[] = []
    const fsFiles = new Set<string>()
    const dir = this.docs.abs('devlog')
    try { for (const f of fs.readdirSync(dir)) if (/^\d{4}-\d\d-\d\d-\d{4}-.+\.md$/.test(f)) fsFiles.add(`devlog/${f}`) } catch { /* 目录还没有 */ }
    const rows = this.listDevlog()
    for (const r of rows) if (!fsFiles.has(r.file)) problems.push(`索引有、文件没有：${r.file}`)
    const known = new Set(rows.map(r => r.file))
    for (const f of fsFiles) if (!known.has(f)) problems.push(`文件有、索引没有：${f}`)
    for (const m of this.listMemories()) if (this.docs.read(m.file) === undefined) problems.push(`记忆索引有、文件没有：${m.file}`)
    return { problems, drift: this.docs.verify() }
  }
}
