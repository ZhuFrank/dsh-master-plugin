/**
 * 测试护栏（G6-5）：端到端的沙盒和工作目录不能放在任何 git 仓库里。
 * 插件开张时会顺着会话的工作目录往上找仓库根；目录在 ~/dsh_master 里，出错时就会写进真实的 ~/dsh_master
 * （11-06 真出过一次：往 ~/dsh_master 写了 .dsh-master/ 和 .git/info/exclude 两行）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 端到端的总目录：主目录下、仓库外。不放 /tmp：「工作区内修改」的沙盒放行临时目录，测「往项目外写被拒」会失真。 */
export const E2E_ROOT = process.env.DSH_E2E_ROOT?.trim() || path.join(os.homedir(), 'dsh-master-e2e')
export const E2E_SANDBOX = path.join(E2E_ROOT, 'sandbox')
export const E2E_WORK = path.join(E2E_ROOT, 'work')

/** dir（含它自己）往上第一个有 .git 的目录；没有就 undefined。 */
export function gitAncestor(dir: string): string | undefined {
  let cur = path.resolve(dir)
  while (!fs.existsSync(cur)) { const up = path.dirname(cur); if (up === cur) break; cur = up }
  try { cur = fs.realpathSync(cur) } catch { /* 用原路径 */ }
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur
    const up = path.dirname(cur); if (up === cur) return undefined
    cur = up
  }
}
export function assertOutsideRepos(dir: string, what = '端到端目录'): void {
  const repo = gitAncestor(dir)
  if (repo) throw new Error(`[测试护栏] ${what} ${dir} 在 git 仓库 ${repo} 里：插件开张会顺着目录往上找到这个仓库并往里写。端到端目录要放在仓库外（默认 ${E2E_ROOT}）`)
}

/** 真实仓库的快照：.dsh-master/ 在不在、.git/info/exclude 的内容。端到端前后各拍一次，必须一样。 */
export function repoFootprint(repo: string): string {
  const dot = fs.existsSync(path.join(repo, '.dsh-master'))
  let exclude = ''; try { exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8') } catch { /* 没有 */ }
  return JSON.stringify({ dotDshMaster: dot, exclude })
}
