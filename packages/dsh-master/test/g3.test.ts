import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryLayer, type Prior } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { guardDecision, bashWriteTargets, expandVars, USE_HEAVY_RUN } from '../src/guard.ts'
import { FilePushGate } from '../src/recall-push.ts'
import { Patrol } from '../src/patrol.ts'
import { HeavyQueue } from '../src/heavy.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

const flush = () => new Promise(r => setImmediate(r))

// ---------------- 守卫：G2 遗留的两种绕过 ----------------
describe('守卫 · 变量写法与相对写', () => {
  const state = '/tmp/home/dsh-master'
  const cfg = { protectedPaths: [state], env: { DSH_HOME: '/tmp/home', HOME: '/tmp/userhome' } }
  const bash = (command: string, cwd?: string, role?: 'master' | 'exec') => guardDecision({ name: 'bash', args: { command }, cwd, role }, cfg)
  it('① 变量写法：$DSH_HOME / ${DSH_HOME} 展开后命中就拒', () => {
    expect(bash('echo x >> $DSH_HOME/dsh-master/a.md')).toMatch(/守卫/)
    expect(bash('echo x >> ${DSH_HOME}/dsh-master/a.md')).toMatch(/守卫/)
    expect(bash('cp evil.db "$DSH_HOME/dsh-master/master.db"')).toMatch(/守卫/)
    expect(expandVars('cat ~/x $HOME/y ${NOPE}/z', { HOME: '/h' })).toBe('cat /h/x /h/y ${NOPE}/z')
  })
  it('~ 写法（状态目录在家目录下时）也拦', () => {
    const c2 = { protectedPaths: ['/tmp/userhome/.dsh-master/dsh-master'], env: { HOME: '/tmp/userhome' } }
    expect(guardDecision({ name: 'bash', args: { command: 'echo x > ~/.dsh-master/dsh-master/a.md' } }, c2)).toMatch(/守卫/)
  })
  it('② cwd 就在状态目录里，相对写 → 拒；只读 → 放行', () => {
    expect(bash('echo x >> a.md', `${state}/docs`)).toMatch(/工作目录就在状态目录里/)
    expect(bash('cat a.md', `${state}/docs`)).toBeUndefined()
  })
  it('cwd 在外面，用相对路径写进状态目录 → 拒；写别处 → 放行', () => {
    expect(bash('echo x >> dsh-master/a.md', '/tmp/home')).toMatch(/守卫/)
    expect(bash('echo x >> other/a.md', '/tmp/home')).toBeUndefined()
  })
  it('执行会话直接跑重活命令 → 指向 heavy_run；总管、普通命令不受影响', () => {
    expect(bash('ffmpeg -i a.mov b.mp4', '/w', 'exec')).toBe(USE_HEAVY_RUN)
    expect(bash('mlx_whisper a.wav', '/w', 'exec')).toBe(USE_HEAVY_RUN)
    expect(bash('echo ffmpeg-free', '/w', 'exec')).toBeUndefined()
  })
  it('bashWriteTargets：重定向、tee、cp/mv 目标、sed -i；读命令没有目标', () => {
    expect(bashWriteTargets('echo x >> a.md && cat b | tee -a c.md', '/w', {})).toEqual(['/w/a.md', '/w/c.md'])
    expect(bashWriteTargets('cp x.ts src/y.ts; sed -i "" s/a/b/ z.ts', '/w', {})).toEqual(['/w/src/y.ts', '/w/z.ts'])
    expect(bashWriteTargets('cat a.md; ls -la 2>&1', '/w', {})).toEqual([])
  })
})

// ---------------- 写前提醒闸门 ----------------
describe('写前提醒闸门（按文件推送前情）', () => {
  const prior = (slug: string): Prior => ({ slug, line: `- ${slug}`, reason: 'r', decisions: [], memories: [] })
  let db: Record<string, string[]>
  let gate: FilePushGate
  beforeEach(() => { db = { '/w/a.ts': ['old-a'] }; gate = new FilePushGate(f => (db[f] ?? []).map(prior)) })
  it('① 没有前情的文件直接放行（不拦）', () => {
    expect(gate.decide('exec-x', ['/w/new.ts'])).toBeUndefined()
  })
  it('② 同一会话同一文件只拦一次；前情有新增才再拦；换会话会再拦', () => {
    expect(gate.decide('exec-x', ['/w/a.ts'])?.priors.map(p => p.slug)).toEqual(['old-a'])
    expect(gate.decide('exec-x', ['/w/a.ts'])).toBeUndefined()
    expect(gate.decide('exec-x', ['/w/a.ts'])).toBeUndefined()
    db['/w/a.ts'] = ['old-a', 'newer-a']
    expect(gate.decide('exec-x', ['/w/a.ts'])?.priors.map(p => p.slug)).toEqual(['old-a', 'newer-a'])
    expect(gate.decide('exec-x', ['/w/a.ts'])).toBeUndefined()
    expect(gate.decide('exec-y', ['/w/a.ts'])).toBeDefined()
  })
  it('一次写多个文件：只把没提醒过的那几个拦下', () => {
    db['/w/b.ts'] = ['old-b']
    gate.decide('exec-x', ['/w/a.ts'])
    const r = gate.decide('exec-x', ['/w/a.ts', '/w/b.ts', '/w/new.ts'])
    expect(r?.files).toEqual(['/w/b.ts'])
  })
})

// ---------------- Core（带记忆层）----------------
function setupCore(over: { stateFile?: string; memDir?: string } = {}) {
  const dir = tmpdir('g3core')
  const store = new Store(over.stateFile ?? path.join(dir, 'master.db'))
  const memDir = over.memDir ?? dir
  const clock = fakeClock()
  const mem = new MemoryLayer({ dbFile: path.join(memDir, 'memory.db'), docsRoot: path.join(memDir, 'docs'), clock })
  const dport = new FakeDeliveryPort(); const sport = new FakeSessionPort()
  const timers: Array<{ fn: () => void; at: number }> = []
  const core = new Core(store, new Delivery(store, dport, clock), sport, clock, { idleGraceMs: 2000, mem,
    timer: (fn, ms) => { const t = { fn, at: clock() + ms }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) } } })
  const runTimers = async () => { const due = timers.filter(t => t.at <= clock()); for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn() } await new Promise(r => setTimeout(r, 5)) }
  const tool = (caller: string, name: string) => { const t = core.toolsFor(caller).find(x => x.name === name); if (!t) throw new Error(`${caller} 没有 ${name}`); return (a: unknown) => t.run(a, caller) }
  return { dir, store, mem, clock, dport, sport, core, timers, runTimers, tool }
}
const spec = { task: 'T009', title: '测试任务', expected: '1 小时', output: '/tmp/out', resume: '从 docs 接着', 目标: '做 X', 要读的: '无', 交付物: 'x.md', 验收标准: '有读数', 红线: '不碰 ~/.dsh', gates: [{ id: 'G1', title: '第一步', produces: '/tmp/out/g1.md' }, { id: 'G2', title: '第二步' }] }

describe('Core · 任务书 / 手册 / 记忆工具', () => {
  let s: ReturnType<typeof setupCore>
  beforeEach(async () => {
    s = setupCore(); await s.core.ensureMaster(tmpdir('m'))
    await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: '执行 A' })
  })
  it('两个角色都有记忆层工具；执行会话还有 handbook_add', () => {
    for (const sid of [MASTER_ID, 'exec-a']) for (const n of ['devlog_add', 'devlog_amend', 'devlog_recall', 'decision_add', 'memory_write', 'memory_search', 'handbook_add'])
      expect(s.core.toolsFor(sid).map(t => t.name), `${sid} ${n}`).toContain(n)
    expect(s.core.toolsFor('nobody')).toEqual([])
  })
  it('有记忆层时，重任务派活必须先有任务书；任务书缺段落被拒', async () => {
    const dispatch = s.tool(MASTER_ID, 'master_dispatch')
    await expect(dispatch({ task: 'T009', kind: 'heavy', title: 't', to: 'a', gate: 'G1', text: 'x', expected: '1h', output: '/o', resume: 'r' })).rejects.toThrow(/task_spec_write/)
    const { 红线: _drop, ...noRedline } = spec
    await expect(s.tool(MASTER_ID, 'task_spec_write')(noRedline)).rejects.toThrow(/红线/)
    await s.tool(MASTER_ID, 'task_spec_write')(spec)
    expect(await dispatch({ task: 'T009', kind: 'heavy', title: 't', to: 'a', gate: 'G1', text: '开始' })).toMatchObject({ status: 'queued' })
    await flush()
    expect(s.dport.calls.at(-1)!.text).toMatch(/任务书：.*tasks\/T009\.md/)
  })
  it('回报写进任务书「执行回报」，验收写进「验收记录」；重写任务书保留这两节', async () => {
    await s.tool(MASTER_ID, 'task_spec_write')(spec)
    await s.tool(MASTER_ID, 'master_dispatch')({ task: 'T009', kind: 'heavy', title: 't', to: 'a', gate: 'G1', text: '开始' })
    await s.tool('exec-a', 'master_report')({ task: 'T009', state: '就绪', action: 'G1 完成', body: '产物 /tmp/out/x.md' })
    await s.tool(MASTER_ID, 'master_review')({ task: 'T009', verdict: '打回', gate: 'G1', notes: '缺读数' })
    let md = s.mem.docs.read('tasks/T009.md')!
    expect(md).toMatch(/## 执行回报\n\n- \[T009\] 状态=就绪 ｜时间：2026-11-03 0700 ｜当前动作：G1 完成\n  产物 \/tmp\/out\/x\.md\n\n## 验收记录\n\n- 2026-11-03 0700 G1 打回：缺读数/)
    await s.tool(MASTER_ID, 'task_spec_write')({ ...spec, 目标: '做 X（改）' })
    md = s.mem.docs.read('tasks/T009.md')!
    expect(md).toContain('做 X（改）'); expect(md).toContain('状态=就绪'); expect(md).toContain('G1 打回：缺读数')
  })
  it('任务书不从 Markdown 里抠状态：回报里有「## 」行、说明里写着「## 执行回报」，重写后回报一条不丢、不串位', async () => {
    const tricky = { ...spec, 要读的: '模板长这样：\n## 执行回报\n（这里是示例，不是真的回报）' }
    await s.tool(MASTER_ID, 'task_spec_write')(tricky)
    await s.tool(MASTER_ID, 'master_dispatch')({ task: 'T009', kind: 'heavy', title: 't', to: 'a', gate: 'G1', text: '开始' })
    await s.tool('exec-a', 'master_report')({ task: 'T009', state: '进展', action: '第一条', body: '## 小结\n读数 42' })
    await s.tool('exec-a', 'master_report')({ task: 'T009', state: '就绪', action: '第二条' })
    await s.tool(MASTER_ID, 'master_review')({ task: 'T009', verdict: '打回', gate: 'G1', notes: '再来' })
    await s.tool(MASTER_ID, 'task_spec_write')({ ...tricky, 目标: '做 X（第二版）' })
    const md = s.mem.docs.read('tasks/T009.md')!
    const sec = (name: string) => md.split(/^## /m).filter(x => x.startsWith(name + '\n')).map(x => x.slice(name.length))
    const reports = sec('执行回报'), reviews = sec('验收记录')
    expect(reports, '「执行回报」节只能有一个').toHaveLength(1)
    expect(reports[0]).toContain('第一条'); expect(reports[0]).toContain('读数 42'); expect(reports[0]).toContain('第二条')
    expect(reviews).toHaveLength(1); expect(reviews[0]).toContain('G1 打回：再来')
    expect(md).toContain('（这里是示例，不是真的回报）')
    expect(md).toContain('做 X（第二版）')
  })
  it('G4 之前的旧格式任务书（meta 没正文）：第一次重写时把旧文件里的回报 / 验收导进库，之后照常追加', async () => {
    s.mem.docs.write('tasks/T010.md', '# T010 旧\n\n## 目标\n\n旧\n\n## 执行回报\n\n- [T010] 状态=就绪 旧回报\n\n## 验收记录\n\n- 旧验收\n', 'task')
    s.store.setMeta('spec:T010', JSON.stringify({ file: 'tasks/T010.md', title: '旧', expected: '1h', output: '/o', resume: 'r' }))
    await s.tool(MASTER_ID, 'task_spec_write')({ ...spec, task: 'T010', title: '新' })
    await s.tool(MASTER_ID, 'master_dispatch')({ task: 'T010', kind: 'heavy', title: '新', to: 'a', gate: 'G2', text: '继续' })
    await s.tool('exec-a', 'master_report')({ task: 'T010', state: '进展', action: '新回报' })
    const md = s.mem.docs.read('tasks/T010.md')!
    expect(md).toMatch(/## 执行回报\n\n- \[T010\] 状态=就绪 旧回报\n- \[T010\] 状态=进展 .*新回报\n\n## 验收记录\n\n- 旧验收\n/)
  })
  it('handbook_add：一句话 + 出处，按节插入，节名受限', async () => {
    const add = s.tool('exec-a', 'handbook_add')
    await expect(add({ section: '乱写', line: 'x', source: 'y' })).rejects.toThrow(/section/)
    await expect(add({ section: '坑', line: 'x', source: '' })).rejects.toThrow(/source/)
    await add({ section: '坑', line: '守卫在参数校验前跑', source: 'spike-G1 e' })
    await add({ section: '标准做法', line: 'pnpm check 一条命令', source: 'g2-core-messaging' })
    await add({ section: '坑', line: '第二条坑', source: 'g3' })
    const md = s.mem.docs.read('handbooks/exec-a.md')!
    expect(md).toMatch(/## 标准做法\n\n- pnpm check 一条命令 —— 出处 g2-core-messaging\n/)
    expect(md).toMatch(/## 坑\n\n- 守卫在参数校验前跑 —— 出处 spike-G1 e\n- 第二条坑 —— 出处 g3\n/)
    expect(md).toContain('> 最近更新：2026-11-03 0700')
  })
  it('devlog_add 由插件按轮次保证「一次请求一条」', async () => {
    s.core.onStatus('exec-a', 'running')
    const add = s.tool('exec-a', 'devlog_add')
    const e = { slug: 'first-entry', hook: '第一条记录写进记忆层', tags: ['aaa1', 'bbb2', 'ccc3'], files_touched: ['/w/a.ts'], depth: '琐碎', sections: { 改了什么: 'x' } }
    await add(e)
    await expect(add({ ...e, slug: 'second-entry', tags: ['ddd4', 'eee5', 'fff6'], files_touched: ['/w/b.ts'] })).rejects.toThrow(/一次请求一条/)
    s.clock.advance(1000); s.core.onStatus('exec-a', 'idle'); s.core.onStatus('exec-a', 'running')
    expect(await add({ ...e, slug: 'second-entry', tags: ['ddd4', 'eee5', 'fff6'], files_touched: ['/w/b.ts'] })).toMatchObject({ slug: 'second-entry' })
  })
})

describe('Core · 轮次落库（重启后不漏空闲提醒）', () => {
  it('执行会话开了一轮没回报时 DSH 重启：新 Core 的 recover() 排上检查，宽限期后提醒总管', async () => {
    const a = setupCore()
    await a.core.ensureMaster(tmpdir('m'))
    await a.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await a.tool(MASTER_ID, 'master_dispatch')({ task: 'L1103-9', kind: 'light', title: 't', to: 'a', text: '做' })
    a.core.onStatus('exec-a', 'running')            // 一轮开始……然后进程没了
    await flush(); await flush()
    a.core.dispose(); a.store.close(); a.mem.close()
    const b = setupCore({ stateFile: a.store.file, memDir: a.dir })
    b.clock.set(a.clock() + 10_000)
    expect(b.core.recover()).toBe(1)
    b.clock.advance(2000); await b.runTimers(); await flush()
    expect(b.dport.calls.filter(c => c.to === MASTER_ID).map(c => c.text)).toEqual([expect.stringContaining('exec-a 一轮结束了，但没有用 master_report 回报')])
  })
  it('回报过的轮不恢复', async () => {
    const a = setupCore()
    await a.core.ensureMaster(tmpdir('m'))
    await a.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await a.tool(MASTER_ID, 'master_dispatch')({ task: 'L1103-9', kind: 'light', title: 't', to: 'a', text: '做' })
    a.core.onStatus('exec-a', 'running'); a.clock.advance(10)
    await a.tool('exec-a', 'master_report')({ task: 'L1103-9', state: '进展', action: 'x' })
    expect(a.core.recover()).toBe(0)
  })
})

describe('Core · 用户直接指示 / 压缩后提醒', () => {
  let s: ReturnType<typeof setupCore>
  beforeEach(async () => {
    s = setupCore(); await s.core.ensureMaster(tmpdir('m'))
    await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
  })
  it('有在途任务时用户直接对执行会话说话 → 告诉总管（inject）；没任务不打扰', async () => {
    s.core.onUserMessage('exec-a', 'm1', '先停一下')
    await s.tool(MASTER_ID, 'master_dispatch')({ task: 'L1103-9', kind: 'light', title: 't', to: 'a', text: '做' })
    s.core.onUserMessage('exec-a', 'm2', '先停一下，换个方向')
    s.core.onUserMessage(MASTER_ID, 'm3', '用户对总管说话不算')
    await flush()
    const toMaster = s.dport.calls.filter(c => c.to === MASTER_ID)
    expect(toMaster).toHaveLength(1)
    expect(toMaster[0]!.mode).toBe('inject')
    expect(toMaster[0]!.text).toContain('先停一下，换个方向')
  })
  it('被压缩后 → 给该会话 inject 提醒（读手册、任务书、回忆），同一次压缩只提醒一次', async () => {
    s.core.onCompaction('exec-a', '42'); s.core.onCompaction('exec-a', '42')
    await flush()
    const c = s.dport.calls.filter(x => x.to === 'exec-a')
    expect(c).toHaveLength(1)
    expect(c[0]!.mode).toBe('inject')
    expect(c[0]!.text).toMatch(/你刚被压缩过[\s\S]*handbooks\/exec-a\.md[\s\S]*devlog_recall/)
  })
})

// ---------------- 巡检 ----------------
describe('巡检（静默）', () => {
  it('无变化零投递；有变化只投一次；发现清空后再出现会再报', async () => {
    const s = setupCore(); await s.core.ensureMaster(tmpdir('m'))
    const p = new Patrol(s.store, s.core, s.mem, s.clock, { stallMs: 3600_000, longRunMs: 3600_000 })
    expect(p.tick()).toBe('cleared'); expect(p.tick()).toBe('quiet'); expect(p.tick()).toBe('quiet')
    s.mem.docs.write('board.md', 'x', 'board')
    fs.appendFileSync(s.mem.docs.abs('board.md'), '手改')
    expect(p.tick()).toBe('reported')
    expect(p.tick()).toBe('quiet'); expect(p.tick()).toBe('quiet')
    await flush()
    const reports = s.dport.calls.filter(c => c.to === MASTER_ID)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.text).toContain('带外改动：board.md')
    s.mem.docs.write('board.md', 'y', 'board')   // 插件重写：当前漂移消失，但「写时吸收的漂移」要报一次
    expect(p.tick()).toBe('reported')
    expect(p.tick()).toBe('cleared')                // 报过之后发现清空
    expect(p.tick()).toBe('quiet')
    await flush()
    expect(s.dport.calls.filter(c => c.to === MASTER_ID).at(-1)!.text).toContain('写入时发现并已另存')
  })
  it('停滞：执行会话有在途任务、超过阈值没回报 → 报一次', async () => {
    const s = setupCore(); await s.core.ensureMaster(tmpdir('m'))
    await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await s.tool(MASTER_ID, 'master_dispatch')({ task: 'L1103-9', kind: 'light', title: 't', to: 'a', text: '做' })
    const p = new Patrol(s.store, s.core, s.mem, s.clock, { stallMs: 60_000, longRunMs: 3600_000 })
    p.tick()
    s.clock.advance(61_000)
    expect(p.tick()).toBe('reported')
    s.clock.advance(600_000)
    expect(p.tick()).toBe('quiet')
    expect(p.findings().find(f => f.key === 'stalled:exec-a:L1103-9')!.text).toMatch(/11 分钟没有回报/)
  })
  it('每天第一次巡检做备份（库 + docs），同一天不重复，只留 N 份', async () => {
    const s = setupCore(); await s.core.ensureMaster(tmpdir('m'))
    const dir = tmpdir('backup')
    for (const d of ['20261001', '20261002', '20261003']) fs.mkdirSync(path.join(dir, d))
    const p = new Patrol(s.store, s.core, s.mem, s.clock, { stallMs: 1e9, longRunMs: 1e9, backupDir: dir, keepBackups: 3 })
    s.mem.docs.write('board.md', 'x', 'board')
    expect(p.backup()).toBe(path.join(dir, '20261103'))
    expect(p.backup()).toBeUndefined()
    expect(fs.readdirSync(dir).sort()).toEqual(['20261002', '20261003', '20261103'])
    expect(fs.existsSync(path.join(dir, '20261103', 'master.db'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, '20261103', 'docs', 'board.md'), 'utf8')).toBe('x')
  })
})

// ---------------- 重活队列 ----------------
describe('重活队列', () => {
  function setupHeavy(free: number) {
    const store = new Store(path.join(tmpdir('heavy'), 'master.db')); const done: any[] = []
    let freeGb = free
    const q = new HeavyQueue(store, fakeClock(), { logDir: tmpdir('heavylog'), freeGb: () => freeGb,
      guard: (c) => c.includes('FORBIDDEN') ? '守卫拒绝' : undefined, onDone: j => done.push(j) })
    return { store, q, done, setFree: (g: number) => { freeGb = g } }
  }
  const waitDone = async (done: any[], n: number) => { for (let i = 0; i < 100 && done.length < n; i++) await new Promise(r => setTimeout(r, 30)) }
  it('内存不够就排队不跑；够了才跑；同一时间只跑一件；跑完通知', async () => {
    const h = setupHeavy(1)
    const cwd = tmpdir('hc')
    await h.q.submit({ session: 'exec-a', label: 'one', command: 'echo one > one.txt', cwd, minFreeGb: 4 })
    await h.q.submit({ session: 'exec-a', label: 'two', command: 'echo two > two.txt', cwd, minFreeGb: 4 })
    expect(h.store.heavyJobs('queued')).toHaveLength(2)
    h.setFree(8); h.q.tick()
    expect(h.store.heavyJobs('running')).toHaveLength(1)
    h.q.tick(); expect(h.store.heavyJobs('running')).toHaveLength(1)
    await waitDone(h.done, 2)
    expect(h.done.map(j => `${j.label}:${j.state}:${j.exit_code}`)).toEqual(['one:done:0', 'two:done:0'])
    expect(fs.readFileSync(path.join(cwd, 'two.txt'), 'utf8')).toBe('two\n')
  })
  it('守卫拒绝的命令不入队；上次进程留下的「运行中」标失败并通知', async () => {
    const h = setupHeavy(8)
    await expect(h.q.submit({ session: 'exec-a', label: 'x', command: 'FORBIDDEN', cwd: '/tmp', minFreeGb: 1 })).rejects.toThrow('守卫拒绝')
    expect(h.store.heavyJobs()).toHaveLength(0)
    const id = h.store.addHeavyJob({ session: 'exec-a', label: 'old', command: 'x', cwd: '/tmp', min_free_gb: 1, log: '/tmp/x', created_at: 'x' })
    h.store.updateHeavyJob(id, { state: 'running' })
    h.q.recover()
    expect(h.store.heavyJobs('failed').map(j => j.id)).toEqual([id])
    expect(h.done.map(j => j.state)).toEqual(['failed'])
  })
})

// ---------------- 状态机单向：已结案任务的迟到回报 ----------------
describe('Core · 已结案任务的迟到回报不改状态', () => {
  let s: ReturnType<typeof setupCore>
  beforeEach(async () => {
    s = setupCore(); await s.core.ensureMaster(tmpdir('m'))
    await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await s.tool(MASTER_ID, 'task_spec_write')(spec)
    await s.tool(MASTER_ID, 'master_dispatch')({ task: 'T009', kind: 'heavy', title: 't', to: 'a', gate: 'G1', text: '开始' })
    await s.tool('exec-a', 'master_report')({ task: 'T009', state: '就绪', action: 'G1 完成' })
    await s.tool(MASTER_ID, 'master_review')({ task: 'T009', verdict: '通过', gate: 'G1', notes: '好', final: true })
  })
  it('final 之后回报「完成 / 进展 / 就绪」：每种都不改状态，事件记成 task/late-report，给总管的提示标「迟到回报」且不唤醒', async () => {
    for (const st of ['完成', '进展', '就绪']) {
      s.clock.advance(1000)
      const r: any = await s.tool('exec-a', 'master_report')({ task: 'T009', state: st, action: `final 之后又报了 ${st}` })
      expect(r.late, st).toBe(true)
      expect(s.store.getTask('T009')!.state, st).toBe('完成')
    }
    expect(s.store.events({ type: 'task/late-report' })).toHaveLength(3)
    await flush()
    const late = s.dport.calls.filter(c => c.to === MASTER_ID && c.text.includes('已结案任务的迟到回报'))
    expect(late).toHaveLength(3)
    expect(late.every(c => c.mode === 'inject')).toBe(true)
    expect(s.mem.docs.read('tasks/T009.md')!.match(/迟到回报，不改状态/g)).toHaveLength(3)
  })
  it('轻任务完成后再回报，同样不改状态', async () => {
    await s.tool(MASTER_ID, 'master_dispatch')({ task: 'L1103-8', kind: 'light', title: 't', to: 'a', text: '做' })
    await s.tool('exec-a', 'master_report')({ task: 'L1103-8', state: '完成', action: '做完' })
    expect(s.store.getTask('L1103-8')!.state).toBe('完成')
    s.clock.advance(1000)
    await s.tool('exec-a', 'master_report')({ task: 'L1103-8', state: '受阻', action: '迟到的受阻' })
    expect(s.store.getTask('L1103-8')!.state).toBe('完成')
  })
  it('被总管关闭的执行会话（工具还挂着）不能再回报', async () => {
    const report = s.tool('exec-a', 'master_report')   // 关闭前拿到的工具
    await s.tool(MASTER_ID, 'master_close')({ name: 'a' })
    await expect(report({ task: 'T009', state: '进展', action: 'x' })).rejects.toThrow(/已被总管关闭|不是花名册里在用/)
  })
})

// ---------------- G3 真模型试用发现的两处 ----------------
describe('试用发现 · 守卫不误拦只读命令里的 /dev/null 重定向', () => {
  const cfg = { protectedPaths: ['/tmp/home/dsh-master'], env: { DSH_HOME: '/tmp/home', HOME: '/tmp/userhome' } }
  const bash = (command: string) => guardDecision({ name: 'bash', args: { command }, role: 'exec' }, cfg)
  it('ls … 2>/dev/null、cat … 2>&1、>/dev/null 都放行', () => {
    expect(bash('ls /tmp/home/dsh-master/docs/handbooks/ 2>/dev/null')).toBeUndefined()
    expect(bash('cat /tmp/home/dsh-master/docs/board.md 2>&1 | head')).toBeUndefined()
    expect(bash('grep x /tmp/home/dsh-master/docs/a.md >/dev/null && echo ok')).toBeUndefined()
  })
  it('真写还是拒：同一条命令里既有 2>/dev/null 又有写进状态目录的重定向', () => {
    expect(bash('ls 2>/dev/null; echo x > /tmp/home/dsh-master/a.md')).toMatch(/守卫/)
    expect(bash('echo x 2>&1 >> /tmp/home/dsh-master/a.md')).toMatch(/守卫/)
  })
})

describe('试用发现 · 建会话时就有手册骨架', () => {
  it('master_spawn 后手册文件就存在（各节齐全）；已有手册不被覆盖', async () => {
    const s = setupCore(); await s.core.ensureMaster(tmpdir('m'))
    expect(s.mem.docs.read('handbooks/master.md')).toContain('## 标准做法')
    const r: any = await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: '执行 A' })
    expect(r.handbook).toMatch(/handbooks\/exec-a\.md$/)
    const md = s.mem.docs.read('handbooks/exec-a.md')!
    for (const sec of ['标准做法', '坑', '工具与素材', '用户偏好与否决过的做法', '还没想清楚的', '做过的任务']) expect(md).toContain(`## ${sec}`)
    await s.tool('exec-a', 'handbook_add')({ section: '坑', line: '一条经验', source: 's' })
    await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a2'), title: '执行 A' })
    expect(s.mem.docs.read('handbooks/exec-a.md')).toContain('一条经验')
  })
})

// ---------------- G3 遗留（并进 G4）----------------
import { topicPriors, scheduleStep, SCHEDULE_MARK } from '../src/recall-push.ts'
describe('G3 遗留 · 按话题推送不推已点名的条目', () => {
  const p = (slug: string): Prior => ({ slug, line: slug, reason: 'r', decisions: [], memories: [] })
  it('回报里已经写出 slug 的不推；没提到 slug 的照推', () => {
    expect(topicPriors([p('hello-py-add-function'), p('old-entry')], '回报：devlog 已写 hello-py-add-function，改了 hello.py').map(x => x.slug)).toEqual(['old-entry'])
  })
})
describe('G3 遗留 · 定时巡检保底：没有发现就跳过这一步', () => {
  const sn = { kind: 'schedule', text: `【这是 ${SCHEDULE_MARK}消息】` }
  it('只有保底提醒 + 巡检无发现 → skip；有发现 → enter；混着用户消息 → enter；别的定时任务 → enter', () => {
    expect(scheduleStep([sn], 0)).toBe('skip')
    expect(scheduleStep([sn, sn], 0)).toBe('skip')
    expect(scheduleStep([sn], 2)).toBe('enter')
    expect(scheduleStep([sn, { kind: 'user', text: 'hi' }], 0)).toBe('enter')
    expect(scheduleStep([{ kind: 'schedule', text: '用户自己的提醒' }], 0)).toBe('enter')
    expect(scheduleStep([], 0)).toBe('enter')
    // 真 DSH 里同一步还带着宿主的环境快照（G4 端到端实测）：不算叫醒消息
    const snap = [{ kind: 'runtime-context', form: 'snapshot', text: 'Current runtime context' }, { kind: 'time-context', form: 'snapshot', text: 'Time sampled' }]
    expect(scheduleStep([sn, ...snap], 0)).toBe('skip')
    expect(scheduleStep(snap, 0)).toBe('enter')
    expect(scheduleStep([sn, ...snap, { kind: 'dsh-master', form: 'relay', text: '回报' }], 0)).toBe('enter')
  })
})
