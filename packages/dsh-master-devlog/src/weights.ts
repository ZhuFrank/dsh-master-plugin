/**
 * G5-E ⑥ 标签权重（照 Claude 侧 manager/links.py 的做法）：
 *   - 停用表：说「怎么做 / 谁做 / 什么形式」而不是「做什么」的泛用标签（流程、验收手法、交付形式、会话名、纯数字）；
 *   - 任务号标签（t102、l1103-6）不算主题（它们用来把条目归到任务）；
 *   - 最近 30 天条目 ≥ 20 条时，超过 15% 条目都带的标签也去掉；
 *   - 剩下的按 IDF = ln((N + 1) / df) 加权（+1 平滑：只有一两条时也能区分「独有」和「人人都有」）。
 * 按话题推送和跨任务关联共用这一套。
 */
export const STOP_TAGS: ReadonlySet<string> = new Set([
  // 流程 / 总管机制
  'devlog', '重任务', '轻任务', '派活', '回报', '验收', '验收通过', '打回', '试用', 'master-dispatch', '总管', '执行会话', '手册', '任务书', '修复', 'bug', 'fix',
  // 验证手法
  '测试', 'testing', 'test', '单测', '自测', '端到端', 'e2e', '反向验证', '截图', 'screenshot', '无头chrome', 'headless-chrome', 'cdp', '沙盒', 'sandbox', 'tdd',
  // 交付形式 / 排版
  '单文件', 'html', 'markdown', 'md', '文档', 'docs', '交付', '响应式', '手机', 'mobile', '新建文件', '部署', 'deploy',
  // G5-F ⑤ 语言 / 运行时 / 常用工具：说的是「用什么做的」，不是「做的什么」（同 links.py「工具本身不是主题」）。
  // 3090 实测：E1 回报里一句「Python 独立重算」靠 python（权重 1.6）推了 hello.py 三条；巡检报 L1103-1 ↔ T102 只因共享 python。
  // 按分数下限挡不住：同期 8 次有用的单标签推送（hello.py / snake 等）得分 0.41–1.15，比 python 还低。
  'python', 'python3', 'py', 'node', 'nodejs', 'javascript', 'js', 'typescript', 'ts', 'bash', 'shell', 'zsh', 'sh',
  'css', 'json', 'yaml', 'toml', 'sql', 'sqlite', 'git', 'npm', 'pnpm', 'vitest', 'pytest', 'ffmpeg', 'curl', 'jq', 'awk', 'sed', 'grep', 'find', 'wc',
  'cli', 'api', 'script', '脚本', '命令行',
])
export const DF_MAX = 0.15
export const DF_WINDOW_MS = 30 * 24 * 3600_000
export const DF_MIN_DOCS = 20
const TASKISH = /^(?:t\d{3,}|l\d{4}-\d+|q\d{4}-\d+)(?:-|$)/i
export interface TagDoc { tags: string[]; at_ms: number }
export interface TagWeights { n: number; idf: Map<string, number>; isTopic(tag: string): boolean }

/** 一个标签能不能当主题：不在停用表、不是纯数字 / 任务号、不是会话名（exec-xxx / master）、长度够（中文 ≥2、其他 ≥3）。 */
export function topicTag(tag: string, sessions: ReadonlySet<string> = new Set()): boolean {
  const t = tag.toLowerCase()
  if (STOP_TAGS.has(t) || /^\d+$/.test(t) || TASKISH.test(t) || sessions.has(t) || /^exec-/.test(t)) return false
  return /[一-鿿]/.test(t) ? t.length >= 2 : t.length >= 3
}

export function tagWeights(docs: TagDoc[], now: number, sessions: ReadonlySet<string> = new Set()): TagWeights {
  const recent = docs.filter(d => now - d.at_ms <= DF_WINDOW_MS)
  const pool = recent.length >= DF_MIN_DOCS ? recent : docs
  const n = pool.length
  const df = new Map<string, number>()
  for (const d of pool) for (const t of new Set(d.tags.map(x => x.toLowerCase()))) if (topicTag(t, sessions)) df.set(t, (df.get(t) ?? 0) + 1)
  const idf = new Map<string, number>()
  for (const [t, c] of df) {
    if (n >= DF_MIN_DOCS && c / n > DF_MAX) continue // 太常见
    idf.set(t, Math.log((n + 1) / c))
  }
  // 不设分数门槛（同 links.py）：降噪靠去掉泛用标签，剩下的具体标签中一个就算，按得分排序取前几条
  return { n, idf, isTopic: (t: string) => idf.has(t.toLowerCase()) }
}

// ───────── 跨任务关联（照 links.py：标签段 → 任务；共享具体标签 IDF 加总；前缀近似算半分） ─────────
export const PARTIAL_WEIGHT = 0.5
const TASK_TAG = /^(t\d{3,}|l\d{4}-\d+)(?:-(?:g|step)\d+[a-z]?(?:-[a-z0-9._+-]+)?)?$/i
export interface LinkEntry { slug: string; task: string | null; tags: string[]; at_ms: number }
export interface LinkCandidate { a: string; b: string; score: number; shared: string[]; partial: Array<[string, string]>; slugs: Record<string, string[]> }

/** 一条 devlog 归到哪些任务：task 字段 + 任务号标签（l1103-5、t102-g2 → L1103-5、T102）。 */
export function entryTasks(e: LinkEntry): string[] {
  const out = new Set<string>()
  if (e.task) out.add(e.task.toUpperCase())
  for (const t of e.tags) { const m = TASK_TAG.exec(t.trim()); if (m) out.add(m[1]!.toUpperCase()) }
  return [...out]
}

/** 前缀近似：短的至少两段（含「-」），长的 = 短的 + 「-…」。单个词的前缀不算（links.py 2026-11-04 实测多半是同一个大项目下不相干的事）。 */
export function prefixNear(x: string, y: string): boolean {
  const [s, l] = x.length <= y.length ? [x, y] : [y, x]
  return s !== l && s.includes('-') && l.startsWith(s + '-')
}

/**
 * 任务对的关联候选：两边条目的具体标签集合，共享的按 IDF 加总，前缀近似算半分。
 * eligible：哪些任务参与（调用方按任务状态定：没结的，或最近 7 天还有条目的已结任务）；linked：已经确认过的对（"A|B"，字母序）。
 */
export function linkCandidates(entries: LinkEntry[], w: TagWeights, opts: { eligible: (task: string) => boolean; linked?: ReadonlySet<string>; minScore?: number }): LinkCandidate[] {
  const tags = new Map<string, Set<string>>(); const slugs = new Map<string, string[]>()
  for (const e of entries) for (const t of entryTasks(e)) {
    if (!opts.eligible(t)) continue
    const set = tags.get(t) ?? new Set<string>(); for (const x of e.tags) { const l = x.toLowerCase(); if (w.isTopic(l)) set.add(l) }
    tags.set(t, set); slugs.set(t, [...(slugs.get(t) ?? []), e.slug])
  }
  const ids = [...tags.keys()].sort(); const out: LinkCandidate[] = []
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i]!, b = ids[j]!
    if (opts.linked?.has(`${a}|${b}`)) continue
    const A = tags.get(a)!, B = tags.get(b)!
    const shared = [...A].filter(x => B.has(x)).sort()
    const partial: Array<[string, string]> = []
    for (const x of A) if (!B.has(x)) for (const y of B) if (!A.has(y) && prefixNear(x, y)) partial.push([x, y])
    const score = shared.reduce((s, x) => s + (w.idf.get(x) ?? 0), 0) + partial.reduce((s, [x, y]) => s + PARTIAL_WEIGHT * Math.min(w.idf.get(x) ?? 0, w.idf.get(y) ?? 0), 0)
    if (score > 0 && score >= (opts.minScore ?? 0)) out.push({ a, b, score: Math.round(score * 100) / 100, shared, partial, slugs: { [a]: slugs.get(a)!, [b]: slugs.get(b)! } })
  }
  return out.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a))
}

/**
 * G5-F 补：文字里有没有「提到」这个词（任务号 / 标签 / 文件名 / slug），按词边界，不是子串。
 * 词的首尾是字母数字时，紧挨着的那个字符不能也是字母数字（wordChars 可以再加，比如 slug 加「-」）：
 * 「l1103-10」不算提到「l1103-1」，「statsd」不算提到「stats」。中文没有词边界，中文首尾照旧按子串。
 * 两边都要先转小写。
 */
export function mentionsWord(text: string, word: string, wordChars = /[a-z0-9]/): boolean {
  if (!word) return false
  const edge = /[a-z0-9]/
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    const before = text[i - 1] ?? '', after = text[i + word.length] ?? ''
    const okBefore = !edge.test(word[0]!) || !before || !wordChars.test(before)
    const okAfter = !edge.test(word[word.length - 1]!) || !after || !wordChars.test(after)
    if (okBefore && okAfter) return true
  }
  return false
}
