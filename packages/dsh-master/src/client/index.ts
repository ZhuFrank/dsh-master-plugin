/**
 * dsh-master 看板（浏览器端，G4c）：原生对话为主，看板退成右侧栏。
 * - 右侧栏标签「总管看板」：任务列表 / 任务时间线 / 会话；没有聊天输入框（说话一律回原生对话）。
 * - 只靠侧栏就能读完一件任务：时间线每条可就地展开全文（回报、验收、等你定、转交的消息、归到它的对话轮次）；
 *   顶部固定「产物」列表（宿主预览）和「打开执行会话 ↗」。
 * - @ 菜单多一组「任务」；发出的 @任务 在历史消息里显示成小标签；每轮末尾显示「归到 T005 · 依据」。
 * - 宿主提供 React 和 primitives（MarkdownText）；时间全用服务端给的北京时间。
 */
import * as React from 'react'
import { findPaths } from '../paths.ts'
import { NEEDS_YOU, needsYou, stateLabel, listGroups } from '../board-groups.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
const h = React.createElement
declare const require: (id: string) => any
type Ctx = any

export { findPaths }
export const BOARD_KIND = 'dsh-master-board'
const TAB_ID = 'dsh-master-board'
/** 旧单元的总管 ID；项目单元的总管从 state 里来（BoardCtx）。只在拿不到上下文时兜底。 */
const LEGACY_MASTER = 'master'
/** G6-3 看板上下文：当前会话、这个单元的总管、闸门 / Q 编号表。看板组件树里都用它，不再写死 master。 */
export interface BoardContext { sid?: string; master: string; project?: { id: string; root: string } | null; gateIndex: Record<string, any>; askIndex: Record<string, any>; readonly?: boolean }
const BoardCtx = React.createContext<BoardContext>({ master: LEGACY_MASTER, gateIndex: {}, askIndex: {} })
const useBoard = () => React.useContext(BoardCtx)
/** 看板接口都带上当前会话（服务端按它选单元：项目 / 旧单元）。 */
export const withSession = (url: string, sid?: string) => sid ? `${url}${url.includes('?') ? '&' : '?'}session=${encodeURIComponent(sid)}` : url

// ---------------- 数据 ----------------
const getJson = async (p: string) => { const r = await fetch(p, { credentials: 'same-origin', headers: { accept: 'application/json' } }); const v = await r.json(); if (!r.ok) throw new Error(v.error ?? `HTTP ${r.status}`); return v }
const postJson = async (p: string, body: unknown) => {
  const r = await fetch(p, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-master': '1' }, body: JSON.stringify(body) })
  const v = await r.json().catch(() => ({})); if (!r.ok) throw new Error(v.error ?? `HTTP ${r.status}`); return v
}

/** 'YYYY-MM-DD HHMM'（北京时间）→ 'MM-DD HH:MM'；和 today 同一天的只留 'HH:MM' */
export const showTime = (s?: string, today?: string) => {
  if (!s || !/^\d{4}-\d\d-\d\d \d{4}$/.test(s)) return s ?? ''
  const hm = `${s.slice(11, 13)}:${s.slice(13, 15)}`
  return today && s.slice(0, 10) === today.slice(0, 10) ? hm : `${s.slice(5, 10)} ${hm}`
}
const stateTone = (st: string) => st === '完成' ? 'ok' : st === '取消' ? 'mute' : ['受阻', '失败'].includes(st) ? 'bad' : NEEDS_YOU.has(st) ? 'wait' : 'run'
const who = (id: string, master: string) => id === master ? '总管' : id === 'user' ? '你' : id

// ---------------- 文件预览 ----------------
const enc = (seg: string) => encodeURIComponent(seg).replace(/%3A/gi, ':')
/** 照宿主 fileAddressFor：工作区内转相对路径；工作区外的绝对路径原样保留（含开头 /）。 */
export function fileAddress(sessionId: string, cwd: string | undefined, p: string): string {
  const root = (cwd ?? '').replace(/\/+$/, '')
  const rel = root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p
  return `dsh-resource://file/session/${enc(sessionId)}/${rel.split('/').map(enc).join('/')}`
}
/** 显示时去掉插件消息头（库里的原文不动）。 */
export function stripHeader(text: string): string {
  return text.replace(/^\[dsh-master 消息 ·[^\]\n]*\]（消息键 [^）\n]*）\s*/, '')
}

// ---------------- Markdown 预处理（G5-E）----------------
/** 按代码段切开：奇数段是代码（``` 围栏或 `行内`），预处理只动非代码段。 */
function splitCode(text: string): string[] { return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/) }
const mapProse = (text: string, f: (s: string) => string) => splitCode(text).map((seg, i) => (i % 2 ? seg : f(seg))).join('')
/**
 * 单星号：宿主 MarkdownText 把 `5*3*2` 渲染成「5 斜体3 2」（实测）。字母 / 数字中间的 * 先转义成 \*，
 * `*x*`（前后有空格或标点）照样是斜体；代码里的不动。
 */
export function escapeIntrawordStars(text: string): string {
  return mapProse(text, seg => seg.replace(/(?<=[0-9A-Za-z])\*(?=[0-9A-Za-z])/g, '\\*'))
}
/** 正文里的 #编号（属于当前时间线的）变成宿主能点的相对链接 dshm-item/编号；「等你定 #N」这类问题编号、代码里的不动。 */
const NO_RE = /(?<![\w#/&\[(])(?<!等你定\s?)#(\d{1,9})(?![\w-])/g
export function linkItemNos(text: string, nos: ReadonlySet<number>): string {
  return mapProse(text, seg => seg.replace(NO_RE, (m, d) => (nos.has(Number(d)) ? `[#${d}](dshm-item/${d})` : m)))
}
/** 一行摘要用：拆成文字片段和可点的编号片段。 */
export function inlineNoParts(text: string, nos: ReadonlySet<number>): Array<string | { no: number }> {
  const out: Array<string | { no: number }> = []; let last = 0
  for (const m of text.matchAll(NO_RE)) {
    const n = Number(m[1]); if (!nos.has(n)) continue
    if (m.index! > last) out.push(text.slice(last, m.index)); out.push({ no: n }); last = m.index! + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
/**
 * 宿主把 [文字](路径) 渲染成按钮，点了把原样路径交给 openFile（实测：相对、绝对、隐藏路径、../ 都会交过来）。
 * 这里决定能不能打开：只放行花名册会话工作目录和插件 docs 目录里面的文件；含 ..、含以 . 开头的段（相对根目录之后）、带协议的一律拒绝。
 * 相对路径按 base（消息作者的工作目录）解析。
 */
export function checkPath(p: string, roots: string[], base?: string): { ok: true; abs: string } | { ok: false; why: string } {
  const raw = p.trim()
  if (!raw) return { ok: false, why: '空路径' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { ok: false, why: '不是文件路径' }
  if (raw.split('/').some(x => x === '..')) return { ok: false, why: '含 ..' }
  const abs = raw.startsWith('/') ? raw : base ? `${base.replace(/\/+$/, '')}/${raw.replace(/^\.\//, '')}` : ''
  if (!abs) return { ok: false, why: '相对路径找不到基准目录' }
  const clean = abs.replace(/\/\.\//g, '/').replace(/\/{2,}/g, '/')
  const root = roots.map(r => r.replace(/\/+$/, '')).filter(Boolean).sort((a, b) => b.length - a.length).find(r => clean.startsWith(r + '/'))
  if (!root) return { ok: false, why: '不在允许的目录里（会话工作目录或插件 docs 目录）' }
  if (clean.slice(root.length + 1).split('/').some(x => x.startsWith('.'))) return { ok: false, why: '含隐藏目录或隐藏文件' }
  return { ok: true, abs: clean }
}

// ---------------- G6-3 闸门 / 等你定编号：标签和卡片 ----------------
const GATE_SRC = String.raw`G\d+(?:[a-z]|-\d+)?`
const TASK_SRC = String.raw`T\d{3,}|L\d{4}-\d+`
/**
 * 认三种写法：跨任务 `T013·G14` / `T013 G14` / `T013-G14`、待定问题 `Q1105-2`、本任务里光写的 `G14`。
 * 前后都卡边界：前面不能是字母数字 . / * · -（文件名、路径、粗体、别的编号里的不认），后面不能是字母数字、*，也不能是 . 或 - 再接字母数字（G14.html、G5_report.md）。
 */
export const REF_RE = new RegExp(String.raw`(?<![\w./*·-])(?:(${TASK_SRC})[·\s-](${GATE_SRC})|(Q\d{4}-\d{1,3})|(${GATE_SRC}))(?![\w*]|[.-][A-Za-z0-9])`, 'g')
export type Ref = { kind: 'gate'; task: string; gate: string } | { kind: 'q'; code: string }
/** 只认能在编号表里查到的；光写的 Gn 只在有「本任务」时认。返回文字片段和编号片段。 */
export function refParts(text: string, idx: { gateIndex: Record<string, any>; askIndex: Record<string, any> }, curTask?: string): Array<string | { ref: Ref; text: string }> {
  const out: Array<string | { ref: Ref; text: string }> = []; let last = 0
  for (const m of text.matchAll(REF_RE)) {
    let ref: Ref | undefined
    if (m[1] && m[2] && idx.gateIndex[m[1]]?.gates?.[m[2]]) ref = { kind: 'gate', task: m[1], gate: m[2] }
    else if (m[3] && idx.askIndex[m[3]]) ref = { kind: 'q', code: m[3] }
    else if (m[4] && curTask && idx.gateIndex[curTask]?.gates?.[m[4]]) ref = { kind: 'gate', task: curTask, gate: m[4] }
    if (!ref) continue
    if (m.index! > last) out.push(text.slice(last, m.index)); out.push({ ref, text: m[0] }); last = m.index! + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
/** 全文（Markdown）用：认出的编号变成宿主能点的相对链接 dshm-gate/<任务>/<闸门>、dshm-q/<编号>；代码里的不动。 */
export function linkRefs(text: string, idx: { gateIndex: Record<string, any>; askIndex: Record<string, any> }, curTask?: string): string {
  return mapProse(text, seg => refParts(seg, idx, curTask).map(p => typeof p === 'string' ? p
    : p.ref.kind === 'gate' ? `[${p.text}](dshm-gate/${p.ref.task}/${p.ref.gate})` : `[${p.text}](dshm-q/${p.ref.code})`).join(''))
}
export function refTitle(ref: Ref, idx: { gateIndex: Record<string, any>; askIndex: Record<string, any> }): string {
  if (ref.kind === 'gate') { const g = idx.gateIndex[ref.task]?.gates?.[ref.gate]; return g ? `${ref.task}·${ref.gate} · ${g.title}（${g.status}）` : `${ref.task}·${ref.gate}` }
  const a = idx.askIndex[ref.code]; return a ? `${ref.code} · ${a.question}（${a.state === 'answered' ? '已定' : '待定'}）` : ref.code
}
/** 卡片位置：按被点的那个标签定位（键盘触发、脚本触发的点击没有鼠标坐标）。 */
const at = (e: any) => { const r = e?.currentTarget?.getBoundingClientRect?.(); return r ? { x: r.left + 8, y: r.bottom - 6 } : { x: e?.clientX ?? 40, y: e?.clientY ?? 120 } }
/** 卡片（全局一张）：点了标签打开，Esc / 点外面 / 滚动 / 切换视图就关。 */
let card: { ref: Ref; x: number; y: number; at: number } | null = null
const cardSubs = new Set<() => void>()
const setCard = (c: typeof card) => { card = c; cardSubs.forEach(f => f()) }
function useCard() { return React.useSyncExternalStore(cb => { cardSubs.add(cb); return () => { cardSubs.delete(cb) } }, () => card) }
/** 用户消息里的标签点了：打开看板（定位到那个任务）再弹卡片。 */
export function openRefCard(ref: Ref, x = 40, y = 120) {
  if (ref.kind === 'gate') openBoard(ref.task); else openBoard()
  setCard({ ref, x, y, at: Date.now() })
}
/** 一行文字里的 #编号和 G / Q 编号都变成按钮。每个按钮把自己的值存进自己的 const（别引用循环变量）。 */
function RefText({ text, nos, onNo, curTask }: { text: string; nos?: ReadonlySet<number>; onNo?: (n: number) => void; curTask?: string }) {
  const b = useBoard()
  return h(React.Fragment, null, ...refParts(text, b, curTask).flatMap((part, i): any[] => {
    if (typeof part !== 'string') {
      const ref = part.ref
      return [h('button', { key: `ref-${i}`, className: 'dshm-ref', 'data-ref': ref.kind === 'gate' ? `${ref.task}/${ref.gate}` : ref.code, title: refTitle(ref, b),
        onClick: (e: any) => { e.stopPropagation(); setCard({ ref, ...at(e), at: Date.now() }) } }, part.text)]
    }
    if (!nos || !onNo) return [part]
    return inlineNoParts(part, nos).map((q, j) => {
      if (typeof q === 'string') return q
      const n = q.no
      return h('button', { key: `no-${i}-${j}-${n}`, className: 'dshm-nolink', 'data-jump-no': n, onClick: () => onNo(n), title: `跳到 #${n}` }, `#${n}`)
    })
  }))
}
function RefCard({ sessions }: { sessions: any[] }) {
  const c = useCard(); const b = useBoard()
  React.useEffect(() => {
    if (!c) return
    const close = () => setCard(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement)?.closest?.('[data-testid=dshm-ref-card],.dshm-ref')) close() }
    document.addEventListener('keydown', onKey); document.addEventListener('mousedown', onDown, true); window.addEventListener('scroll', close, true)
    const offNav = (() => { const f = () => close(); navSubs.add(f); return () => { navSubs.delete(f) } })()
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown, true); window.removeEventListener('scroll', close, true); offNav() }
  }, [c?.at])
  if (!c) return null
  const vw = typeof window !== 'undefined' ? window.innerWidth : 400
  const style = { left: Math.max(8, Math.min(c.x - 20, vw - 308)), top: Math.max(8, c.y + 14) }
  if (c.ref.kind === 'gate') {
    const ref = c.ref; const t = b.gateIndex[ref.task]; const g = t?.gates?.[ref.gate]
    if (!g) return null
    const spec = t.spec as string | null
    return h('div', { className: 'dshm-card', 'data-testid': 'dshm-ref-card', role: 'dialog', style },
      h('div', { className: 'dshm-card-h' }, h('b', null, `${ref.task}·${ref.gate}`), ' ', g.title),
      h('div', { className: 'dshm-meta' }, `${t.title}`),
      h('div', { style: { margin: '4px 0' } }, h('span', { className: `dshm-chip ${g.status === '已验收' ? 'ok' : g.status === '打回' ? 'bad' : g.status === '进行中' ? 'wait' : 'mute'}` }, g.status)),
      h('div', { className: 'dshm-meta' }, `产物：${g.produces || '（验收时补）'}`),
      (g.outputs ?? []).length > 0 && h('div', { className: 'dshm-prod' }, ...g.outputs.map((p: string) => h('button', { key: p, className: 'dshm-link', 'data-open-path': p, title: p, onClick: () => openPath(p, sessions, undefined, b.master) }, `${p.split('/').pop()} ↗`))),
      spec && h('div', { style: { marginTop: 6 } }, h('button', { className: 'dshm-link', 'data-card-spec': '1', onClick: () => openPath(spec, sessions, b.master, b.master), title: '宿主的预览不支持跳到某一节（G6-1 实测），这里只打开任务书' }, '看任务书 ↗')))
  }
  const ref = c.ref; const a = b.askIndex[ref.code]
  if (!a) return null
  return h('div', { className: 'dshm-card', 'data-testid': 'dshm-ref-card', role: 'dialog', style },
    h('div', { className: 'dshm-card-h' }, h('b', null, ref.code), ' ', a.question),
    h('div', { className: 'dshm-meta' }, `任务 ${a.task} · 提出于 ${showTime(a.at)}`),
    h('div', { style: { marginTop: 4 } }, a.state === 'answered' ? h('span', null, h('span', { className: 'dshm-chip ok' }, '已定'), ` ${a.answer ?? ''}`) : h('span', { className: 'dshm-chip wait' }, '待定')),
    h('div', { style: { marginTop: 6 } }, h('button', { className: 'dshm-link', onClick: () => { setCard(null); setNav({ view: 'task', task: a.task }) } }, `看任务 ${a.task} ↗`)))
}

// ---------------- 浏览器通知（可选，60 秒内合并成一条）----------------
/** session：点通知要跳到的会话（等你点的条目才有）。 */
export interface NotifyItem { key: string; text: string; session?: string }
export interface NotifyMsg { title: string; body: string; session?: string }
/** 第一次看到的一批只当基线、不通知；之后新出现的条目攒起来，距上次通知满 60 秒才发一条（合并）。 */
export class NotifyBatcher {
  private seen = new Set<string>(); private primed = false; private pending: NotifyItem[] = []; private lastSent = -Infinity
  constructor(private readonly windowMs = 60_000) {}
  feed(items: NotifyItem[], now: number): NotifyMsg | undefined {
    for (const it of items) { if (this.seen.has(it.key)) continue; this.seen.add(it.key); if (this.primed) this.pending.push(it) }
    this.primed = true
    return this.flush(now)
  }
  flush(now: number): NotifyMsg | undefined {
    if (!this.pending.length || now - this.lastSent < this.windowMs) return undefined
    const list = this.pending; this.pending = []; this.lastSent = now
    const session = list.find(x => x.session)?.session // 合并成一条时，点了跳到第一个在等你点的会话
    return { title: list.length === 1 ? '总管看板' : `总管看板：${list.length} 件事`, body: list.slice(0, 5).map(x => x.text).join('\n') + (list.length > 5 ? `\n……还有 ${list.length - 5} 件` : ''), ...(session ? { session } : {}) }
  }
}
/** 从 state 里取出「需要你看一眼」的条目。 */
export function notifyItems(data: any): NotifyItem[] {
  const out: NotifyItem[] = []
  for (const a of data?.asks ?? []) out.push({ key: `ask:${a.id}`, text: `等你定 ${a.code ?? `#${a.id}`}（${a.task}）：${a.question}` })
  for (const t of data?.tasks ?? []) if (!t.closed && NEEDS_YOU.has(t.state)) out.push({ key: `task:${t.id}:${t.state}`, text: `${t.id} ${t.state}：${t.title}` })
  for (const w of data?.waiting ?? []) out.push({ key: `wait:${w.session}:${w.since}`, text: `⏳ ${w.title} 等你${w.kind === 'approval' ? '批准' : '回答'}：${w.label}`, session: w.session })
  return out
}

// ---------------- 看板导航（模块内共享：@任务 小标签、每轮末尾标签都能让看板跳到某任务）----------------
type Nav = { view: 'list' } | { view: 'task'; task: string } | { view: 'sessions' }
let nav: Nav = { view: 'list' }
const navSubs = new Set<() => void>()
const setNav = (n: Nav) => { nav = n; navSubs.forEach(f => f()) }
function useNav(): Nav { return React.useSyncExternalStore(cb => { navSubs.add(cb); return () => { navSubs.delete(cb) } }, () => nav) }
let rootCtx: Ctx
/** 打开右侧栏看板（可直接定位到某任务）。 */
export function openBoard(task?: string) {
  // 不带任务号时只打开标签、不动当前视图：自动打开（总管会话 / 左侧入口的延时）不能把用户刚点开的任务弹回列表
  if (task) setNav({ view: 'task', task })
  try { rootCtx?.sidebarRight?.openTab(BOARD_KIND) } catch (e) { console.warn('[dsh-master] 打开看板失败', e) }
}
/** 打开某个会话，并（可选）往它的输入框末尾预填一段文字。 */
function openSessionWith(sessionId: string, prompt?: string) {
  const fill = () => {
    const binding = rootCtx?.sessions?.binding?.(sessionId)
    if (!binding) return false
    try { rootCtx.get('conversation').input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' }) } catch (e) { console.warn('[dsh-master] 预填失败', e) }
    return true
  }
  if (prompt && !fill()) setTimeout(fill, 800)
  try { rootCtx?.uiWorkspace?.openSession(sessionId) } catch (e) { console.warn('[dsh-master] 打开会话失败', e) }
}
/** 看板里的一行提示（路径被拒等）；4 秒后消失。 */
let notice: { text: string; at: number } | null = null
const noticeSubs = new Set<() => void>()
const showNotice = (text: string) => { const at = Date.now(); notice = { text, at }; noticeSubs.forEach(f => f()); setTimeout(() => { if (notice?.at === at) { notice = null; noticeSubs.forEach(f => f()) } }, 4000) }
function useNotice() { return React.useSyncExternalStore(cb => { noticeSubs.add(cb); return () => { noticeSubs.delete(cb) } }, () => notice) }
let docsRoot: string | null = null
/** Markdown 里点了文件链接：先过白名单再打开。 */
function openChecked(p: string, sessions: any[], prefer?: string, master = LEGACY_MASTER) {
  const base = (sessions.find(s => s.id === prefer) ?? sessions.find(s => s.id === master))?.cwd
  const r = checkPath(p, [...sessions.map(s => String(s.cwd ?? '')), ...(docsRoot ? [docsRoot] : [])], base)
  if (!r.ok) { showNotice(`没有打开「${p}」：${r.why}`); return }
  openPath(r.abs, sessions, prefer, master)
}
function openPath(p: string, sessions: any[], prefer?: string, master = LEGACY_MASTER) {
  const under = (s: any) => p.startsWith(String(s.cwd ?? '').replace(/\/+$/, '') + '/')
  const owner = sessions.find(s => s.id === prefer && under(s)) ?? sessions.find(under) ?? sessions.find(s => s.id === master)
  if (!owner) return
  try { rootCtx.get('uiWorkspace')?.openSession(owner.id) } catch {}
  setTimeout(() => { try { rootCtx.get('sidebarRight')?.openResource(fileAddress(owner.id, owner.cwd, p)) } catch (e) { console.warn('[dsh-master] 打开预览失败', e) } }, 700)
}

// ---------------- 样式（DSH 主题变量 + Claude 侧看板的状态色）----------------
const CSS = `
.dshm{--dshm-run:#3b82f6;--dshm-wait:#d29922;--dshm-ok:#2da44e;--dshm-bad:#e5534b;--dshm-line:var(--dsw-alias-border-l3,#8883);--dshm-mute:var(--dsw-alias-label-secondary,#8b8b93);
  height:100%;display:flex;flex-direction:column;box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.5;min-width:0;overflow:hidden}
.dshm *{box-sizing:border-box}
.dshm-hd{padding:10px 14px 6px;border-bottom:1px solid var(--dshm-line)}
.dshm-hd h2{font-size:15px;margin:0;font-weight:650;overflow-wrap:anywhere}
.dshm-meta{font-size:11px;color:var(--dshm-mute)}
.dshm-tools{display:flex;flex-wrap:nowrap;gap:6px;padding:8px 14px;border-bottom:1px solid var(--dshm-line);overflow-x:auto;scrollbar-width:none}
.dshm-tools::-webkit-scrollbar{display:none}
.dshm-tools.wrap{flex-wrap:wrap;overflow-x:visible}
.dshm-btn{flex:none;font:inherit;font-size:12px;padding:3px 9px;min-height:28px;border:1px solid var(--dshm-line);border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.dshm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.dshm-btn[aria-pressed=true]{background:var(--dshm-run);border-color:var(--dshm-run);color:#fff}
.dshm-btn.go{background:var(--dshm-ok);border-color:var(--dshm-ok);color:#fff}
.dshm-btn.no{border-color:var(--dshm-bad);color:var(--dshm-bad)}
.dshm-btn.primary{border-color:var(--dshm-run);color:var(--dsw-alias-label-link,#6ea8fe)}
.dshm-touch .dshm-btn{min-height:36px}
.dshm-body{flex:1;min-height:0;overflow:auto}
.dshm-grp{font-size:12px;font-weight:600;color:var(--dshm-mute);padding:10px 14px 4px}
.dshm-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:2px 8px;padding:8px 14px 8px 11px;border-left:3px solid transparent;cursor:pointer;width:100%;text-align:left;background:transparent;border-top:0;border-right:0;border-bottom:0;color:inherit;font:inherit}
.dshm-row:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.dshm-row.need{border-left-color:var(--dshm-wait)}
.dshm-rowwrap{display:flex;align-items:stretch}.dshm-rowwrap>.dshm-row{flex:1;min-width:0}.dshm-focus{border:0;background:none;color:var(--dshm-mute);cursor:pointer;padding:0 12px;font-size:16px}.dshm-focus.on{color:var(--dshm-wait)}.dshm-grp-btn{display:block;width:100%;text-align:left;border:0;background:none;cursor:pointer;font:inherit;color:inherit}
.dshm-sb{padding:6px 14px 8px;border-bottom:1px solid var(--dshm-line);display:flex;flex-direction:column;gap:4px}.dshm-sb [data-live=running]{border-color:var(--dshm-run)}.dshm-sb .cnt-on{border-color:var(--dshm-wait);color:var(--dshm-wait)}.dshm-sb .cnt-bad{border-color:var(--dshm-bad);color:var(--dshm-bad)}
.dshm-rid{font-weight:700;white-space:nowrap}.dshm-rt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshm-rm{grid-column:2/4;font-size:11px;color:var(--dshm-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshm-chip{display:inline-block;padding:0 7px;border-radius:9px;font-size:11px;color:#fff;white-space:nowrap;line-height:18px}
.dshm-chip.run{background:var(--dshm-run)}.dshm-chip.wait{background:var(--dshm-wait)}.dshm-chip.ok{background:var(--dshm-ok)}.dshm-chip.bad{background:var(--dshm-bad)}.dshm-chip.mute{background:#8889}
.dshm-gate{display:inline-block;font-size:10px;border:1px solid var(--dshm-line);border-radius:4px;padding:0 4px;margin-right:3px;color:var(--dshm-mute)}
.dshm-gate.passed{color:var(--dshm-ok);border-color:var(--dshm-ok)}.dshm-gate.current{color:var(--dshm-wait);border-color:var(--dshm-wait)}.dshm-gate.rejected{color:var(--dshm-bad);border-color:var(--dshm-bad)}
.dshm-prod{display:flex;flex-wrap:wrap;gap:4px 6px;margin-top:6px;align-items:center}
.dshm-prod .dshm-link{font-size:12px}
.dshm-ask{margin:6px 14px;border:1px dashed var(--dshm-wait);border-radius:8px;padding:8px 10px}
.dshm-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dshm-ev{display:grid;grid-template-columns:44px minmax(0,1fr);gap:8px;padding:7px 14px;border-bottom:1px solid var(--dshm-line)}
.dshm-ev .t{color:var(--dshm-mute);font-size:11px;padding-top:1px}
.dshm-ev .k{font-size:11px;color:var(--dshm-mute);margin-right:6px}
.dshm-why{font-size:10px;color:var(--dshm-mute);border:1px solid var(--dshm-line);border-radius:4px;padding:0 4px;margin-right:6px;white-space:nowrap}
.dshm-link{color:var(--dsw-alias-label-link,#6ea8fe);cursor:pointer;background:none;border:0;padding:0;font:inherit;font-size:11px;white-space:nowrap}
.dshm-txt{overflow-wrap:anywhere;min-width:0}
.dshm-no{color:var(--dshm-mute);font-size:11px;margin-left:4px}
.dshm-wait{padding:6px 14px;border-bottom:1px solid var(--dshm-line);background:color-mix(in srgb,#d29922 18%,transparent)}
.dshm-wait-row{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;font-size:12px;padding:3px 0;cursor:pointer;overflow-wrap:anywhere}
.dshm-nolink{color:var(--dsw-alias-label-link,#6ea8fe);cursor:pointer;background:none;border:0;padding:0;font:inherit}
.dshm-ev.flash{animation:dshm-flash 1.6s ease-out}
@keyframes dshm-flash{0%{background:color-mix(in srgb,#d29922 40%,transparent)}100%{background:transparent}}
.dshm-full{margin-top:6px;border-left:2px solid var(--dshm-line);padding-left:10px;min-width:0;overflow-x:auto}
.dshm-part{margin:6px 0}
.dshm-part .who{font-size:11px;color:var(--dshm-mute)}
.dshm-foot{border-top:1px solid var(--dshm-line);padding:8px 14px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dshm-err{color:var(--dshm-bad);font-size:12px;padding:4px 14px}
.dshm-pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#8b8b93);border:1px solid var(--dsw-alias-border-l3,#8883);border-radius:6px;padding:0 6px;margin-top:6px;cursor:pointer;background:transparent;font-family:inherit}
.dshm-pill b{color:var(--dsw-alias-label-link,#6ea8fe);font-weight:600}
.dshm-taskref{display:inline-block;background:color-mix(in srgb,#3b82f6 22%,transparent);color:var(--dsw-alias-label-link,#6ea8fe);border-radius:6px;padding:0 5px;cursor:pointer}
.dshm-ref{color:var(--dsw-alias-label-link,#6ea8fe);cursor:pointer;background:none;border:0;padding:0;font:inherit;text-decoration:underline dotted;text-underline-offset:2px}
button.dshm-gate.dshm-ref{text-decoration:none;font-size:11px;padding:1px 5px;margin-bottom:3px}
.dshm-card{position:fixed;z-index:50;width:300px;max-width:calc(100vw - 16px);background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-l1,#1c1c1f));color:inherit;border:1px solid var(--dshm-line);border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px #0006;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.dshm-card-h{margin-bottom:2px}
.dshm-hbtn{font:inherit;font-size:12px;padding:1px 8px;min-height:24px;border:1px solid var(--dsw-alias-border-l3,#8883);border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
`
function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById('dsh-master-panel-css')) return
  const s = document.createElement('style'); s.id = 'dsh-master-panel-css'; s.textContent = CSS; document.head.appendChild(s)
}
function usePoll<T>(fn: () => Promise<T>, deps: unknown[], ms = 5000): { data: T | undefined; error: string | undefined; reload: () => void } {
  const [data, setData] = React.useState<T>(); const [error, setError] = React.useState<string>(); const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    let alive = true
    const run = () => fn().then(v => { if (alive) { setData(v); setError(undefined) } }).catch(e => alive && setError(String(e.message ?? e)))
    run(); const t = setInterval(run, ms)
    return () => { alive = false; clearInterval(t) }
  }, [...deps, tick])
  return { data, error, reload: () => setTick(x => x + 1) }
}

// ---------------- Markdown（宿主组件；拿不到就纯文本）----------------
function Md({ text, sessions, prefer, nos, onNo, curTask }: { text: string; sessions: any[]; prefer?: string; nos?: ReadonlySet<number>; onNo?: (n: number) => void; curTask?: string }) {
  const b = useBoard()
  text = escapeIntrawordStars(linkRefs(nos?.size ? linkItemNos(text, nos) : text, b, curTask))
  let P: any
  try { P = require('@deepseek-ai/dsh-client-ui-primitives') } catch { P = undefined }
  if (!P?.MarkdownText) return h('div', { style: { whiteSpace: 'pre-wrap' } }, text)
  const body = h(P.MarkdownText, { text })
  if (!P.MarkdownDelegateProvider) return body
  return h(P.MarkdownDelegateProvider, {
    openFile: (x: any) => {
      const p = typeof x === 'string' ? x : x?.path ?? x?.target
      if (typeof p !== 'string') return
      const m = /^dshm-item\/(\d+)$/.exec(p)
      if (m) { const n = Number(m[1]); onNo?.(n); return } // 时间线编号：滚过去（n 是这次匹配自己的 const）
      const g = /^dshm-gate\/([^/]+)\/([^/]+)$/.exec(p)
      if (g) { const ref: Ref = { kind: 'gate', task: g[1]!, gate: g[2]! }; setCard({ ref, x: 60, y: 160, at: Date.now() }); return }
      const q = /^dshm-q\/(Q\d{4}-\d{1,3})$/.exec(p)
      if (q) { const ref: Ref = { kind: 'q', code: q[1]! }; setCard({ ref, x: 60, y: 160, at: Date.now() }); return }
      openChecked(p, sessions, prefer, b.master)
    },
    openExternalLink: (u: string) => { if (/^https:\/\//.test(u)) window.open(u, '_blank', 'noopener,noreferrer'); else showNotice(`只打开 https 链接：${u}`) },
    children: body,
  })
}

const NOTIFY_PREF = 'dsh-master.notify'
const readPref = () => { try { return localStorage.getItem(NOTIFY_PREF) === '1' } catch { return false } }
const writePref = (v: boolean) => { try { localStorage.setItem(NOTIFY_PREF, v ? '1' : '0') } catch { /* 私密窗口等 */ } }
function useNotify(data: any) {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  const [on, setOn] = React.useState(() => supported && readPref() && (window as any).Notification.permission === 'granted')
  const batcher = React.useRef(new NotifyBatcher())
  // 只弹通知、不抢焦点（创建时不调 focus）；用户点了通知才切回来并跳到那个会话
  const fire = (msg?: NotifyMsg) => {
    if (!msg || !on) return
    try {
      const n = new (window as any).Notification(msg.title, { body: msg.body, tag: 'dsh-master' })
      const sid = msg.session
      if (sid) n.onclick = () => { try { window.focus() } catch {} ; openSessionWith(sid); try { n.close() } catch {} }
    } catch {}
  }
  React.useEffect(() => { if (data) fire(batcher.current.feed(notifyItems(data), Date.now())) }, [data, on])
  React.useEffect(() => { if (!on) return; const t = setInterval(() => fire(batcher.current.flush(Date.now())), 10_000); return () => clearInterval(t) }, [on])
  const toggle = async () => {
    if (!supported) return
    if (on) { setOn(false); writePref(false); return }
    const ok = (await (window as any).Notification.requestPermission().catch(() => 'denied')) === 'granted'; setOn(ok); writePref(ok)
  }
  return { on, toggle, supported }
}

// ---------------- 看板（右侧栏标签）----------------
function Board({ sessionId }: { sessionId?: string }) {
  ensureStyle()
  const n = useNav()
  const [archived, setArchived] = React.useState(false)
  const [mine, setMine] = React.useState(false)
  const st = usePoll(() => getJson(withSession(`/api/dsh-master/state?view=${archived ? 'archived' : 'active'}`, sessionId)), [archived, sessionId])
  const notify = useNotify(st.data)
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const sessions: any[] = st.data?.sessions ?? []
  if (st.data?.docsRoot) docsRoot = st.data.docsRoot
  const note = useNotice()
  const needCount = (st.data?.tasks ?? []).filter(needsYou).length
  // G8：暂停 / 恢复项目总管（只有项目单元有；旧单元存档只读时不显示）
  const [pauseErr, setPauseErr] = React.useState<string | undefined>()
  const togglePause = async () => { setPauseErr(undefined); try { await postJson(withSession('/api/dsh-master/action', sessionId), { action: st.data?.paused ? 'resume' : 'pause' }); st.reload() } catch (e: any) { setPauseErr(e.message) } }
  const master: string = st.data?.master ?? LEGACY_MASTER
  const bctx = React.useMemo<BoardContext>(() => ({ sid: sessionId, master, project: st.data?.project ?? null, gateIndex: st.data?.gateIndex ?? {}, askIndex: st.data?.askIndex ?? {}, readonly: !!st.data?.archived }), [sessionId, st.data])
  if (st.data) lastRefs = { gateIndex: bctx.gateIndex, askIndex: bctx.askIndex }
  // 看板换了单元（切到别的项目 / 旧总管的会话）：导航是模块里共用的，停在上一个项目的任务上会显示「没有任务」⇒ 回到列表、关掉卡片
  const unitKey = st.data ? (st.data.project?.id ?? '') : undefined
  React.useEffect(() => {
    if (unitKey === undefined) return
    if (lastUnitKey !== undefined && lastUnitKey !== unitKey) { setCard(null); if (nav.view === 'task') setNav({ view: 'list' }) }
    lastUnitKey = unitKey
  }, [unitKey])
  return h(BoardCtx.Provider, { value: bctx }, h('div', { className: `dshm${touch ? ' dshm-touch' : ''}`, 'data-testid': 'dsh-master-board', ...(st.data?.project ? { 'data-project': st.data.project.id } : {}) },
    h(RefCard, { sessions }),
    // G6-3：这个工作区还没开张（已经有别的项目开张了才提示）
    st.data?.notOpened && h('div', { className: 'dshm-wait', 'data-testid': 'dshm-not-opened' },
      h('div', null, '这个工作区还没开张：在这个工作区新建会话，预设选「dsh-master 总管」，就会开张成一个项目。下面是旧的看板。'),
      (st.data.projects ?? []).length > 0 && h('div', { style: { marginTop: 4 } }, '已开张的项目：', ...st.data.projects.map((p: any) => { const m = p.master; return h('button', { key: p.id, className: 'dshm-link', style: { marginLeft: 6 }, onClick: () => openSessionWith(m) }, `${p.id} ↗`) }))),
    // G6-5：旧单元已存档 ⇒ 只读（看得到旧任务，改不了）
    st.data?.paused && h('div', { className: 'dshm-wait', 'data-testid': 'dshm-paused', role: 'status' }, `项目已暂停 · ${showTime(st.data.paused.at)}${st.data.paused.by === 'user' ? '' : ` · ${st.data.paused.by} 暂停的`}${st.data.paused.reason ? ` · ${st.data.paused.reason}` : ''}：不跑定时巡检，成员一轮结束没回报也不提醒总管；你直接找总管照常干活。要恢复点上面的「恢复」。`),
    pauseErr && h('div', { className: 'dshm-err', role: 'alert' }, pauseErr),
    st.data?.archived && h('div', { className: 'dshm-wait', 'data-testid': 'dshm-archived' }, `旧单元已存档（只读）${st.data.archived.at ? ` · ${showTime(st.data.archived.at)}` : ''}：这里的任务只能看，不再投递、不再提醒；新的工作在项目里做。`),
    note && h('div', { className: 'dshm-err', 'data-testid': 'dshm-notice', role: 'status' }, note.text),
    // 等你点：只提醒、点了跳到那个会话；这里没有任何「允许」按钮（批准只能在那个会话里点）
    (st.data?.waiting ?? []).length > 0 && h('div', { className: 'dshm-wait', 'data-testid': 'dshm-waiting', role: 'status' },
      ...(st.data.waiting as any[]).map((w: any) => {
        const sid = w.session
        return h('button', { key: `${sid}-${w.since}`, className: 'dshm-wait-row', 'data-wait-session': sid, onClick: () => openSessionWith(sid), title: '去那个会话里点' },
          `⏳ ${w.title} 等你${w.kind === 'approval' ? '批准' : '回答'} ${w.minutes} 分钟${w.label ? `：${w.label}` : ''} · 去处理 ↗`)
      })),
    n.view === 'task' ? h(TaskView, { task: n.task, sessions, now: st.data?.now, onChanged: st.reload })
      : h(React.Fragment, null,
        h('div', { className: 'dshm-hd' }, h('h2', null, '总管看板'),
          h('div', { className: 'dshm-meta', 'data-testid': 'dshm-board-meta' }, st.data ? `${st.data.project ? `项目 ${st.data.project.id} · ` : ''}总管 ${({ running: '忙', idle: '空闲', cold: '未加载' } as any)[sessions.find(s => s.id === master)?.live] ?? '—'} · 北京时间 ${showTime(st.data.now)} · ${sessions.filter(s => s.role === 'exec' && s.status !== 'closed').length} 个${st.data.project ? '成员' : '执行会话'}` : '加载中…')),
        // G11-2 总管状态栏（忙闲 + 正在什么、下次保底、三个可点的计数、执行会话块）
        st.data?.statusBar && h(StatusBar, { sb: st.data.statusBar, now: st.data.now, waiting: st.data.waiting ?? [], tasks: st.data.tasks ?? [],
          onAsks: () => setMine(true), onTask: (task: string) => setNav({ view: 'task', task }) }),
        // G5-F ⑧ 窄屏折行，最右的「会话（N）」「通知」不会被截掉（以前是横向滑、没提示）
        h('div', { className: 'dshm-tools wrap', 'data-testid': 'dshm-board-tools', role: 'toolbar' },
          !bctx.readonly && h('button', { className: 'dshm-btn go', onClick: () => openSessionWith(master, '新任务：'), title: '打开总管会话并预填「新任务：」，标题由总管起' }, '＋ 新任务'),
          !bctx.readonly && st.data?.project && h('button', { className: 'dshm-btn', 'data-testid': 'dshm-pause', 'aria-pressed': !!st.data?.paused, onClick: togglePause, title: st.data?.paused ? '恢复：重建定时巡检保底，提醒照常' : '暂停：删掉定时巡检保底、成员一轮结束不提醒总管；总管的工具和派活照常' }, st.data?.paused ? '恢复' : '暂停总管'),
          h('button', { className: 'dshm-btn', 'aria-pressed': n.view === 'list' && !archived, onClick: () => { setArchived(false); setNav({ view: 'list' }) } }, '近 7 天'),
          h('button', { className: 'dshm-btn', 'aria-pressed': mine, onClick: () => setMine(x => !x) }, `只看等我（${needCount}）`),
          h('button', { className: 'dshm-btn', 'aria-pressed': archived, onClick: () => { setArchived(x => !x); setNav({ view: 'list' }) } }, '已归档'),
          h('button', { className: 'dshm-btn', 'aria-pressed': n.view === 'sessions', onClick: () => setNav(n.view === 'sessions' ? { view: 'list' } : { view: 'sessions' }) }, `会话（${sessions.length}）`),
          notify.supported && h('button', { className: 'dshm-btn', 'aria-pressed': notify.on, onClick: notify.toggle, title: '有等你定或需要你处理的任务时提醒（60 秒内合并成一条）' }, notify.on ? '通知：开' : '通知：关')),
        st.error && h('div', { className: 'dshm-err' }, st.error),
        h('div', { className: 'dshm-body' }, n.view === 'sessions' ? h(SessionsList, { sessions, now: st.data?.now, unenrolled: st.data?.unenrolled ?? [] })
          : h(React.Fragment, null, h(TaskList, { data: st.data, mine, archived, onChanged: st.reload }), h(Unenrolled, { list: st.data?.unenrolled ?? [], now: st.data?.now }))))))
}
/**
 * G11-2 总管状态栏。「正在」只有工具名 + 说明（服务端已裁好，见 status-bar.ts）；计数可点：
 * 等你定 ⇒ 只看等我；等你点 ⇒ 打开第一个在等你点的会话；受阻 ⇒ 打开第一件受阻的任务。成员块点了打开那个会话。
 */
function StatusBar({ sb, now, waiting, tasks, onAsks, onTask }: { sb: any; now?: string; waiting: any[]; tasks: any[]; onAsks: () => void; onTask: (task: string) => void }) {
  const live = (x: string) => (({ running: '忙', idle: '空闲', cold: '未加载' } as any)[x] ?? '—')
  const blocked = tasks.find((t: any) => t.state === '受阻')
  const count = (key: string, label: string, n: number, onClick?: () => void) => h('button', { key, className: `dshm-btn${n ? (key === 'blocked' ? ' cnt-bad' : ' cnt-on') : ''}`, 'data-count': key, 'data-n': n, disabled: !n || !onClick, onClick }, `${label} ${n}`)
  return h('div', { className: 'dshm-sb', 'data-testid': 'dshm-status-bar', role: 'status' },
    h('div', { className: 'dshm-meta', 'data-testid': 'dshm-sb-master', 'data-live': sb.master.live },
      `总管 ${live(sb.master.live)}`,
      sb.master.doing ? ` · ${sb.master.live === 'running' ? '正在' : '上一步'}：${sb.master.doing}${sb.master.doingAt ? `（${showTime(sb.master.doingAt, now)}）` : ''}` : '',
      h('span', { 'data-testid': 'dshm-sb-next' }, ` · 下次保底 ${sb.nextSchedule ? showTime(sb.nextSchedule, now) : '—'}`)),
    h('div', { className: 'dshm-tools wrap', 'data-testid': 'dshm-sb-counts' },
      count('asks', '等你定', sb.counts.asks, onAsks),
      count('waiting', '等你点', sb.counts.waiting, waiting[0] ? () => openSessionWith(waiting[0].session) : undefined),
      count('blocked', '受阻', sb.counts.blocked, blocked ? () => onTask(blocked.id) : undefined)),
    sb.members.length > 0 && h('div', { className: 'dshm-tools wrap', 'data-testid': 'dshm-sb-members' },
      ...sb.members.map((m: any) => h('button', { key: m.id, className: 'dshm-btn', 'data-member': m.id, 'data-live': m.live, onClick: () => openSessionWith(m.id), title: m.title },
        `${m.id} ${live(m.live)}${m.tasks.length ? ` · ${m.tasks.map((t: any) => `${t.id}${t.gate ? `/${t.gate}` : ''}${t.state === '受阻' ? '（受阻）' : ''}`).join('、')}` : ' · 没活'}`))))
}

/** G6-3 未入编：项目工作区里用别的预设建的会话（看得到，但不归总管管）。 */
function Unenrolled({ list, now }: { list: any[]; now?: string }) {
  if (!list.length) return null
  return h('div', { 'data-testid': 'dshm-unenrolled' }, h('div', { className: 'dshm-grp' }, `未入编的会话 · ${list.length}`),
    ...list.map((u: any) => { const sid = u.session; return h('div', { key: sid, className: 'dshm-ev', 'data-unenrolled': sid, style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
      h('div', { className: 'dshm-txt' }, h('b', null, sid), h('div', { className: 'dshm-meta' }, `${showTime(u.at, now)} 在这个项目里新建 · 预设 ${u.preset ?? '—'} · 不归总管管（要它干活请总管用 master_spawn 建成员）`)),
      h('button', { className: 'dshm-btn', onClick: () => openSessionWith(sid) }, '打开 ↗')) }))
}
/** 上一次看板显示的是哪个单元（项目 ID；旧单元是空串）。 */
let lastUnitKey: string | undefined
/** 最近一次看板拉到的编号表（用户消息里的标签悬停时用；拿不到就只显示编号）。 */
let lastRefs: { gateIndex: Record<string, any>; askIndex: Record<string, any> } = { gateIndex: {}, askIndex: {} }

/** G11-3：组的折叠状态（只是显示偏好，存浏览器、每台设备各一份；Focus 本身存项目库）。读写失败就当没有。 */
const COLLAPSE_KEY = 'dshm.collapsed.v1'
const loadCollapsed = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') ?? {} } catch { return {} } }
const saveCollapsed = (v: Record<string, boolean>) => { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(v)) } catch { /* 隐私模式等 */ } }

function TaskList({ data, mine, archived, onChanged }: any) {
  const tasks: any[] = data?.tasks ?? []
  const asks: any[] = data?.asks ?? []
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>(loadCollapsed)
  // G11-3：★ Focus → 等你处理 → 最近 5 天按日期 → 更早（默认折叠）；标题点了收起 / 展开
  const groups = listGroups(tasks, { mine, archived, today: String(data?.now ?? '').slice(0, 10) })
  const isClosed = (g: any) => collapsed[g.key] ?? g.collapsedByDefault
  const toggle = (g: any) => setCollapsed(c => { const v = { ...c, [g.key]: !isClosed(g) }; saveCollapsed(v); return v })
  return h(React.Fragment, null,
    ...groups.flatMap(g => [h('button', { key: `grp-${g.key}`, className: 'dshm-grp dshm-grp-btn', 'data-group': g.key, 'aria-expanded': !isClosed(g), onClick: () => toggle(g) },
      `${isClosed(g) ? '▸' : '▾'} ${g.name} · ${g.list.length}`),
      ...(isClosed(g) ? [] : g.list.flatMap((t: any) => [
        h(TaskRow, { key: t.id, t, now: data?.now, onChanged }),
        ...asks.filter(a => a.task === t.id).map(a => h(AskCard, { key: `ask-${a.id}`, a, onChanged })),
      ]))]),
    tasks.length === 0 && h('div', { className: 'dshm-meta', style: { padding: '12px 14px' } }, archived ? '没有已归档的任务' : '这个视图里没有任务'))
}

function TaskRow({ t, now, onChanged }: any) {
  const b = useBoard()
  const need = needsYou(t)
  const label = stateLabel(t)
  const [err, setErr] = React.useState<string>()
  // G11-3：置顶 / 取消置顶（存项目库，手机电脑一致）
  const focus = async () => { setErr(undefined); try { await postJson(withSession('/api/dsh-master/action', b.sid), { action: 'focus', task: t.id, on: !t.focus }); onChanged?.() } catch (e: any) { setErr(e.message) } }
  return h('div', { className: 'dshm-rowwrap' },
    h('button', { className: `dshm-row${need ? ' need' : ''}`, 'data-task': t.id, onClick: () => setNav({ view: 'task', task: t.id }) },
      h('span', { className: 'dshm-rid' }, t.id), h('span', { className: 'dshm-rt' }, t.title), h('span', { className: `dshm-chip ${stateTone(t.openAsks ? '等你定' : t.state)}` }, label),
      h('span', { className: 'dshm-rm' }, `${t.gate ? `${t.gate} · ` : ''}${t.owner} · ${showTime(t.updated, now)}${t.openAsks ? ` · 等你定 ${t.openAsks}` : ''}`)),
    !b.readonly && h('button', { className: `dshm-focus${t.focus ? ' on' : ''}`, 'data-focus-task': t.id, 'aria-pressed': !!t.focus, onClick: focus, title: t.focus ? '取消置顶' : '置顶到 ★ Focus 区' }, t.focus ? '★' : '☆'),
    err && h('div', { className: 'dshm-err' }, err))
}

function AskCard({ a, onChanged }: any) {
  const b = useBoard()
  const [err, setErr] = React.useState<string>()
  const answer = async (x: string) => { setErr(undefined); try { await postJson(withSession('/api/dsh-master/action', b.sid), { action: 'answer', ask: a.id, answer: x }); onChanged() } catch (e: any) { setErr(e.message) } }
  return h('div', { className: 'dshm-ask', 'data-ask': a.id },
    h('div', null, h('b', null, `等你定 ${a.code ?? `#${a.id}`}`), ' ', a.question),
    !b.readonly && h('div', { className: 'dshm-acts' }, ...(a.options ?? []).map((o: string) => h('button', { key: o, className: 'dshm-btn', onClick: () => answer(o) }, o)),
      h('button', { className: 'dshm-btn', onClick: () => openSessionWith(b.master, `@${a.task} `), title: '打开总管会话，预填 @任务，在对话里回答' }, '在对话里回答 ↗')),
    err && h('div', { className: 'dshm-err', style: { padding: '4px 0 0' } }, err))
}

const EVENT_TEXT: Record<string, (d: any, it: any) => string> = {
  'task/dispatched': (d, it) => `派给 ${it.session}${d?.gate ? `（${d.gate}）` : ''}`,
  'task/report': d => d?.line ?? '回报',
  'task/late-report': d => `迟到回报（不改状态）：${d?.line ?? ''}`,
  'task/reviewed': d => `${d?.gate ?? ''} ${d?.verdict ?? ''}${d?.final ? '（任务完成）' : ''}${d?.notes ? `：${d.notes}` : ''}`,
  'task/user-done': d => `你在看板标为完成${d?.note ? `：${d.note}` : ''}`, 'task/user-cancel': d => `你在看板取消了${d?.note ? `：${d.note}` : ''}`,
  'spec/written': () => '写了任务书', 'spec/rewritten': () => '改了任务书',
  'task/linked': d => `【关联 @${d?.with ?? ''}】${d?.why ?? ''}`,
  'claims/deny': (d, it) => `${it.session} 想改 ${d?.file ?? ''}，被拦下：在 ${d?.claimTask ?? ''}（${d?.claimOwner ?? ''}）认领的 ${d?.claimPath ?? ''} 里`,
  'claims/overlap': d => `认领重叠：${d?.task ?? ''} 的 ${d?.path ?? ''} 和 ${d?.with ?? ''} 的 ${d?.other ?? ''}${d?.reason ? `（理由：${d.reason}）` : ''}`,
  'fs/conflict': (d, it) => d?.kind === 'stale' ? `${it.session} 改 ${d?.file ?? ''} 被宿主拦下：读过以后别人改过（乐观锁），要重读再改` : `${it.session} 改 ${d?.file ?? ''} 被宿主拦下：没读过就改，要先读`,
  'guard/git-deny': (d, it) => `${it.session} 想动 git，被拦下（成员不提交）：${d?.command ?? ''}`,
}
const EVENT_KIND: Record<string, string> = { 'task/dispatched': '派活', 'task/report': '回报', 'task/late-report': '回报', 'task/reviewed': '验收', 'task/user-done': '看板', 'task/user-cancel': '看板', 'spec/written': '任务书', 'spec/rewritten': '任务书', 'task/linked': '关联', 'claims/deny': '认领', 'claims/overlap': '认领', 'fs/conflict': '冲突', 'guard/git-deny': '守卫' }
/** 事件展开后的全文（没有更多内容的返回 undefined，不显示「展开」）。 */
function eventFull(it: any): string | undefined {
  const d = it.data ?? {}
  if (it.type === 'task/report' || it.type === 'task/late-report') return [d.line, d.body].filter(Boolean).join('\n\n') || undefined
  if (it.type === 'task/reviewed') return d.notes ? `**${d.gate ?? ''} ${d.verdict ?? ''}${d.final ? '（任务完成）' : ''}**\n\n${d.notes}` : undefined
  return undefined
}

function TaskView({ task, sessions, now, onChanged }: any) {
  const b = useBoard()
  const th = usePoll(() => getJson(withSession(`/api/dsh-master/thread?task=${encodeURIComponent(task)}`, b.sid)), [task, b.sid])
  const [only, setOnly] = React.useState(false)
  const [msgs, setMsgs] = React.useState(false) // 插件转交的消息和对应的对话轮次 / 回报事件内容重复，默认收起
  const [confirm, setConfirm] = React.useState<'done' | 'cancel' | null>(null)
  const [err, setErr] = React.useState<string>()
  const t = th.data?.task
  const act = async (body: any) => { setErr(undefined); try { await postJson(withSession('/api/dsh-master/action', b.sid), body); th.reload(); onChanged() } catch (e: any) { setErr(e.message) } }
  const items: any[] = (th.data?.items ?? []).filter((it: any) => it.kind !== 'event' || EVENT_TEXT[it.type])
    .filter((it: any) => msgs || it.kind !== 'message')
    .filter((it: any) => !only || (it.kind === 'event' && ['task/report', 'task/late-report', 'task/reviewed'].includes(it.type)))
  const products: string[] = t?.products ?? []
  // 时间线编号：全部条目的编号（不受筛选影响），点了先放开挡住它的筛选，再滚过去闪一下
  const all: any[] = th.data?.items ?? []
  const nos = React.useMemo(() => new Set<number>(all.map((x: any) => Number(x.no)).filter(Boolean)), [th.data])
  const [jumpTo, setJumpTo] = React.useState<{ n: number; at: number } | null>(null)
  const onNo = React.useCallback((n: number) => {
    const target = all.find((x: any) => Number(x.no) === n)
    if (!target) return
    if (target.kind === 'message') setMsgs(true)
    if (!(target.kind === 'event' && ['task/report', 'task/late-report', 'task/reviewed'].includes(target.type))) setOnly(false)
    setJumpTo({ n, at: Date.now() })
  }, [th.data])
  React.useEffect(() => {
    if (!jumpTo) return
    const el = document.querySelector(`[data-testid=dshm-timeline] [data-item-no="${jumpTo.n}"]`) as HTMLElement | null
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
    const tm = setTimeout(() => el.classList.remove('flash'), 1700)
    return () => clearTimeout(tm)
  }, [jumpTo, items.length])
  return h(React.Fragment, null,
    h('div', { className: 'dshm-hd' },
      h('button', { className: 'dshm-link', onClick: () => setNav({ view: 'list' }) }, '← 任务列表'),
      t ? h(React.Fragment, null,
        h('h2', { style: { marginTop: 2 } }, `${t.id} ${t.title}`),
        h('div', { className: 'dshm-meta', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
          h('span', { className: `dshm-chip ${stateTone(t.openAsks ? '等你定' : t.state)}` }, stateLabel(t)),
          `负责 ${t.owner} · 派出 ${showTime(t.created)} · ${t.kind === 'heavy' ? '重任务' : '轻任务'}`),
        (t.gates ?? []).length > 0 && h('div', { style: { marginTop: 6 }, 'data-testid': 'dshm-gates' }, ...t.gates.map((g: any) => {
          const gate = g.gate; const def = b.gateIndex[t.id]?.gates?.[gate]
          if (!def) return h('span', { key: gate, className: `dshm-gate ${g.state}` }, gate)
          const ref: Ref = { kind: 'gate', task: t.id, gate }
          return h('button', { key: gate, className: `dshm-gate ${g.state} dshm-ref`, 'data-ref': `${t.id}/${gate}`, title: refTitle(ref, b), onClick: (e: any) => setCard({ ref, ...at(e), at: Date.now() }) }, `${gate} ${def.title}`)
        })),
        t.claims && h('div', { className: 'dshm-meta', 'data-testid': 'dshm-claims', style: { marginTop: 6 } }, `认领${t.claims.active ? '' : '（已失效）'}：`, ...t.claims.paths.map((p: string) => h('code', { key: p, style: { marginRight: 6 } }, p)), t.claims.reason ? ` · 重叠理由：${t.claims.reason}` : ''),
        h('div', { className: 'dshm-prod', 'data-testid': 'dshm-products' },
          h('span', { className: 'dshm-meta' }, '产物'),
          products.length ? products.map(p => /\.[A-Za-z0-9]{1,8}$/.test(p)
            ? h('button', { key: p, className: 'dshm-link', 'data-open-path': p, title: p, onClick: () => openPath(p, sessions, t.owner, b.master) }, `${p.split('/').pop()} ↗`)
            : h('code', { key: p, className: 'dshm-meta', title: '目录（宿主预览只开文件）' }, p)) : h('span', { className: 'dshm-meta' }, '还没有'),
          t.specPath && h('button', { className: 'dshm-link', onClick: () => openPath(t.specPath, sessions, b.master, b.master) }, '任务书 ↗')))
        : h('h2', null, task)),
    h('div', { className: 'dshm-tools wrap', role: 'toolbar', 'data-testid': 'dshm-detail-tools' },
      t && t.owner !== b.master && h('button', { className: 'dshm-btn primary', 'data-testid': 'dshm-open-exec', onClick: () => openSessionWith(t.owner), title: '干活的过程（思考、工具调用）在执行会话里看' }, `打开执行会话 ${t.owner} ↗`),
      // G11-1：打开该找的人（负责的在岗成员；没有 / 已关闭 / 负责人是总管 ⇒ 总管），预填 @任务
      h('button', { className: 'dshm-btn', 'data-testid': 'dshm-mention-task', 'data-talk-to': t?.talkTo ?? b.master, onClick: () => openSessionWith(t?.talkTo ?? b.master, `@${task} `),
        title: t?.talkTo && t.talkTo !== b.master ? `直接跟负责的 ${t.talkTo} 说（不经总管）` : '在总管会话里说' }, `在对话里提到 ${task} ↗`),
      h('button', { className: 'dshm-btn', 'aria-pressed': !only, onClick: () => setOnly(false) }, '全部'),
      h('button', { className: 'dshm-btn', 'aria-pressed': only, onClick: () => setOnly(true) }, '只看回报 / 验收'),
      h('button', { className: 'dshm-btn', 'aria-pressed': msgs, 'data-testid': 'dshm-toggle-msgs', onClick: () => setMsgs(x => !x), title: '插件在总管和执行会话之间转交的原文（派活、回报、提醒）；内容和对应的对话轮次、回报重复，默认收起' }, msgs ? '转交消息：开' : '转交消息：关')),
    (err || th.error) && h('div', { className: 'dshm-err' }, err ?? th.error),
    h('div', { className: 'dshm-body', 'data-testid': 'dshm-timeline' }, ...[...items].reverse().map(it => h(TimelineItem, { key: `${it.kind}-${it.no ?? ''}-${it.atMs}-${it.type ?? it.id ?? it.turn ?? ''}-${it.session ?? ''}`, it, task, sessions, now, nos, onNo, onConfirm: (x: any) => act({ action: 'confirm_tag', session: x.session, turn: x.turn, task }) })),
      items.length === 0 && h('div', { className: 'dshm-meta', style: { padding: '12px 14px' } }, '还没有记录')),
    t && !t.closed && !b.readonly && h('div', { className: 'dshm-foot' },
      confirm ? h(React.Fragment, null,
        h('span', null, `确认把 ${t.id} 标为「${confirm === 'done' ? '完成' : '取消'}」？`),
        h('button', { className: `dshm-btn${confirm === 'cancel' ? ' no' : ''}`, onClick: () => { act({ action: confirm, task: t.id }); setConfirm(null) } }, '确认'),
        h('button', { className: 'dshm-btn', onClick: () => setConfirm(null) }, '算了'))
        : h(React.Fragment, null,
          h('button', { className: 'dshm-btn', onClick: () => setConfirm('done') }, '标记完成'),
          h('button', { className: 'dshm-btn no', onClick: () => setConfirm('cancel') }, '不做了'))))
}

/** 一轮对话的全文：展开时才从会话记录里读。 */
function TurnFull({ session, turn, sessions, nos, onNo, task }: any) {
  const b = useBoard()
  const [v, setV] = React.useState<any>(); const [err, setErr] = React.useState<string>()
  React.useEffect(() => { let alive = true; getJson(`/api/dsh-master/turn?session=${encodeURIComponent(session)}&turn=${turn}`).then(x => alive && setV(x)).catch(e => alive && setErr(String(e.message ?? e))); return () => { alive = false } }, [session, turn])
  if (err) return h('div', { className: 'dshm-err', style: { padding: 0 } }, err)
  if (!v) return h('div', { className: 'dshm-meta' }, '读取中…')
  if (!v.parts?.length) return h('div', { className: 'dshm-meta' }, '这一轮没有文字内容')
  return h(React.Fragment, null, ...v.parts.map((p: any, i: number) => h('div', { key: i, className: 'dshm-part', 'data-part': p.role },
    h('div', { className: 'who' }, p.role === 'user' ? '你' : p.role === 'relay' ? '插件转来' : who(session, b.master)),
    h(Md, { text: p.role === 'relay' ? stripHeader(p.text) : p.text, sessions, prefer: session, nos, onNo, curTask: task }))),
    !v.ended && h('div', { className: 'dshm-meta' }, '（这一轮还在进行）'))
}

function TimelineItem({ it, task, sessions, now, onConfirm, nos, onNo }: any) {
  const b = useBoard()
  const [open, setOpen] = React.useState(false)
  const jump = (session: string) => h('button', { className: 'dshm-link', onClick: () => openSessionWith(session), title: '需要看上下文时打开那个会话（宿主没有跳到某一轮的接口）' }, ' · 原对话 ↗')
  const toggle = (has: boolean) => has ? h('button', { className: 'dshm-link', 'data-expand': '1', style: { marginLeft: 6 }, onClick: () => setOpen(x => !x) }, open ? '收起 ▴' : '展开 ▾') : null
  const row = (kind: string, head: any, full: any, session?: string) => h('div', { className: 'dshm-ev', 'data-kind': kind, ...(it.role ? { 'data-role': it.role } : {}), ...(it.no ? { 'data-item-no': it.no, id: `dshm-item-${it.no}` } : {}) },
    h('span', { className: 't' }, showTime(it.at, now)),
    h('div', { className: 'dshm-txt' }, head, it.no ? h('span', { className: 'dshm-no' }, `· #${it.no}`) : null, toggle(!!full), session && jump(session), open && full && h('div', { className: 'dshm-full' }, full)))
  const line = (t: string) => h(RefText, { text: t.length > 160 ? t.slice(0, 160) + '…' : t, nos, onNo, curTask: task })
  if (it.kind === 'turn') return row('turn', h(React.Fragment, null,
    h('span', { className: 'k' }, `${it.session === b.master ? '总管对话' : it.session} · 第 ${it.turn} 轮`),
    h('span', { className: 'dshm-why' }, it.role === 'primary' ? it.why : it.role === 'also' ? `也提到 · ${it.why}` : '可能相关'),
    h(RefText, { text: String(it.excerpt ?? ''), nos, onNo, curTask: task }),
    it.role === 'maybe' && h('button', { className: 'dshm-link', style: { marginLeft: 8 }, onClick: () => onConfirm(it) }, `确认归到 ${task}`)),
    h(TurnFull, { session: it.session, turn: it.turn, sessions, nos, onNo, task }), it.session)
  if (it.kind === 'message') {
    const text = stripHeader(String(it.text))
    const one = text.replace(/\s+/g, ' ')
    return row('message', h(React.Fragment, null, h('span', { className: 'k' }, `${who(it.from, b.master)} → ${who(it.to, b.master)}`), line(one)),
      one.length > 160 || /\n/.test(text) ? h(Md, { text, sessions, prefer: it.from, nos, onNo, curTask: task }) : null, it.to === 'user' ? b.master : it.to)
  }
  if (it.kind === 'ask') return row('ask', h(React.Fragment, null, h('span', { className: 'k' }, `等你定 ${it.code ?? `#${it.id}`}`), it.question, it.state === 'answered' ? ` → ${it.answer}` : '（未答）'),
    h(Md, { text: [`**问题**：${it.question}`, (it.options ?? []).length ? `**选项**：${it.options.join(' / ')}` : '', it.state === 'answered' ? `**回答**：${it.answer}` : '**还没回答**'].filter(Boolean).join('\n\n'), sessions, nos, onNo, curTask: task }))
  const f = EVENT_TEXT[it.type]
  if (!f) return null
  const full = eventFull(it)
  const one = f(it.data ?? {}, it).replace(/\s+/g, ' ')
  if (it.type === 'task/linked') { // 关联：点 @X 跳到那个任务的时间线
    const other = String(it.data?.with ?? '')
    return row('event', h(React.Fragment, null, h('span', { className: 'k' }, '关联'),
      h('button', { className: 'dshm-link', 'data-link-task': other, onClick: () => setNav({ view: 'task', task: other }) }, `@${other}`), ' ', h(RefText, { text: String(it.data?.why ?? ''), nos, onNo, curTask: task })), null)
  }
  return row('event', h(React.Fragment, null, h('span', { className: 'k' }, EVENT_KIND[it.type] ?? '事件'), line(one)),
    full ? h(Md, { text: full, sessions, prefer: it.session, nos, onNo, curTask: task }) : null, it.session ?? undefined)
}

/** 会话视图（G6-3 对照 Claude 看板的会话弹窗补齐）：顶部一行汇总；每张卡片：名字 · 负责什么 · 状态标签；手上未结的任务（可点）；最近回报（时间 + 状态）；工作区。 */
function SessionsList({ sessions, now, unenrolled }: any) {
  const b = useBoard()
  const live = (s: any) => s.status === 'closed' ? `已关闭${s.closedBy ? `（${s.closedBy}）` : ''}` : s.live === 'running' ? '在线，忙' : s.live === 'idle' ? '在线，空闲' : '未加载'
  const tone = (s: any) => s.status === 'closed' ? 'mute' : s.live === 'running' ? 'run' : s.live === 'idle' ? 'ok' : 'mute'
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
  const m = sessions.find((s: any) => s.id === b.master)
  return h(React.Fragment, null,
    h('div', { className: 'dshm-grp', 'data-testid': 'dshm-sessions-summary' }, `管辖的会话：${sessions.filter((s: any) => s.role === 'exec').length} 个 · 总管 ${m ? live(m) : '—'} · 状态取自宿主，${showTime(now, now)}${unenrolled?.length ? ` · 未入编 ${unenrolled.length}` : ''}`),
    ...sessions.map((s: any) => h('div', { key: s.id, className: 'dshm-ev', 'data-session': s.id, style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
      h('div', { className: 'dshm-txt' },
        h('div', null, h('b', null, s.title), s.purpose ? h('span', { 'data-purpose': '1' }, ` · ${s.purpose}`) : null, ' ', h('span', { className: `dshm-chip ${tone(s)}`, 'data-live': '1' }, live(s))),
        h('div', { className: 'dshm-meta' }, `${s.id} · ${s.role === 'master' ? '总管' : '成员'} · 工作区 ${home(String(s.cwd ?? ''))}`),
        h('div', { className: 'dshm-meta', 'data-open-tasks': '1' }, s.open.length ? h(React.Fragment, null, '手上未结：', ...s.open.map((t: any) => { const id = t.id; return h('button', { key: id, className: 'dshm-link', 'data-task-link': id, style: { marginRight: 8 }, onClick: () => setNav({ view: 'task', task: id }) }, `${id}（${t.state}）${t.title}`) })) : '没有未结的任务'),
        h('div', { className: 'dshm-meta', 'data-last-report': '1' }, s.lastReport ? `最近回报：${showTime(s.lastReport.at, now)} ${s.lastReport.state ?? ''}${s.lastReport.task ? ` · ${s.lastReport.task}` : ''}` : '最近回报：—')),
      h('button', { className: 'dshm-btn', onClick: () => openSessionWith(s.id) }, '打开 ↗'))),
    // 未入编的会话：汇总里数了，列表里也要列出来（单独一组，能打开）
    h(Unenrolled, { list: unenrolled ?? [], now }))
}

// ---------------- 原生对话里的小部件 ----------------
/** 每轮末尾：「归到 T005 · 依据 ▸」。按会话缓存 /turns，碰到没见过的轮次最多 3 秒拉一次。 */
const turnCache = new Map<string, { at: number; turns: Map<number, any> }>()
const turnSubs = new Set<() => void>()
async function loadTurns(session: string) {
  const c = turnCache.get(session)
  if (c && Date.now() - c.at < 3000) return
  turnCache.set(session, { at: Date.now(), turns: c?.turns ?? new Map() })
  try {
    const v = await getJson(`/api/dsh-master/turns?session=${encodeURIComponent(session)}`)
    turnCache.set(session, { at: Date.now(), turns: new Map((v.turns ?? []).map((x: any) => [x.turn, x])) })
    turnSubs.forEach(f => f())
  } catch { /* 下次再拉 */ }
}
function TurnTag({ turn, sessionId }: any) {
  ensureStyle()
  const n = typeof turn === 'object' ? Number(turn?.turn) : Number(turn)
  const [, force] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => { turnSubs.add(force); return () => { turnSubs.delete(force) } }, [])
  const info = turnCache.get(sessionId)?.turns.get(n)
  React.useEffect(() => { if (!info) void loadTurns(sessionId); const t = setTimeout(() => void loadTurns(sessionId), 4000); return () => clearTimeout(t) }, [sessionId, n, !!info])
  if (!info || (!info.primary && !info.maybe?.length)) return null
  const main = info.primary?.task ?? info.maybe[0]
  return h('button', { className: 'dshm-pill', 'data-testid': 'dshm-turntag', 'data-task': main, onClick: () => openBoard(main), title: '在右侧栏打开这个任务' },
    info.primary ? h(React.Fragment, null, `第 ${n} 轮 · 归到 `, h('b', null, info.primary.task), ` · ${info.primary.why}${info.also?.length ? ` · 也提到 ${info.also.join('、')}` : ''} ▸`)
      : h(React.Fragment, null, `第 ${n} 轮 · 可能相关 `, h('b', null, info.maybe.join('、')), ' ▸'))
}
const USER_REF = new RegExp(String.raw`(?<![\w./*·-])(?:(${TASK_SRC})[·\s-](${GATE_SRC})|(Q\d{4}-\d{1,3}))(?![\w*]|[.-][A-Za-z0-9])`, 'g')
/** 用户消息里的 G / Q 标签：悬停显示标题（用最近一次看板拉到的编号表），点了打开看板并弹卡片。 */
function RefChip({ node }: any) {
  ensureStyle()
  const d = node?.data ?? {}
  const ref: Ref = d.kind === 'gate' ? { kind: 'gate', task: d.task, gate: d.gate } : { kind: 'q', code: d.code }
  return h('span', { className: 'dshm-taskref', 'data-testid': 'dshm-refchip', role: 'button', tabIndex: 0, title: refTitle(ref, lastRefs), onClick: (e: any) => { const p = at(e); openRefCard(ref, p.x, p.y) } }, `◇ ${d.text}`)
}
function TaskRefChip({ node }: any) {
  ensureStyle()
  const task = node?.data?.task; const label = node?.data?.label ?? task
  return h('span', { className: 'dshm-taskref', 'data-testid': 'dshm-taskref', role: 'button', tabIndex: 0, onClick: () => openBoard(task), title: '在右侧栏打开这个任务' }, `◆ ${label}`)
}
/** 会话标题栏的「总管看板」按钮；总管会话第一次打开时自动开看板。 */
const autoOpened = new Set<string>()
function HeaderButton({ sessionId }: any) {
  ensureStyle()
  React.useEffect(() => {
    if (!sessionId || autoOpened.has(sessionId)) return
    let alive = true; let t: any
    // 是不是总管（旧单元的 master，或者某个项目的总管）：问服务端，不再写死 master
    getJson(withSession('/api/dsh-master/whoami', sessionId)).then((v: any) => {
      if (!alive || v?.role !== 'master' || autoOpened.has(sessionId)) return
      autoOpened.add(sessionId); t = setTimeout(() => openBoard(), 600)
    }).catch(() => {})
    return () => { alive = false; clearTimeout(t) }
  }, [sessionId])
  return h('button', { className: 'dshm-hbtn', 'data-testid': 'dshm-header-board', onClick: () => openBoard(), title: '在右侧栏打开总管看板' }, '总管看板')
}
/** 左侧导航「总管看板」：没开张项目时和以前一样（打开总管会话 + 右侧栏看板）；有项目时列出来，点哪个开哪个的总管。 */
function MainRedirect() {
  ensureStyle()
  const [v, setV] = React.useState<any>()
  React.useEffect(() => { getJson('/api/dsh-master/projects').then(setV).catch(() => setV({ projects: [], legacyMaster: LEGACY_MASTER })) }, [])
  const projects: any[] = v?.projects ?? []
  // G10：legacyMaster 为 null ⇒ 没有启用旧单元（新装默认），没开张项目时给开张说明，不去打开不存在的旧总管
  const legacyOn = v ? v.legacyMaster !== null : true
  React.useEffect(() => {
    if (!v || projects.length || !legacyOn) return
    openSessionWith(v.legacyMaster ?? LEGACY_MASTER); const t = setTimeout(() => openBoard(), 900); return () => clearTimeout(t)
  }, [v])
  if (v && !projects.length && !legacyOn) return h('div', { className: 'dshm', 'data-testid': 'dshm-no-project', style: { padding: 24, height: 'auto' } },
    h('h2', { style: { fontSize: 16, margin: '0 0 8px' } }, '总管看板 · 还没有项目'),
    h('div', { className: 'dshm-meta', style: { lineHeight: 1.7 } },
      '点「新会话」，选好项目所在的文件夹，在 Agent 预设里选「dsh-master 总管」，发第一句话——这个文件夹就开张成一个项目，这个会话就是它的总管。',
      h('br'), 'Start a new session in your project folder with the “dsh-master 总管” agent preset; that folder becomes a project and the session becomes its master.'))
  if (!v || !projects.length) return h('div', { style: { padding: 24, opacity: .7 } }, '总管看板在右侧栏：正在打开总管会话……')
  return h('div', { className: 'dshm', 'data-testid': 'dshm-project-picker', style: { padding: 24, height: 'auto' } },
    h('h2', { style: { fontSize: 16, margin: '0 0 8px' } }, '总管看板 · 选一个项目'),
    h('div', { className: 'dshm-meta', style: { marginBottom: 10 } }, '每个项目有自己的总管和看板。打开项目的总管会话，看板在右侧栏。'),
    ...projects.map((p: any) => { const m = p.master; return h('button', { key: p.id, className: 'dshm-row', 'data-project': p.id, onClick: () => { openSessionWith(m); setTimeout(() => openBoard(), 900) } },
      h('span', { className: 'dshm-rid' }, p.id), h('span', { className: 'dshm-rt' }, p.root), h('span', { className: 'dshm-chip run' }, '打开 ↗')) }),
    !legacyOn ? null : h('button', { className: 'dshm-row', 'data-project': '-', onClick: () => { openSessionWith(v.legacyMaster ?? LEGACY_MASTER); setTimeout(() => openBoard(), 900) } },
      h('span', { className: 'dshm-rid' }, '旧总管'), h('span', { className: 'dshm-rt' }, '没开张成项目之前的总管和任务'), h('span', { className: 'dshm-chip mute' }, '打开 ↗')))
}
function Icon({ size }: { size?: number }) {
  const s = size ?? 20
  return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
    h('rect', { x: 3.5, y: 4, width: 17, height: 16, rx: 3 }), h('path', { d: 'M8 9h8M8 13h5M8 17h7' }))
}

// ---------------- @ 任务候选源 ----------------
/** 历史消息里的 @任务：引用块原文 `@[标签](dsh-master-task:ID)`，或纯文字 `@ID`（手打的；插件在 pre-step 把引用块改写成这种，存进会话记录的就是它）。 */
const TASK_LINK = /@\[([^\]\n]{1,160})\]\(dsh-master-task:((?:T\d{3,}|L\d{4}-\d+))\)|(?<![\w@\[/])@((?:T\d{3,}|L\d{4}-\d+))(?![\w-])/g
const candCache = new Map<string, { at: number; tasks: any[] }>()
async function loadCandidates(session: string): Promise<any[]> {
  const c = candCache.get(session)
  if (c && Date.now() - c.at < 5000) return c.tasks
  const v = await getJson(`/api/dsh-master/candidates?session=${encodeURIComponent(session)}`)
  candCache.set(session, { at: Date.now(), tasks: v.tasks ?? [] }); return v.tasks ?? []
}
export function taskSource() {
  return {
    trigger: '@', name: 'dsh-master-tasks', order: -1,
    async candidates(session: any, { query }: any) {
      const q = String(query ?? '').toLowerCase()
      const list = await loadCandidates(session.sessionId).catch(() => [])
      return list.filter((t: any) => !q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)).slice(0, 20)
        .map((t: any) => ({ name: t.id, label: `${t.id} ${t.title}`, description: `${t.state} · ${t.owner}`, section: '任务', value: t.id }))
    },
    onPick({ candidate }: any) {
      return { insert: { source: 'dsh-master-tasks', ref: candidate.value, label: String(candidate.label ?? candidate.value).slice(0, 60), clipboardText: `@${candidate.value}` } }
    },
    warm(session: any) { void loadCandidates(session.sessionId).catch(() => {}) },
    lexicon(session: any) { return candCache.get(session.sessionId)?.tasks.map((t: any) => t.id) },
    openReference(_s: any, { ref }: any) { openBoard(ref); return true },
    codec: { clipboardText: (ref: string) => `@${ref}`, serialize: (ref: string) => Promise.resolve(`@[${ref}](dsh-master-task:${ref})`) },
  }
}

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'inputTriggers', 'uiConversation', 'sessions', 'uiWorkspace']
export function apply(ctx: Ctx): void {
  rootCtx = ctx
  ensureStyle()
  // 右侧栏标签 + 「开始」页入口
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: BOARD_KIND, priority: 'extension', title: () => '总管看板',
    guide: [{ id: 'board', order: 5, title: () => '总管看板', description: () => '任务列表、时间线、等你定' }] }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, inject: (sessionId: string) => ({ sessionId }) }, Board))
  // @ 任务
  ctx.effect(() => ctx.inputTriggers.registerSource(taskSource()))
  ctx.uiConversation.userText.register({ id: 'dsh-master-task', order: 20, match(text: string, from: number) {
    TASK_LINK.lastIndex = from; const m = TASK_LINK.exec(text)
    return m ? { id: 'dsh-master-task', start: m.index, end: m.index + m[0].length, data: { label: m[1] ?? m[3], task: m[2] ?? m[3] } } : undefined
  } })
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({ name: 'conversation.user.text.node', key: 'dsh-master-task', priority: 100 }, TaskRefChip))
  // G6-3：用户自己发的消息里的跨任务闸门编号（T013·G14）和 Q 编号（光写的 G14 不知道是哪个任务的，不认）
  ctx.uiConversation.userText.register({ id: 'dsh-master-ref', order: 21, match(text: string, from: number) {
    USER_REF.lastIndex = from; const m = USER_REF.exec(text)
    return m ? { id: 'dsh-master-ref', start: m.index, end: m.index + m[0].length, data: m[1] ? { kind: 'gate', task: m[1], gate: m[2], text: m[0] } : { kind: 'q', code: m[3], text: m[0] } } : undefined
  } })
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({ name: 'conversation.user.text.node', key: 'dsh-master-ref', priority: 100 }, RefChip))
  // 每轮末尾小标签、会话标题栏按钮
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'dsh-master', inject: (sessionId: string) => ({ sessionId }) }, TurnTag))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-master-board', order: -4, inject: (sessionId: string) => ({ sessionId }) }, HeaderButton))
  // 左侧导航入口
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-master', inject: () => ({}) }, MainRedirect))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-master', order: 5, label: () => '总管看板' }, Icon))
}
