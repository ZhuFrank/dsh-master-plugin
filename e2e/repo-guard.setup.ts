/**
 * 测试护栏（G6-5）：每个端到端文件前后都看一眼真实的 ~/dsh_master——.dsh-master/ 在不在、.git/info/exclude 有没有被改，
 * 前后必须一样；端到端总目录必须在仓库外。
 */
import path from 'node:path'
import { beforeAll, afterAll } from 'vitest'
import { repoFootprint, assertOutsideRepos, E2E_ROOT, E2E_WORK, E2E_SANDBOX, removeCreatedSince, pruneOld } from '@dsh-master/testkit'

const REPO = path.resolve(import.meta.dirname, '..')
let before = ''
// G8：自己清理现场——开跑前每个根目录只留最近 5 个（失败留下的），更早的、半小时以上没动过的删掉；
// 这个文件的测试全部通过 ⇒ 删掉它跑的时候新建的目录（after 钩子倒序执行，这里在测试文件自己的 afterAll（关沙盒）之后才跑）；有失败 ⇒ 留着排查。
const ROOTS = [E2E_WORK, E2E_SANDBOX]
let startedAt = 0
beforeAll(() => {
  assertOutsideRepos(E2E_ROOT, '端到端总目录'); before = repoFootprint(REPO)
  const pruned = pruneOld(ROOTS, { keep: 5, minAgeMs: 30 * 60_000 })
  if (pruned.length) console.log(`[清理] 删掉 ${pruned.length} 个旧的端到端目录`)
  startedAt = Date.now()
})
const failed = (t: any): boolean => t?.result?.state === 'fail' || (t?.tasks ?? []).some(failed)
afterAll(({}, file: any) => {
  if (failed(file)) { console.log('[清理] 有失败，这次的端到端目录留着排查'); return }
  const removed = removeCreatedSince(ROOTS, startedAt)
  if (removed.length) console.log(`[清理] 通过，删掉这次新建的 ${removed.length} 个目录`)
})
afterAll(() => {
  const after = repoFootprint(REPO)
  if (after !== before) throw new Error(`[测试护栏] 这个端到端改了真实仓库 ${REPO}：前 ${before} ｜后 ${after}。先恢复（删 .dsh-master/、还原 .git/info/exclude），再查哪个会话开张到了这里`)
})
