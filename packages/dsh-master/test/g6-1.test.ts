/**
 * G6-1 — 数据层：项目登记、按项目分库、总管 ID 按项目、闸门定义表、等你定 Q 编号、v3 → v4 迁移与回退。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { describe, it, expect } from 'vitest'
import { Store, SCHEMA_VERSION } from '../src/store.ts'
import { Core, parseGates } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Patrol } from '../src/patrol.ts'
import { rolePrompt } from '../src/prompts.ts'
import { ProjectRegistry, findProjectRoot, slugOf, openProject, projectPaths, type ProjectContext } from '../src/projects.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

const gitInit = (d: string) => { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) }
const SPEC = { task: 'T001', title: '数据层', expected: '1 天', output: '/tmp/out', resume: '读任务书', 目标: '分库', 要读的: '无', 交付物: 'x', 验收标准: '有读数', 红线: '不碰 3090',
  gates: [{ id: 'G6-1', title: '数据层', produces: 'packages/dsh-master/src/projects.ts' }, { id: 'G6-2', title: '开张与团队' }] }
const tool = (c: ProjectContext, who: string, name: string) => (a: unknown) => c.core.toolsFor(who).find(t => t.name === name)!.run(a, who)

function twoProjects() {
  const base = tmpdir('g61'); const clock = fakeClock()
  const rootA = gitInit(path.join(base, 'one', 'app')), rootB = gitInit(path.join(base, 'two', 'app')) // 同名目录 ⇒ 第二个加哈希
  const stateDir = path.join(base, 'state')
  const reg = new ProjectRegistry(path.join(stateDir, 'projects.db'), clock)
  const dp = new FakeDeliveryPort(), sp = new FakeSessionPort()
  const A = openProject(stateDir, reg.ensure(rootA), { deliveryPort: dp, sessionPort: sp, clock })
  const B = openProject(stateDir, reg.ensure(path.join(rootB)), { deliveryPort: dp, sessionPort: sp, clock })
  return { base, clock, reg, dp, sp, A, B, rootA, rootB, stateDir }
}

describe('G6-1 项目登记', () => {
  it('项目根：往上找 .git（目录或 worktree 的 .git 文件）；不在仓库里就是目录自己', () => {
    const base = tmpdir('root'); const repo = gitInit(path.join(base, 'repo'))
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
    expect(findProjectRoot(path.join(repo, 'src', 'deep'))).toBe(repo)
    const wt = path.join(base, 'wt'); fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /x\n')
    expect(findProjectRoot(wt)).toBe(fs.realpathSync(wt))
    const plain = path.join(base, 'plain'); fs.mkdirSync(plain)
    expect(findProjectRoot(plain)).toBe(fs.realpathSync(plain))
  })
  it('项目 ID：目录名转 kebab；同一个根永远同一个 ID；同名目录加哈希；中文名回落 project', () => {
    const s = twoProjects()
    expect(s.A.project.id).toBe('app')
    expect(s.B.project.id).toMatch(/^app-[0-9a-f]{4}$/)
    expect(s.reg.ensure(path.join(s.rootA)).id).toBe('app') // 再登记一次不变
    expect(s.reg.ensure(s.rootB).id).toBe(s.B.project.id)
    expect(s.reg.list().map(p => p.id)).toEqual(['app', s.B.project.id])
    expect(slugOf('/x/My Project_2')).toBe('my-project-2')
    expect(slugOf('/x/项目甲')).toBe('project')
  })
  it('路径：运行库集中在 状态目录/projects/<ID>/，文档在 <项目根>/.dsh-master/docs/', () => {
    const s = twoProjects()
    const pa = projectPaths(s.stateDir, s.A.project)
    expect(pa.dbFile).toBe(path.join(s.stateDir, 'projects', 'app', 'master.db'))
    expect(pa.docsRoot).toBe(path.join(s.rootA, '.dsh-master', 'docs'))
    expect(fs.existsSync(pa.dbFile)).toBe(true)
    expect(projectPaths(s.stateDir, s.B.project).dbFile).not.toBe(pa.dbFile)
  })
})

describe('G6-1 两个项目互不串', () => {
  it('总管 / 成员 ID、任务、消息、归属、记忆、闸门、Q 编号都各一份', async () => {
    const s = twoProjects()
    for (const c of [s.A, s.B]) await c.core.ensureMaster(c.project.root)
    expect(s.A.core.masterId).toBe('app'); expect(s.B.core.masterId).toBe(s.B.project.id)
    // 成员：<项目>.<名字>
    for (const c of [s.A, s.B]) await tool(c, c.core.masterId, 'master_spawn')({ name: 'w', cwd: c.project.root, title: '成员 W' })
    expect(s.A.store.listSessions().map(x => x.id).sort()).toEqual(['app', 'app.w'])
    expect(s.B.store.listSessions().map(x => x.id).sort()).toEqual([s.B.project.id, `${s.B.project.id}.w`].sort())
    // 同一个任务号在两个项目里各是各的
    await tool(s.A, 'app', 'master_dispatch')({ task: 'L1106-1', kind: 'light', title: 'A 的活', to: 'w', text: 'A-TEXT' })
    await tool(s.B, s.B.core.masterId, 'master_dispatch')({ task: 'L1106-1', kind: 'light', title: 'B 的活', to: 'w', text: 'B-TEXT' })
    expect(s.A.store.getTask('L1106-1')!.title).toBe('A 的活'); expect(s.B.store.getTask('L1106-1')!.title).toBe('B 的活')
    expect(s.A.store.messagesFor('L1106-1').some(m => m.text.includes('B-TEXT'))).toBe(false)
    expect(s.B.store.messagesFor('L1106-1').some(m => m.text.includes('A-TEXT'))).toBe(false)
    // 投递目标是各自项目的成员
    await s.A.delivery.pump(); await s.B.delivery.pump()
    expect(s.dp.calls.map(c => c.to).sort()).toEqual(['app.w', `${s.B.project.id}.w`].sort())
    // 成员回报只发给自己项目的总管
    await tool(s.A, 'app.w', 'master_report')({ task: 'L1106-1', state: '完成', action: 'A 做完了' })
    await s.A.delivery.pump()
    expect(s.dp.calls.filter(c => c.to === s.B.core.masterId)).toEqual([])
    expect(s.dp.calls.some(c => c.to === 'app')).toBe(true)
    // 等你定：每个项目自己从 1 编
    const qa = await s.A.core.askUser({ task: 'L1106-1', question: 'A 问？' }), qb = await s.B.core.askUser({ task: 'L1106-1', question: 'B 问？' })
    expect(qa.code).toMatch(/^Q\d{4}-1$/); expect(qb.code).toBe(qa.code)
    expect(s.B.store.openAsks().map(a => a.question)).toEqual(['B 问？'])
    // 闸门：只在 A 定义
    await tool(s.A, 'app', 'task_spec_write')(SPEC)
    expect(s.A.store.gatesFor('T001').map(g => g.gate)).toEqual(['G6-1', 'G6-2']); expect(s.B.store.gatesFor('T001')).toEqual([])
    // 归属：A 的一轮不进 B
    s.A.attrib.processStep('app', 3, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '@L1106-1 怎么样' }] }])
    expect(s.A.store.attribsTouching('L1106-1').length).toBe(1); expect(s.B.store.attribsTouching('L1106-1')).toEqual([])
    // 记忆层：A 写的 devlog，B 查不到；文档落在各自项目根下
    s.A.mem.devlogAdd({ slug: 'a-only-entry', hook: 'A 项目里写的一条 devlog', tags: ['alpha-tag', 'beta-tag', 'gamma-tag'], files_touched: ['/w/a.ts'], depth: '琐碎', sections: { 改了什么: 'x' } })
    expect(s.B.mem.listDevlog()).toEqual([])
    expect(fs.existsSync(path.join(s.rootA, '.dsh-master', 'docs', 'devlog'))).toBe(true)
    expect(fs.existsSync(path.join(s.rootB, '.dsh-master', 'docs', 'devlog'))).toBe(false)
  })
  it('master_tag 只认本项目的总管；巡检发给本项目的总管；执行会话守则写的是本项目的总管', async () => {
    const s = twoProjects()
    for (const c of [s.A, s.B]) await c.core.ensureMaster(c.project.root)
    expect(() => s.A.attrib.tag(s.B.core.masterId, { turn: 1, task: 'L1106-1' })).toThrow(/只有总管/)
    await tool(s.A, 'app', 'master_spawn')({ name: 'w', cwd: s.rootA, title: 'W' })
    await tool(s.A, 'app', 'master_dispatch')({ task: 'L1106-1', kind: 'light', title: 't', to: 'w', text: 'x' })
    await s.A.core.askUser({ task: 'L1106-1', question: '要吗？' })
    const patrol = new Patrol(s.A.store, s.A.core, undefined, s.clock, { stallMs: 99 * 3600_000, longRunMs: 99 * 3600_000 })
    await patrol.tick()
    expect(s.A.store.messagesFor(null).length + s.A.store.messagesFor('L1106-1').length).toBeGreaterThan(0)
    expect(s.A.store.db.prepare(`SELECT to_id FROM deliveries WHERE key LIKE 'patrol:%'`).all().map((r: any) => r.to_id)).toEqual(['app'])
    expect(rolePrompt('exec', 'app.w', undefined, 'app')).toContain('归总管 app 管')
  })
})

describe('G6-1 闸门定义', () => {
  it('parseGates：编号格式、不重复、标题 1–20 字（按字符算）', () => {
    expect(parseGates([{ id: 'G1', title: '一二三四五六七八九十一二三四五六七八九十' }])[0]!.title.length).toBe(20)
    expect(() => parseGates([{ id: 'G1', title: '一二三四五六七八九十一二三四五六七八九十一' }])).toThrow(/21 个字，超过 20 字/)
    expect(() => parseGates([{ id: 'G1', title: 'a' }, { id: 'G1', title: 'b' }])).toThrow(/重复/)
    expect(() => parseGates([{ id: 'g1', title: 'a' }])).toThrow(/要像 G1/)
    expect(() => parseGates([])).toThrow(/至少写一个/)
    expect(parseGates([{ id: 'G6a', title: 'x' }, { id: 'G6-1', title: 'y', produces: 'p' }]).map(g => [g.gate, g.produces])).toEqual([['G6a', ''], ['G6-1', 'p']])
  })
  it('任务书渲染成「### Gn — 短标题」+「- 产物：」；重任务只能派定义过的闸门', async () => {
    const s = twoProjects(); const A = s.A
    await A.core.ensureMaster(A.project.root)
    await tool(A, 'app', 'master_spawn')({ name: 'w', cwd: s.rootA, title: 'W' })
    await expect(tool(A, 'app', 'task_spec_write')({ ...SPEC, gates: undefined })).rejects.toThrow(/gates 至少写一个/)
    await tool(A, 'app', 'task_spec_write')(SPEC)
    const doc = A.mem.docs.read('tasks/T001.md')!
    expect(doc).toContain('## 闸门\n\n### G6-1 — 数据层\n- 产物：packages/dsh-master/src/projects.ts')
    expect(doc).toContain('### G6-2 — 开张与团队\n- 产物：（验收时补）')
    const dispatch = tool(A, 'app', 'master_dispatch')
    await expect(dispatch({ task: 'T001', kind: 'heavy', title: 't', to: 'w', gate: 'G9', text: 'x' })).rejects.toThrow(/没有闸门 G9；定义过的是：G6-1（数据层）、G6-2（开张与团队）/)
    expect(await dispatch({ task: 'T001', kind: 'heavy', title: 't', to: 'w', gate: 'G6-1', text: '开始' })).toMatchObject({ status: 'queued' })
  })
  it('兼容：G6-1 之前写的任务书（没有闸门表）⇒ 派重任务时要求先补闸门', async () => {
    const s = twoProjects(); const A = s.A
    await A.core.ensureMaster(A.project.root)
    await tool(A, 'app', 'master_spawn')({ name: 'w', cwd: s.rootA, title: 'W' })
    await tool(A, 'app', 'task_spec_write')(SPEC)
    A.store.db.exec(`DELETE FROM gates`) // 模拟旧任务书
    await expect(tool(A, 'app', 'master_dispatch')({ task: 'T001', kind: 'heavy', title: 't', to: 'w', gate: 'G6-1', text: 'x' })).rejects.toThrow(/还没有定义闸门/)
  })
})

describe('G6-1 等你定 Q 编号', () => {
  it('Q<月日>-<序号>：同一天递增，换一天从 1 开始；按编号能查回来', () => {
    const dir = tmpdir('q'); const st = new Store(path.join(dir, 'm.db'))
    const add = (at: string) => st.getAsk(st.addAsk({ task: 'L1106-1', question: 'q', options: [], at }))!.code
    expect([add('2026-11-05T09:00:00+08:00'), add('2026-11-05T23:59:00+08:00'), add('2026-11-06T00:01:00+08:00')]).toEqual(['Q1105-1', 'Q1105-2', 'Q1106-1'])
    expect(st.askByCode('Q1105-2')!.created_at).toBe('2026-11-05T23:59:00+08:00')
  })
})

describe('G6-1 迁移（v3 → v4）与回退', () => {
  it('旧库升级：数据不丢、旧等你定按创建日补 Q 编号、升级前留完整副本；副本拷回去旧版照样能读', () => {
    const dir = tmpdir('mig'); const file = path.join(dir, 'master.db'); const clock = fakeClock()
    const v3 = new Store(file, { maxVersion: 3 })
    expect(v3.version).toBe(3)
    const old = new Core(v3, new Delivery(v3, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 1000 })
    v3.insertTask({ id: 'L1103-1', kind: 'light', title: '旧任务', owner: 'exec-a', state: '完成', gate: null, meta: '{}', created_at: '2026-11-03T08:00:00+08:00', updated_at: '2026-11-03T08:00:00+08:00' })
    for (const at of ['2026-11-03T08:00:00+08:00', '2026-11-03T09:00:00+08:00', '2026-11-04T10:00:00+08:00'])
      v3.db.prepare('INSERT INTO asks(task, question, options, created_at) VALUES(?,?,?,?)').run('L1103-1', `问 ${at}`, '[]', at)
    void old; v3.db.close()
    const v4 = new Store(file)
    expect(v4.version).toBe(SCHEMA_VERSION); expect(SCHEMA_VERSION).toBe(4)
    expect(v4.getTask('L1103-1')!.title).toBe('旧任务')
    expect(v4.asksFor('L1103-1').map(a => a.code)).toEqual(['Q1103-1', 'Q1103-2', 'Q1104-1'])
    expect(v4.gatesFor('L1103-1')).toEqual([])
    const bak = `${file}.pre-v4.bak`
    expect(fs.existsSync(bak)).toBe(true)
    expect((fs.statSync(bak).mode & 0o777).toString(8)).toBe('600')
    // 新库里接着加：当天编号接着往下
    expect(v4.getAsk(v4.addAsk({ task: 'L1103-1', question: '新', options: [], at: '2026-11-04T11:00:00+08:00' }))!.code).toBe('Q1104-2')
    v4.db.close()
    // 回退：副本是 v3，没有 code 列，旧数据都在
    const raw = new DatabaseSync(bak)
    expect((raw.prepare('PRAGMA user_version').get() as any).user_version).toBe(3)
    expect((raw.prepare('SELECT count(*) AS c FROM asks').get() as any).c).toBe(3)
    expect(raw.prepare(`SELECT name FROM pragma_table_info('asks') WHERE name = 'code'`).all()).toEqual([])
    raw.close()
  })
  it('已经是最新版本的库重开：不再做备份', () => {
    const dir = tmpdir('mig2'); const file = path.join(dir, 'master.db')
    new Store(file).db.close(); new Store(file).db.close()
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.bak'))).toEqual([])
  })
})
