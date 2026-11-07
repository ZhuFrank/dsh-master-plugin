/**
 * G6-2 — 开张与团队：单元级用例（开张的整条链路在 e2e/g6-2-projects.e2e.test.ts）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'
import { Store } from '../src/store.ts'
import { Core } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { rolePrompt } from '../src/prompts.ts'
import { ProjectRegistry, gitExclude, claimOwner, projectDotDir } from '../src/projects.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

const gitInit = (d: string) => { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) }

describe('G6-2 开张用到的小工具', () => {
  it('gitExclude：写一行 /.dsh-master/ 到 .git/info/exclude，已经有就不重复；不是 git 仓库就跳过', () => {
    const repo = gitInit(path.join(tmpdir('ex'), 'r'))
    const f = gitExclude(repo)!
    expect(f).toBe(path.join(repo, '.git', 'info', 'exclude'))
    gitExclude(repo)
    expect(fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim() === '/.dsh-master/')).toHaveLength(1)
    // 写进去以后 git 真的不再列出 .dsh-master/
    fs.mkdirSync(path.join(repo, '.dsh-master', 'docs'), { recursive: true }); fs.writeFileSync(path.join(repo, '.dsh-master', 'docs', 'a.md'), 'x')
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })).toBe('')
    expect(gitExclude(tmpdir('plain'))).toBeUndefined()
  })
  it('claimOwner：没人占就写上自己；同一个实例重开照样可以；别的实例（状态目录不同）占着就返回占用者', () => {
    const root = tmpdir('own')
    expect(claimOwner(root, '/state/a')).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(path.join(projectDotDir(root), 'owner'), 'utf8')).stateDir).toBe('/state/a')
    expect(claimOwner(root, '/state/a/')).toBeUndefined()
    expect(claimOwner(root, '/state/b')).toMatchObject({ stateDir: '/state/a' })
  })
  it('登记时记下真正的总管会话 ID（用户自己建的会话是宿主起的 ID）', () => {
    const base = tmpdir('reg'); const repo = gitInit(path.join(base, 'alpha'))
    const reg = new ProjectRegistry(path.join(base, 'projects.db'), fakeClock())
    expect(reg.ensure(repo, 'session-abc')).toMatchObject({ id: 'alpha', master: 'session-abc' })
    expect(reg.ensure(repo, 'session-xyz').master).toBe('session-abc') // 已登记的不改
  })
})

describe('G6-2 成员的工作目录固定是项目根', () => {
  async function setup() {
    const root = gitInit(path.join(tmpdir('team'), 'alpha')); const clock = fakeClock()
    const store = new Store(path.join(tmpdir('team-db'), 'm.db'))
    const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 1000, masterId: 'session-m', memberPrefix: 'alpha.', projectRoot: root })
    await core.ensureMaster(root)
    return { core, store, root }
  }
  const spawn = (core: Core) => core.toolsFor('session-m').find(t => t.name === 'master_spawn')!
  it('不给 cwd：用项目根；成员 ID 是 <项目>.<名字>；工具说明和参数里没有 cwd', async () => {
    const s = await setup()
    const t = spawn(s.core)
    expect((t.parameters as any).required).toEqual(['name', 'title'])
    expect((t.parameters as any).properties.cwd).toBeUndefined()
    expect(t.description).toContain('alpha.<name>'); expect(t.description).toContain(`工作目录固定是项目根 ${s.root}`)
    expect(await t.run({ name: 'x', title: 'X' }, 'session-m')).toMatchObject({ id: 'alpha.x' })
    expect(s.store.getSession('alpha.x')!.cwd).toBe(s.root)
  })
  it('给了别的 cwd：拒绝；给的正好是项目根：可以', async () => {
    const s = await setup()
    await expect(spawn(s.core).run({ name: 'x', title: 'X', cwd: '/tmp' }, 'session-m')).rejects.toThrow(/固定是项目根/)
    expect(await spawn(s.core).run({ name: 'y', title: 'Y', cwd: s.root }, 'session-m')).toMatchObject({ id: 'alpha.y' })
  })
  it('旧单元（没给项目根）：照旧必须给 cwd', async () => {
    const clock = fakeClock(); const store = new Store(path.join(tmpdir('old'), 'm.db'))
    const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 1000 })
    await core.ensureMaster(tmpdir('mw'))
    const t = core.toolsFor('master').find(x => x.name === 'master_spawn')!
    expect((t.parameters as any).required).toEqual(['name', 'cwd', 'title'])
    await expect(t.run({ name: 'x', title: 'X' }, 'master')).rejects.toThrow(/缺少参数 cwd/)
  })
})

describe('G6-2 守则：编号第一次出现时带简称', () => {
  it('总管和成员的系统提示里都有', () => {
    for (const role of ['master', 'exec'] as const) expect(rolePrompt(role, 'x')).toMatch(/第一次提到任务 \/ 闸门 \/ 等你定的编号时，后面括号写一个简称/)
  })
})
