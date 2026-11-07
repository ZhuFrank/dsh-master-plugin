/**
 * G6-4 软认领：派活时写明这件任务要改的文件 / 目录（项目制下用）。
 * - 同一项目里两个成员的有效认领不能重叠（一个是另一个的上级目录也算），重叠要总管写理由；
 * - 成员 write / edit、bash 里能看出的写目标，落在别的成员的有效认领里 ⇒ 拦下，告诉它是谁认领的；
 * - 有效 = 任务没完成、负责的成员没关闭。任务完成或成员关闭，认领就自动失效。
 * bash 跑脚本写文件（python / node 脚本里写）看不出来，只能靠守则；这是「软」认领。
 */
import path from 'node:path'

export interface Claim { task: string; owner: string; paths: string[]; at: string; reason?: string | undefined }

export function under(file: string, dir: string): boolean {
  const rel = path.relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
/** 两个认领路径重叠：相同，或一个在另一个下面。 */
export const overlaps = (a: string, b: string) => under(a, b) || under(b, a)

/** 派活参数里的 claims → 绝对路径（相对路径按项目根解析；必须在项目根里面、不能是项目根本身、不能是 .dsh-master/ 状态目录）。 */
export function normClaims(raw: unknown, root: string): string[] {
  if (raw === undefined || raw === null) return []
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，、\n]/) : null
  if (!list) throw new Error('claims 要写成路径列表，比如 ["src/panel/", "docs/a.md"]')
  const out: string[] = []
  for (const x of list) {
    if (typeof x !== 'string') throw new Error('claims 里每一项都要是路径字符串')
    const t = x.trim(); if (!t) continue
    const abs = path.resolve(root, t).replace(/\/+$/, '')
    if (!under(abs, root)) throw new Error(`认领只能是项目根 ${root} 里面的文件或目录：${t}`)
    if (abs === root) throw new Error('不能认领整个项目根（写具体的目录或文件）')
    if (under(abs, path.join(root, '.dsh-master')) && !under(abs, path.join(root, '.dsh-master', 'out'))) throw new Error('.dsh-master/ 是总管状态目录，不能认领（产物目录 .dsh-master/out/ 可以）')
    if (!out.includes(abs)) out.push(abs)
  }
  if (out.length > 20) throw new Error('一次最多认领 20 个路径（认领上级目录就行）')
  return out
}

/** 新认领和别人有效认领的重叠：[新路径, 别人的认领] 列表。 */
export function conflictsWith(paths: string[], owner: string, task: string, active: Claim[]): Array<{ path: string; claim: Claim; other: string }> {
  const out: Array<{ path: string; claim: Claim; other: string }> = []
  for (const c of active) {
    if (c.owner === owner || c.task === task) continue
    for (const p of paths) for (const q of c.paths) if (overlaps(p, q)) out.push({ path: p, claim: c, other: q })
  }
  return out
}

/** 要写的文件落在别的成员的有效认领里 ⇒ 那条认领（和命中的路径）。 */
export function claimHit(target: string, caller: string, active: Claim[]): { claim: Claim; path: string } | undefined {
  for (const c of active) {
    if (c.owner === caller) continue
    const p = c.paths.find(q => under(target, q))
    if (p) return { claim: c, path: p }
  }
  return undefined
}

export const rel = (root: string, p: string) => { const r = path.relative(root, p); return r && !r.startsWith('..') ? r : p }

export function denyText(target: string, hit: { claim: Claim; path: string }, root: string): string {
  return `[dsh-master 认领] ${rel(root, target)} 在 ${hit.claim.task} 的认领范围里（负责的是 ${hit.claim.owner}，认领了 ${rel(root, hit.path)}）。` +
    `不要改，也不要换个写法（bash / 脚本）绕过去：用 master_report(state=受阻) 告诉总管你要改哪个文件、为什么，由总管协调。`
}

/** 宿主文件工具的冲突报错（乐观锁）：FS_STALE_VERSION（别人改过）/ FS_NOT_OBSERVED（没读过就改）。 */
export function fsConflict(text: string): 'stale' | 'unread' | undefined {
  if (/FS_STALE_VERSION|changed since it was read|file no longer exists/.test(text)) return 'stale'
  if (/FS_NOT_OBSERVED|without reading it first|requires reading/.test(text)) return 'unread'
  return undefined
}
export const CONFLICT_HINT: Record<'stale' | 'unread', string> = {
  stale: '[dsh-master 提示] 这个文件在你读过以后被改过了（可能是同一项目里的另一个成员）。你的修改没有写进去。先用 read 重读，把你要做的改动放到新内容上再改；不要用 bash 直接覆盖，那样会把别人的改动冲掉。改的是别人认领的文件就先找总管。',
  unread: '[dsh-master 提示] 宿主要求先读再改：先用 read 读这个文件，再在读到的内容上改。文件已经存在，说明可能是别人刚建的，读完确认不会覆盖别人的内容再写。',
}
