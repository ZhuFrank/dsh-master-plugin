/**
 * G6-4 — 并发与权限：软认领、守卫（成员不提交、产物目录放行）、worktree 成员、成员权限预设、冲突提示、守则。
 * 两个成员同时改同一个文件的整条链路在 e2e/g6-4-concurrency.e2e.test.ts。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'
import { Store } from '../src/store.ts'
import { Core, sameRepoWorktree } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Attribution } from '../src/attrib.ts'
import { PanelService } from '../src/panel-service.ts'
import { guardDecision, NO_GIT } from '../src/guard.ts'
import { normClaims, claimHit, conflictsWith, fsConflict, denyText } from '../src/claims.ts'
import { rolePrompt } from '../src/prompts.ts'
import { MemoryLayer } from 'dsh-master-devlog'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
function repo() {
  const d = path.join(tmpdir('g64'), 'alpha'); fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d])
  fs.writeFileSync(path.join(d, 'README.md'), 'x\n'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'init')
  return fs.realpathSync(d)
}
class SpyPort extends FakeSessionPort { presets: Array<[string, string | undefined]> = []; override async ensureSession(input: any) { this.presets.push([input.id, input.preset]); return super.ensureSession(input) } }

async function setup(opts: { project?: boolean } = { project: true }) {
  const root = repo(); const clock = fakeClock(); const dir = tmpdir('g64db')
  const store = new Store(path.join(dir, 'm.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'mem.db'), docsRoot: path.join(dir, 'docs'), clock })
  const port = new SpyPort()
  const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), port, clock,
    { idleGraceMs: 1000, mem, ...(opts.project ? { masterId: 'session-m', memberPrefix: 'alpha.', projectRoot: root } : {}) })
  await core.ensureMaster(root)
  const m = opts.project ? 'session-m' : 'master'
  const tool = (who: string, name: string) => (a: unknown) => core.toolsFor(who).find(t => t.name === name)!.run(a, who)
  const panel = new PanelService(store, core, new Attribution(store, core, clock), { promptUser: async () => {}, turnText: async () => undefined } as any, clock)
  return { root, store, core, tool, port, panel, m }
}

describe('G6-4 认领路径', () => {
  it('相对路径按项目根解析；项目外、项目根本身、.dsh-master/（out/ 除外）不能认领；去重', () => {
    const r = '/p/alpha'
    expect(normClaims(['src/a/', 'docs/x.md', '/p/alpha/src/a'], r)).toEqual(['/p/alpha/src/a', '/p/alpha/docs/x.md'])
    expect(normClaims('src/a, src/b', r)).toEqual(['/p/alpha/src/a', '/p/alpha/src/b'])
    expect(() => normClaims(['../beta/x'], r)).toThrow(/项目根/)
    expect(() => normClaims(['.'], r)).toThrow(/整个项目根/)
    expect(() => normClaims(['.dsh-master/docs'], r)).toThrow(/状态目录/)
    expect(normClaims(['.dsh-master/out/T013'], r)).toEqual(['/p/alpha/.dsh-master/out/T013'])
  })
  it('重叠：相同或一个在另一个下面；自己的、同一件任务的不算', () => {
    const active = [{ task: 'L1', owner: 'alpha.x', paths: ['/p/src/a'], at: '' }]
    expect(conflictsWith(['/p/src/a/f.ts'], 'alpha.y', 'L2', active).map(c => c.claim.task)).toEqual(['L1'])
    expect(conflictsWith(['/p/src'], 'alpha.y', 'L2', active)).toHaveLength(1)
    expect(conflictsWith(['/p/src/ab'], 'alpha.y', 'L2', active)).toHaveLength(0) // 前缀相同不算
    expect(conflictsWith(['/p/src/a'], 'alpha.x', 'L3', active)).toHaveLength(0)
    expect(claimHit('/p/src/a/z.ts', 'alpha.y', active)?.claim.task).toBe('L1')
    expect(claimHit('/p/src/a/z.ts', 'alpha.x', active)).toBeUndefined()
    expect(denyText('/p/src/a/z.ts', claimHit('/p/src/a/z.ts', 'alpha.y', active)!, '/p')).toMatch(/src\/a\/z\.ts 在 L1 的认领范围里（负责的是 alpha\.x，认领了 src\/a）/)
  })
})

describe('G6-4 派活带认领', () => {
  it('不重叠都能派；重叠被拒并说出是谁；写了理由才放行，两边时间线各记一条', async () => {
    const s = await setup()
    for (const n of ['x', 'y']) await s.tool(s.m, 'master_spawn')({ name: n, title: n })
    await s.tool(s.m, 'master_dispatch')({ task: 'L1106-1', kind: 'light', title: 'a', to: 'x', text: 't', claims: ['src/a/'] })
    await s.tool(s.m, 'master_dispatch')({ task: 'L1106-2', kind: 'light', title: 'b', to: 'y', text: 't', claims: ['src/b/'] })
    await expect(s.tool(s.m, 'master_dispatch')({ task: 'L1106-3', kind: 'light', title: 'c', to: 'y', text: 't', claims: ['src/a/f.ts'] }))
      .rejects.toThrow(/认领重叠：src\/a\/f\.ts 和 L1106-1（alpha\.x）认领的 src\/a/)
    expect(s.store.getTask('L1106-3')).toBeUndefined()
    await s.tool(s.m, 'master_dispatch')({ task: 'L1106-3', kind: 'light', title: 'c', to: 'y', text: 't', claims: ['src/a/f.ts'], claims_reason: '只改一行常量' })
    for (const t of ['L1106-1', 'L1106-3']) expect(s.store.events({ task: t, type: 'claims/overlap' }).map(e => JSON.parse(e.data).reason)).toEqual(['只改一行常量'])
    expect(s.core.activeClaims().map(c => [c.task, c.owner])).toEqual([['L1106-1', 'alpha.x'], ['L1106-2', 'alpha.y'], ['L1106-3', 'alpha.y']])
    // 派活说明里写着认领
    expect(JSON.parse(s.store.getTask('L1106-1')!.meta)['认领']).toMatch(/^src\/a（只改这些/)
  })
  it('写别人认领的文件被拦；自己的、总管、没认领的放行；任务完成或成员关闭后认领失效', async () => {
    const s = await setup()
    for (const n of ['x', 'y']) await s.tool(s.m, 'master_spawn')({ name: n, title: n })
    await s.tool(s.m, 'master_dispatch')({ task: 'L1106-1', kind: 'light', title: 'a', to: 'x', text: 't', claims: ['src/a/'] })
    await s.tool(s.m, 'master_dispatch')({ task: 'L1106-2', kind: 'light', title: 'b', to: 'y', text: 't', claims: ['src/b/'] })
    const f = path.join(s.root, 'src/a/1.ts')
    expect(s.core.claimHitFor('alpha.y', f)?.claim).toMatchObject({ task: 'L1106-1', owner: 'alpha.x' })
    expect(s.core.claimHitFor('alpha.x', f)).toBeUndefined()
    expect(s.core.claimHitFor('session-m', f)).toBeUndefined()
    expect(s.core.claimHitFor('alpha.y', path.join(s.root, 'README.md'))).toBeUndefined()
    // 再派下一个闸门不写 claims：沿用
    await s.tool(s.m, 'master_dispatch')({ task: 'L1106-1', kind: 'light', title: 'a', to: 'x', text: '再补一处' })
    expect(s.core.claimHitFor('alpha.y', f)?.claim.paths).toEqual([path.join(s.root, 'src/a')])
    expect(s.store.events({ task: 'L1106-1', type: 'task/dispatched' }).map(e => JSON.parse(e.data).claims ?? null)).toEqual([['src/a'], null])
    await s.tool('alpha.x', 'master_report')({ task: 'L1106-1', state: '完成', action: '好了' })
    expect(s.core.claimHitFor('alpha.y', f)).toBeUndefined()
    await s.tool(s.m, 'master_close')({ name: 'y' })
    expect(s.core.claimHitFor('alpha.x', path.join(s.root, 'src/b/1.ts'))).toBeUndefined()
    // 看板任务详情显示认领（已失效）
    expect(s.panel.thread('L1106-1').task!.claims).toEqual({ paths: ['src/a'], active: false, reason: null })
    expect(s.panel.thread('L1106-2').task!.claims).toMatchObject({ paths: ['src/b'], active: false })
  })
  it('旧单元（不是项目）：派活没有 claims 参数，也不拦', async () => {
    const s = await setup({ project: false })
    const t = s.core.toolsFor('master').find(x => x.name === 'master_dispatch')!
    expect((t.parameters as any).properties.claims).toBeUndefined()
    await s.tool('master', 'master_spawn')({ name: 'x', cwd: s.root, title: 'x' })
    expect(s.core.claimHitFor('exec-x', path.join(s.root, 'a'))).toBeUndefined()
  })
})

describe('G6-4 守卫：成员不提交、产物目录放行', () => {
  const root = '/p/alpha', dot = '/p/alpha/.dsh-master', out = '/p/alpha/.dsh-master/out'
  const cfg = { protectedPaths: ['/state', dot], allowPaths: [out], env: {}, noGit: true }
  const bash = (command: string, role: 'exec' | 'master' = 'exec', c: Partial<typeof cfg> = {}) => guardDecision({ name: 'bash', args: { command }, role, cwd: root }, { ...cfg, ...c })
  it('项目成员：git add / commit / push / 切分支被拦；只读的 status / diff / log、单文件 checkout -- 放行', () => {
    for (const c of ['git commit -am x', 'git add .', 'cd sub && git add -A', 'git -C /p/alpha commit -m x', 'git push', 'git checkout main', 'git switch -c x', 'git stash', 'git reset --hard'])
      expect(bash(c), c).toBe(NO_GIT)
    for (const c of ['git status', 'git diff HEAD', 'git log --oneline -3', 'git show HEAD', 'git checkout -- a.txt', 'echo "git commit"'])
      expect(bash(c), c).toBeUndefined()
  })
  it('总管、不是项目成员（noGit 没开）的照旧能提交', () => {
    expect(bash('git commit -am x', 'master')).toBeUndefined()
    expect(bash('git commit -am x', 'exec', { noGit: false })).toBeUndefined()
  })
  it('.dsh-master/out/ 能写（write 工具、bash 重定向、cp 进去），.dsh-master/ 其余照拦，out 前缀相同的别的目录也拦', () => {
    const w = (file_path: string) => guardDecision({ name: 'write', args: { file_path, content: 'x' }, role: 'exec', cwd: root }, cfg)
    expect(w(`${out}/T013/r.md`)).toBeUndefined()
    expect(w(`${dot}/docs/x.md`)).toMatch(/守卫/)
    expect(bash(`echo x > ${out}/r.md`)).toBeUndefined()
    expect(bash('echo x > .dsh-master/out/r.md')).toBeUndefined()
    expect(bash('cp a.md .dsh-master/out/T1/')).toBeUndefined()
    expect(bash(`echo x > ${dot}/outx/r.md`)).toMatch(/守卫/)
    // 以 - 开头的参数不进相对路径那一层，只能靠路径边界判断挡住
    expect(bash(`cp a.md --target-directory=${dot}/outx/`)).toMatch(/守卫/)
    expect(bash(`cp a.md --target-directory=${out}/T1/`)).toBeUndefined()
    expect(bash('echo x > .dsh-master/docs/r.md')).toMatch(/守卫/)
    expect(bash(`cp ${out}/a.md ${dot}/docs/b.md`)).toMatch(/守卫/)
  })
})

describe('G6-4 成员权限、worktree、冲突提示、守则', () => {
  it('项目成员建会话时用「工作区内修改」预设；旧单元不传（用插件默认）', async () => {
    const s = await setup()
    await s.tool(s.m, 'master_spawn')({ name: 'x', title: 'x' })
    expect(s.port.presets.find(p => p[0] === 'alpha.x')![1]).toBe('workspace-write')
    const o = await setup({ project: false })
    await o.tool('master', 'master_spawn')({ name: 'x', cwd: o.root, title: 'x' })
    expect(o.port.presets.find(p => p[0] === 'exec-x')![1]).toBeUndefined()
  })
  it('worktree：同一仓库的 worktree 可以当成员工作目录（记下来）；别的目录、别的仓库照拒', async () => {
    const s = await setup()
    const wt = path.join(path.dirname(s.root), 'alpha-wt'); git(s.root, 'worktree', 'add', '-q', wt, '-b', 'wt/T020')
    expect(sameRepoWorktree(fs.realpathSync(wt), s.root)).toBe(true)
    expect(await s.tool(s.m, 'master_spawn')({ name: 'big', title: '大重构', cwd: wt })).toMatchObject({ id: 'alpha.big', worktree: wt })
    expect(s.store.getMeta('worktree:alpha.big')).toBe(wt)
    expect(s.store.getSession('alpha.big')!.cwd).toBe(wt)
    await expect(s.tool(s.m, 'master_spawn')({ name: 'z', title: 'z', cwd: path.join(s.root, 'sub-not-wt') })).rejects.toThrow(/固定是项目根/)
    await expect(s.tool(s.m, 'master_spawn')({ name: 'z', title: 'z', cwd: repo() })).rejects.toThrow(/固定是项目根/)
  })
  it('宿主文件冲突报错认得出：别人改过 / 没读过；别的错不算', () => {
    expect(fsConflict('FsError: cannot edit "f.txt": file changed since it was read')).toBe('stale')
    expect(fsConflict('FS_STALE_VERSION')).toBe('stale')
    expect(fsConflict('cannot overwrite existing "n.txt" without reading it first')).toBe('unread')
    expect(fsConflict('edit requires reading "a" first')).toBe('unread')
    expect(fsConflict('file access denied under workspace-write mode')).toBeUndefined()
  })
  it('守则：项目总管写认领 / 统一提交 / 产物目录 / worktree 何时开何时收；成员写认领、先读再改、不提交；worktree 成员另一段', () => {
    const m = rolePrompt('master', 'session-m', 'h', 'session-m', { root: '/p/alpha' })
    for (const k of ['claims', '统一 git 提交', '/p/alpha/.dsh-master/out/', '只在大重构时临时用', 'git worktree remove']) expect(m).toContain(k)
    const e = rolePrompt('exec', 'alpha.x', 'h', 'session-m', { root: '/p/alpha' })
    for (const k of ['认领', 'FS_STALE_VERSION', '不 git add / commit', '/p/alpha/.dsh-master/out/', '等你批']) expect(e).toContain(k)
    expect(rolePrompt('exec', 'alpha.big', 'h', 'session-m', { root: '/p/alpha', worktree: '/p/alpha-wt' })).toMatch(/临时 worktree 里[\s\S]*可以在你的分支上提交/)
    expect(rolePrompt('exec', 'exec-x', 'h')).not.toContain('认领')
  })
})
