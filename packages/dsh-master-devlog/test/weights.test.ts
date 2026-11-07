import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { MemoryLayer, tagWeights, topicTag, STOP_TAGS } from '../src/index.ts'

// 3090 实例上 L1103-6 之前的 11 条真实 devlog（只抄 slug / 标签，2026-11-04 只读取出）
const REAL: Array<[string, string[]]> = [
  ['hello-py-add-function', ['hello.py', 'python', 'exec-trial', '轻任务', 'add函数']],
  ['hello-py-argparse-name', ['hello.py', 'python', 'argparse', 'exec-trial', 'T101', 'cli参数']],
  ['trial-first-run-l1103-t101', ['exec-trial', 'master-dispatch', 'hello.py', 'argparse', '试用']],
  ['snake-game-single-file', ['snake', 'index.html', 'canvas', '单文件', 'L1103-2']],
  ['snake-game-l1103-2', ['snake', 'exec-snake', 'canvas', '单文件', 'l1103-2']],
  ['snake-game-enlarge-responsive', ['snake', '响应式', 'dpr', 'canvas', 'L1103-3']],
  ['hello-world-py-t102', ['hello_world.py', 'python', 'T102', 'exec-trial', 'hello-world', '新建文件']],
  ['t102-hello-world-testing', ['t102', 'hello_world.py', 'exec-trial', 'testing', '重任务']],
  ['snake-hud-near-fullscreen', ['snake', 'hud', 'fullscreen', 'canvas', 'L1103-4']],
  ['snake-wide-grid-32x20', ['snake', '32x20', 'widescreen', 'canvas', 'L1103-5']],
  ['snake-wide-1440-l1103-5', ['snake', 'l1103-5', '32x20', '1440', 'canvas']],
]
function realLayer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-w-'))
  let now = Date.UTC(2026, 10, 3, 10, 0, 0)
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock: () => now })
  // task 字段同 3090 上的真实值（执行会话写的带任务号，总管写的为空、靠任务号标签归）
  const TASK: Record<string, string> = { 'hello-py-add-function': 'L1103-1', 'hello-py-argparse-name': 'T101', 'snake-game-single-file': 'L1103-2', 'snake-game-enlarge-responsive': 'L1103-3', 'hello-world-py-t102': 'T102', 'snake-hud-near-fullscreen': 'L1103-4', 'snake-wide-grid-32x20': 'L1103-5' }
  for (const [slug, tags] of REAL) { now += 60_000; mem.devlogAdd({ slug, hook: slug, tags, task: TASK[slug], files_touched: [`/w/zz-${slug.length}-${now}.dat`], depth: '琐碎', no_related_reason: '测试数据', sections: { 改了什么: 'x' } }) }
  return mem
}
// L1103-6 派活正文与回报里那几句（真实任务里按话题推送了贪吃蛇、hello.py，理由是「单文件」「重任务」「1440」）
const L6 = '派活：L1103-6（轻任务）交付手册浓缩成一页 HTML 速查卡。单文件 HTML：内联 CSS，手机上能看，窄屏（390px）单列可读；这是重任务的收尾文档。截了 390 和 1440 两张图。'

describe('G5-E ⑥ 标签权重', () => {
  it('停用表 / 纯数字 / 任务号 / 会话名不算主题；具体标签算', () => {
    for (const t of ['单文件', '重任务', '轻任务', 'html', '响应式', '1440', 'l1103-5', 'T102', 't102-g2', 'exec-trial', 'master-dispatch', 'python', 'Python', 'bash', 'sqlite']) expect(topicTag(t), t).toBe(false)
    expect(topicTag('master', new Set(['master']))).toBe(false)
    for (const t of ['snake', 'argparse', 'canvas', 'hello.py', '速查卡']) expect(topicTag(t), t).toBe(true)
    expect(STOP_TAGS.has('单文件')).toBe(true)
  })
  it('IDF：越少见权重越高；条目 ≥20 时超过 15% 的标签被去掉', () => {
    const docs = Array.from({ length: 40 }, (_, i) => ({ tags: i < 10 ? ['common', `x${i}`] : [`x${i}`, i === 11 ? 'rare' : 'zz'], at_ms: 1000 + i }))
    const w = tagWeights(docs, 2000)
    expect(w.isTopic('common')).toBe(false) // 10/40 = 25% > 15%
    expect(w.isTopic('rare')).toBe(true)
    // 少见的（rare 只 1 条）比常见的（zz 有 29 条，n<20 时也参与）权重高：用一组不按频率筛的小样本比
    const small = tagWeights([{ tags: ['rare', 'often'], at_ms: 1 }, { tags: ['often'], at_ms: 2 }, { tags: ['often'], at_ms: 3 }], 10)
    expect(small.idf.get('rare')!).toBeGreaterThan(small.idf.get('often')!)
    expect(w.isTopic('zz')).toBe(false) // 29/40
    // 30 天以外的条目不参与频率统计（但条目太少时整体回落到全部）
    const old = docs.map(d => ({ ...d, at_ms: d.at_ms - 40 * 24 * 3600_000 }))
    expect(tagWeights([...old, ...docs.slice(0, 25).map(d => ({ ...d, at_ms: 5000 }))], 6000).n).toBe(25)
  })
  it('真实回放：L1103-6 的话不再推贪吃蛇 / hello.py（泛标签不计分）', () => {
    expect(realLayer().relatedForText(L6)).toEqual([])
  })
  it('对照：真提到具体标签照样推，按权重排序、写出命中的标签', () => {
    const mem = realLayer()
    const r = mem.relatedForText('把 argparse 的参数改一下')
    expect(r.map(p => p.slug).sort()).toEqual(['hello-py-argparse-name', 'trial-first-run-l1103-t101'])
    expect(r[0]!.reason).toMatch(/「argparse」（权重 \d/)
    const r2 = mem.relatedForText('snake 的 hud 太挤了')
    expect(r2[0]!.slug).toBe('snake-hud-near-fullscreen') // snake + hud 两个都中，排第一
    expect(r2.length).toBeGreaterThan(1)
  })
  it('会话名当标签不计分', () => {
    const mem = realLayer()
    // exec-trial 是 4 条真实条目的标签（会话名），以前一提会话名就推这 4 条
    expect(mem.relatedForText('exec-trial 已经回报了')).toEqual([])
    // 用户自己起的会话名（不带 exec- 前缀）靠传入的会话表排除
    expect(mem.relatedForText('hud 那个会话回报了', 5, new Set(['hud']))).toEqual([])
    expect(mem.relatedForText('hud 那个会话回报了').map(p => p.slug)).toEqual(['snake-hud-near-fullscreen'])
  })
})

describe('G5-E ⑥ 跨任务关联候选', () => {
  it('真实数据：贪吃蛇几个轻任务互相关联、hello.py 两个任务关联；贪吃蛇和 hello.py 不关联', () => {
    const mem = realLayer()
    const c = mem.linkCandidates({ eligible: () => true })
    const pairs = c.map(x => `${x.a}|${x.b}`)
    expect(pairs).toContain('L1103-4|L1103-5')
    expect(pairs).toContain('L1103-1|T101')
    expect(pairs.filter(p => /L1103-[2-5]/.test(p) && /T10[12]|L1103-1/.test(p))).toEqual([])
    // 共同点只有具体标签：单文件 / 1440 / exec-trial / 重任务 这些泛标签不出现
    expect(c.find(x => x.a === 'L1103-4' && x.b === 'L1103-5')!.shared).toEqual(['canvas', 'snake'])
    expect(c.find(x => x.a === 'L1103-1' && x.b === 'T101')!.shared).toEqual(['hello.py'])
    // G5-F ⑤：只共享 python（语言名）不算关联 —— 3090 11:00 巡检报过 T101 ↔ T102、L1103-1 ↔ T102
    expect(pairs.filter(p => p.includes('T102'))).toEqual([])
    expect(c.flatMap(x => x.shared).filter(x => ['单文件', '1440', 'exec-trial', '重任务', '轻任务', 'master-dispatch'].includes(x))).toEqual([])
  })
  it('已确认的对不再报；不参与的任务不报', () => {
    const mem = realLayer()
    expect(mem.linkCandidates({ eligible: () => true, linked: new Set(['L1103-4|L1103-5']) }).some(x => x.a === 'L1103-4' && x.b === 'L1103-5')).toBe(false)
    expect(mem.linkCandidates({ eligible: t => t !== 'L1103-5' }).some(x => x.b === 'L1103-5' || x.a === 'L1103-5')).toBe(false)
  })
  it('前缀近似算半分，单个词的前缀不算', async () => {
    const { prefixNear, entryTasks } = await import('../src/index.ts')
    expect(prefixNear('reserved-inventory', 'reserved-inventory-dup')).toBe(true)
    expect(prefixNear('pco', 'pco-flash-v3')).toBe(false)
    expect(entryTasks({ slug: 's', task: null, tags: ['t102-g2', 'l1103-5', 'q1104-1', 'x'], at_ms: 0 })).toEqual(['T102', 'L1103-5'])
  })
})

// G5-F ⑤ 回放：3090 上 E1（2026-11-05 10:42:53）那一步。当时已有的 14 条真实条目（只读取出 slug / task / 标签）+ E1 回报原文。
// 旧版（G5-E）因为回报里一句「Python 独立重算」推了 hello.py 三条（python 权重 1.6）。
const E1_ENTRIES: Array<[string, string, string[]]> = [
  ["hello-py-add-function", "L1103-1", ["hello.py","python","exec-trial","轻任务","add函数"]],
  ["hello-py-argparse-name", "T101", ["hello.py","python","argparse","exec-trial","T101","cli参数"]],
  ["trial-first-run-l1103-t101", "", ["exec-trial","master-dispatch","hello.py","argparse","试用"]],
  ["snake-game-single-file", "L1103-2", ["snake","index.html","canvas","单文件","L1103-2"]],
  ["snake-game-l1103-2", "", ["snake","exec-snake","canvas","单文件","l1103-2"]],
  ["snake-game-enlarge-responsive", "L1103-3", ["snake","响应式","dpr","canvas","L1103-3"]],
  ["hello-world-py-t102", "T102", ["hello_world.py","python","T102","exec-trial","hello-world","新建文件"]],
  ["t102-hello-world-testing", "", ["t102","hello_world.py","exec-trial","testing","重任务"]],
  ["snake-hud-near-fullscreen", "L1103-4", ["snake","hud","fullscreen","canvas","L1103-4"]],
  ["snake-wide-grid-32x20", "L1103-5", ["snake","32x20","widescreen","canvas","L1103-5"]],
  ["snake-wide-1440-l1103-5", "", ["snake","l1103-5","32x20","1440","canvas"]],
  ["quickref-card-html-l1103-6", "L1103-6", ["速查卡","html","交付手册","l1103-6","单文件","响应式","headless-chrome"]],
  ["quickref-l1103-6-verified", "", ["速查卡","docs","exec-docs","l1103-6","单文件"]],
  ["docs-md-stats-l1103-7", "L1103-7", ["docs统计","markdown","wc-l","l1103-7","只读","e2e-1105"]],
]

function e1Layer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-e1-'))
  let now = Date.UTC(2026, 10, 3, 12, 0, 0)
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock: () => now })
  for (const [slug, task, tags] of E1_ENTRIES) { now += 60_000; mem.devlogAdd({ slug, hook: slug, tags, task: task || undefined, files_touched: [`/w/zz-${slug}.dat`], depth: '琐碎', no_related_reason: '回放数据', sections: { 改了什么: 'x' } }) }
  return mem
}
describe('G5-F ⑤ 话题推送泛标签噪音（3090 真实回放）', () => {
  const E1 = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/e1-report-l1103-7.txt'), 'utf8')
  const sessions = new Set(['master', 'exec-trial', 'exec-snake', 'exec-docs'])
  it('E1 回报不再推 hello.py / hello_world.py 的旧条目', () => {
    expect(E1).toContain('Python 独立重算')
    const slugs = e1Layer().relatedForText(E1, 5, sessions).map(p => p.slug)
    expect(slugs.filter(x => /^hello|t102/.test(x))).toEqual([])
    // 同一个任务（L1103-7）的条目照推：回报里点了任务号和 e2e-1105 目录
    expect(slugs).toContain('docs-md-stats-l1103-7')
  })
  it('对照：当天有用的推送照样推（速查卡、snake）', () => {
    const mem = e1Layer()
    expect(mem.relatedForText('速查卡里加一节自检命令', 5, sessions).map(p => p.slug).sort()).toEqual(['quickref-card-html-l1103-6', 'quickref-l1103-6-verified'])
    expect(mem.relatedForText('snake 太慢了', 5, sessions).length).toBeGreaterThan(0)
    expect(mem.relatedForText('hello.py 再加一个参数', 5, sessions).map(p => p.slug)).toEqual(expect.arrayContaining(['hello-py-add-function', 'hello-py-argparse-name']))
  })
})

describe('G5-F 补：任务号 / 标签 / 文件名按词边界认，不按子串', () => {
  const sessions = new Set(['master', 'exec-trial', 'exec-snake', 'exec-docs'])
  it('3090 复测：派 L1103-10 不算提到 L1103-1（不再推 hello-py-add-function）', () => {
    const mem = e1Layer()
    const push = mem.relatedForText('派活：L1103-10（轻任务）把 docs 下的 png 列个清单', 5, sessions)
    expect(push.map(p => p.slug)).not.toContain('hello-py-add-function')
    expect(push.flatMap(p => p.reason.match(/提到了任务 \S+/g) ?? [])).toEqual([])
    // 对照：真提到 L1103-1 照推（后面跟中文、标点、行尾都算）
    for (const t of ['L1103-1 再改一下', '回到 L1103-1。', '看 L1103-1'])
      expect(mem.relatedForText(t, 5, sessions).map(p => p.slug), t).toContain('hello-py-add-function')
  })
  it('标签 / 文件名也按词边界：hudson 不算提到 hud，xzz-…dat 不算提到 zz-…dat', () => {
    const mem = e1Layer()
    expect(mem.relatedForText('hudson 那边回信了', 5, sessions).map(p => p.slug)).not.toContain('snake-hud-near-fullscreen')
    expect(mem.relatedForText('hud 太挤', 5, sessions).map(p => p.slug)).toContain('snake-hud-near-fullscreen')
    expect(mem.relatedForText('看 xzz-hello-py-add-function.dat', 5, sessions).map(p => p.slug)).not.toContain('hello-py-add-function')
    expect(mem.relatedForText('看 /w/zz-hello-py-add-function.dat', 5, sessions).map(p => p.slug)).toContain('hello-py-add-function')
  })
  it('mentionsWord：字母数字首尾要有边界，中文照旧子串', async () => {
    const { mentionsWord } = await import('../src/index.ts')
    expect(mentionsWord('派 l1103-10 了', 'l1103-1')).toBe(false)
    expect(mentionsWord('派 l1103-1 了', 'l1103-1')).toBe(true)
    expect(mentionsWord('看 l1103-1，再看', 'l1103-1')).toBe(true)
    expect(mentionsWord('statsd 挂了', 'stats')).toBe(false)
    expect(mentionsWord('stats 表', 'stats')).toBe(true)
    expect(mentionsWord('改 myhello.py', 'hello.py')).toBe(false)
    expect(mentionsWord('改 /w/hello.py 了', 'hello.py')).toBe(true)
    expect(mentionsWord('速查卡里加一节', '速查卡')).toBe(true)
    expect(mentionsWord('snake-game-l1103-2 写好了', 'snake-game', /[a-z0-9-]/)).toBe(false)
    expect(mentionsWord('snake-game 写好了', 'snake-game', /[a-z0-9-]/)).toBe(true)
    expect(mentionsWord('', 'x')).toBe(false)
  })
})
