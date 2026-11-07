/**
 * G8：端到端自己清理现场。旧位置 ~/dsh_master/.tmp/e2e-work 留了 588 轮、13G（几乎全是无头 Chrome 的用户目录），从来没人删。
 * 用法见 e2e/repo-guard.setup.ts：一个测试文件全部通过 ⇒ 删掉它跑的时候在端到端总目录下新建的目录；有失败 ⇒ 留着排查；
 * 每个文件开跑前 ⇒ 每个根目录只留最近 keep 个（失败留下的），更早的删掉。
 * 端到端是串行跑的（fileParallelism: false），「这次新建的」就是这个文件建的；为了不误删别的进程正在用的目录，pruneOld 只删放了 minAgeMs 以上的。
 */
import fs from 'node:fs'
import path from 'node:path'

const dirsOf = (root: string) => { try { return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(root, e.name)) } catch { return [] } }

/** 删掉各根目录下、创建时间不早于 sinceMs 的目录（含里面的东西），返回删了哪些。 */
export function removeCreatedSince(roots: string[], sinceMs: number): string[] {
  const out: string[] = []
  for (const root of roots) for (const d of dirsOf(root)) {
    const st = fs.statSync(d)
    if (st.birthtimeMs >= sinceMs) { fs.rmSync(d, { recursive: true, force: true }); out.push(d) }
  }
  return out
}

/** 每个根目录按修改时间留最近 keep 个；更早的、而且 minAgeMs 以上没动过的删掉。返回删了哪些。 */
export function pruneOld(roots: string[], opts: { keep: number; minAgeMs: number; now?: number }): string[] {
  const now = opts.now ?? Date.now()
  const out: string[] = []
  for (const root of roots) {
    const list = dirsOf(root).map(d => ({ d, m: fs.statSync(d).mtimeMs })).sort((a, b) => b.m - a.m)
    for (const { d, m } of list.slice(opts.keep)) if (now - m > opts.minAgeMs) { fs.rmSync(d, { recursive: true, force: true }); out.push(d) }
  }
  return out
}
