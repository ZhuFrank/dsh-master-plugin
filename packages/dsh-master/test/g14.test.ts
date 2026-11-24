/**
 * G14（0.2.1）单测。
 * ② 巡检只有项消失时不叫醒总管（照 Claude Code 看板 11-08 / 11-16 的 gone_only）：
 *    发现从 {A,B} 变成 {A}：只更新签名、不投递；有新增才报，报文分「新增」和「已消失、不用处理」两段。
 */
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store, SCHEMA_VERSION } from '../src/store.ts'
import { Patrol, type Finding } from '../src/patrol.ts'
import { bjtIso } from '../src/time.ts'
import { tmpStore, tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

const flush = () => new Promise(r => setImmediate(r))
/** 带记忆层（任务书 / 手册）的 Core，照 g3.test.ts 的 setupCore。 */
function setupMem() {
  const dir = tmpdir('g14mem')
  const store = new Store(path.join(dir, 'master.db')); const clock = fakeClock()
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const dport = new FakeDeliveryPort()
  const core = new Core(store, new Delivery(store, dport, clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, mem, timer: () => () => {} })
  const tool = (caller: string, name: string) => { const t = core.toolsFor(caller).find(x => x.name === name); if (!t) throw new Error(`${caller} 没有 ${name}`); return (a: unknown) => t.run(a, caller) }
  return { store, mem, dport, core, tool, clock }
}
const SPEC = { task: 'T021', title: '整理脚本', expected: '1 小时', output: '/tmp/out', resume: '从 docs 接着', 目标: '把下载文件夹按类型分到子文件夹，先支持 dry-run', 要读的: '无', 交付物: 'tidy.py', 验收标准: '和 expected.txt 一致', 红线: '不碰 ~/.dsh', gates: [{ id: 'G1', title: '实现' }] }

function setup() {
  const store = tmpStore('g14'); const clock = fakeClock()
  const core = new Core(store, new Delivery(store, new FakeDeliveryPort(), clock), new FakeSessionPort(), clock, { idleGraceMs: 2000, timer: () => () => {} })
  return { store, core, clock }
}
const F = (key: string): Finding => ({ key, text: `发现 ${key}` })

describe('G14 ② 巡检只有项消失不叫醒总管', () => {
  async function rig() {
    const s = setup(); await s.core.ensureMaster(tmpdir('g14cwd'))
    const p = new Patrol(s.store, s.core, undefined, s.clock, { stallMs: 1e12, longRunMs: 1e12 })
    let cur: Finding[] = []
    p.findings = () => cur
    const notify = vi.spyOn(s.core, 'systemNotify')
    return { p, notify, set: (keys: string[]) => { cur = keys.map(F) } }
  }

  it('{A,B} → {A}：quiet，不投递', async () => {
    const r = await rig()
    r.set(['A', 'B']); expect(r.p.tick()).toBe('reported'); expect(r.notify).toHaveBeenCalledTimes(1)
    r.set(['A']); expect(r.p.tick()).toBe('quiet'); expect(r.notify).toHaveBeenCalledTimes(1)
  })

  it('消失后又冒出来：算变化，照报', async () => {
    const r = await rig()
    r.set(['A', 'B']); r.p.tick()
    r.set(['A']); r.p.tick()
    r.set(['A', 'B']); expect(r.p.tick()).toBe('reported'); expect(r.notify).toHaveBeenCalledTimes(2)
  })

  it('{A,B} → {A,C}：照报，报文把 C 列在「新增」、B 列在「已消失」', async () => {
    const r = await rig()
    r.set(['A', 'B']); r.p.tick()
    r.set(['A', 'C']); expect(r.p.tick()).toBe('reported')
    const text = String((r.notify.mock.calls.at(-1)![0] as any).text)
    expect(text).toMatch(/新增[^\n]*\n- 发现 C/)
    expect(text).toMatch(/已消失、不用处理：[^\n]*B/)
    expect(text).not.toMatch(/新增[\s\S]*- 发现 A[\s\S]*已消失/)
  })

  it('全部消失：cleared，不投递', async () => {
    const r = await rig()
    r.set(['A']); r.p.tick()
    r.set([]); expect(r.p.tick()).toBe('cleared'); expect(r.notify).toHaveBeenCalledTimes(1)
  })

  it('定时保底：只有项消失也算没有新发现（count 0）', async () => {
    const r = await rig()
    r.set(['A', 'B']); r.p.tick()
    r.set(['A']); expect(r.p.unseenForSchedule().count).toBe(0)
    r.set(['A', 'C']); expect(r.p.unseenForSchedule().count).toBe(1)
  })
})

describe('G14 ④ 压缩后直接带回在途任务和手册「标准做法」原文', () => {
  async function rig() {
    const s = setupMem(); await s.core.ensureMaster(tmpdir('m'))
    await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: '执行 A' })
    await s.tool(MASTER_ID, 'task_spec_write')(SPEC)
    await s.tool(MASTER_ID, 'master_dispatch')({ task: 'T021', kind: 'heavy', title: '整理脚本', to: 'a', gate: 'G1', text: '开始' })
    await s.tool('exec-a', 'master_report')({ task: 'T021', state: '进展', action: '单元测试写完了，正在对 expected.txt' })
    await s.tool('exec-a', 'handbook_add')({ section: '标准做法', line: '改 tidy.py 前先跑 dry-run 对一遍', source: 'T021' })
    await s.tool(MASTER_ID, 'master_ask_user')({ task: 'T021', question: '清单用表格还是一行一个？', options: ['表格', '一行一个'] })
    await flush(); s.dport.calls.length = 0
    return s
  }
  it('成员：提醒里有任务目标、当前闸门、最后一次回报、手册标准做法的原句', async () => {
    const s = await rig()
    s.core.onCompaction('exec-a', '7'); await flush()
    const t = s.dport.calls.filter(c => c.to === 'exec-a').at(-1)!.text
    expect(t).toContain('把下载文件夹按类型分到子文件夹')
    expect(t).toMatch(/T021[^\n]*G1/)
    expect(t).toContain('单元测试写完了，正在对 expected.txt')
    expect(t).toContain('改 tidy.py 前先跑 dry-run 对一遍')
  })
  it('总管：列出项目里所有没结的任务和还没答的等你定', async () => {
    const s = await rig()
    s.core.onCompaction(MASTER_ID, '8'); await flush()
    const t = s.dport.calls.filter(c => c.to === MASTER_ID).at(-1)!.text
    expect(t).toMatch(/T021[^\n]*exec-a/)
    expect(t).toContain('清单用表格还是一行一个？')
  })
  it('太长就截断，并给出全文路径', async () => {
    const s = await rig()
    for (let i = 0; i < 40; i++) await s.tool('exec-a', 'handbook_add')({ section: '标准做法', line: `第 ${i} 条很长的经验`.padEnd(150, '。'), source: 'T021' })
    s.core.onCompaction('exec-a', '9'); await flush()
    const t = s.dport.calls.filter(c => c.to === 'exec-a').at(-1)!.text
    expect(t.length).toBeLessThan(3600)
    expect(t).toMatch(/截断[\s\S]*handbooks\/exec-a\.md/)
  })
})

describe('G14 ① 重活队列', async () => {
  const fs = await import('node:fs')
  const { HeavyQueue } = await import('../src/heavy.ts')
  const { rolePrompt } = await import('../src/prompts.ts')
  function q(free: number, total = 16) {
    const store = new Store(path.join(tmpdir('g14heavy'), 'master.db')); const done: any[] = []; const clock = fakeClock()
    let f = free
    const hq = new HeavyQueue(store, clock, { logDir: tmpdir('g14hlog'), freeGb: () => f, totalGb: () => total, guard: () => undefined, onDone: (j: any) => done.push(j) } as any)
    return { store, hq, done, clock, setFree: (g: number) => { f = g } }
  }
  const waitDone = async (done: any[], n: number) => { for (let i = 0; i < 100 && done.length < n; i++) await new Promise(r => setTimeout(r, 30)) }

  it('排第一的够不着、后面的够得着 ⇒ 先跑后面的（T018：6G 堵住 4G 和 1G）', async () => {
    const h = q(1); const cwd = tmpdir('g14hc')
    await h.hq.submit({ session: 'exec-a', label: 'big', command: 'true', cwd, minFreeGb: 6 })
    await h.hq.submit({ session: 'exec-a', label: 'mid', command: 'true', cwd, minFreeGb: 4 })
    h.setFree(4.3); h.hq.tick()
    expect(h.store.heavyJobs('running').map(j => j.label)).toEqual(['mid'])
    expect(h.store.heavyJobs('queued').map(j => j.label)).toEqual(['big'])
  })
  it('排第一的够得着时一定先跑它；同一时间只跑一件', async () => {
    const h = q(1); const cwd = tmpdir('g14hc')
    await h.hq.submit({ session: 'exec-a', label: 'big', command: 'true', cwd, minFreeGb: 6 })
    await h.hq.submit({ session: 'exec-a', label: 'mid', command: 'true', cwd, minFreeGb: 4 })
    h.setFree(6.5); h.hq.tick(); h.hq.tick()
    expect(h.store.heavyJobs('running').map(j => j.label)).toEqual(['big'])
  })
  it('门槛高于整机内存 ⇒ 直接拒；高于当前可用 ⇒ 照排，返回里写当前可用和口径', async () => {
    const h = q(4.3, 16); const cwd = tmpdir('g14hc')
    await expect(h.hq.submit({ session: 'exec-a', label: 'x', command: 'true', cwd, minFreeGb: 32 })).rejects.toThrow(/整机内存/)
    const r: any = await h.hq.submit({ session: 'exec-a', label: 'y', command: 'true', cwd, minFreeGb: 6 })
    expect(String(r.note)).toMatch(/4\.3[\s\S]*6/)
    expect(String(r.note)).toContain(process.platform === 'darwin' ? 'inactive' : 'os.freemem()') // G16：口径按平台写
  })
  it('取消：只管排队中的；取消后状态 cancelled，提交的会话收到通知', async () => {
    const h = q(1); const cwd = tmpdir('g14hc')
    const r: any = await h.hq.submit({ session: 'exec-a', label: 'big', command: 'true', cwd, minFreeGb: 6 })
    expect((h.hq as any).cancel(r.id, 'master')).toMatchObject({ id: r.id, state: 'cancelled' })
    expect(h.store.heavyJobs('cancelled').map(j => j.id)).toEqual([r.id])
    expect(h.done.map(j => j.state)).toEqual(['cancelled'])
    expect(() => (h.hq as any).cancel(r.id, 'master')).toThrow(/不在排队/)
  })
  it('旧库（v4）升上来，重活能标成 cancelled', async () => {
    const file = path.join(tmpdir('g14mig'), 'master.db')
    const old = new Store(file, { maxVersion: 4 })
    const id = old.addHeavyJob({ session: 'exec-a', label: 'old', command: 'x', cwd: '/tmp', min_free_gb: 6, log: '/tmp/x', created_at: 'x' }); old.close()
    const s = new Store(file)
    s.updateHeavyJob(id, { state: 'cancelled' as any })
    expect(s.heavyJobs().map(j => [j.id, j.label, j.state])).toEqual([[id, 'old', 'cancelled']])
    expect(fs.existsSync(`${file}.pre-v${s.version}.bak`)).toBe(true)
  })

  it('工具：成员只能取消自己的；总管能取消本项目成员的；heavy_status 带插件读数和口径', async () => {
    const h = q(1)
    const s = setupMem()
    const core = new Core(s.store, new Delivery(s.store, s.dport, s.clock), new FakeSessionPort(), s.clock, { idleGraceMs: 2000, mem: s.mem, heavy: h.hq as any, timer: () => () => {} })
    const tool = (caller: string, name: string) => { const t = core.toolsFor(caller).find(x => x.name === name); if (!t) throw new Error(`${caller} 没有 ${name}`); return (a: unknown) => t.run(a, caller) }
    await core.ensureMaster(tmpdir('m'))
    await tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    await tool(MASTER_ID, 'master_spawn')({ name: 'b', cwd: tmpdir('b'), title: 'B' })
    const j1: any = await tool('exec-a', 'heavy_run')({ label: 'tts', command: 'true', min_free_gb: 6 })
    const j2: any = await tool('exec-a', 'heavy_run')({ label: 'tts2', command: 'true', min_free_gb: 6 })
    await expect(tool('exec-b', 'heavy_cancel')({ id: j1.id })).rejects.toThrow(/只能取消自己/)
    expect(await tool('exec-a', 'heavy_cancel')({ id: j1.id })).toMatchObject({ state: 'cancelled' })
    expect(await tool(MASTER_ID, 'heavy_cancel')({ id: j2.id })).toMatchObject({ state: 'cancelled' })
    const st: any = await tool('exec-a', 'heavy_status')({})
    expect(st.free_gb).toBe(1)
    expect(String(st.how)).toContain(process.platform === 'darwin' ? 'inactive' : 'os.freemem()') // G16：口径按平台写
    expect(st.jobs.map((j: any) => j.state)).toEqual(['cancelled', 'cancelled'])
  })

  it('巡检：本项目成员的活排了 15 分钟以上、门槛高于可用 ⇒ 报卡住（带分钟、门槛、可用）；别人的、刚排上的不报', async () => {
    const s = setupMem(); await s.core.ensureMaster(tmpdir('m'))
    await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    const now = s.clock()
    const iso = (ms: number) => bjtIso(ms)
    const jobs = [
      { id: 1, session: 'exec-a', label: 'tts', min_free_gb: 6, state: 'queued', created_at: iso(now - 20 * 60_000) },
      { id: 2, session: 'exec-a', label: 'fresh', min_free_gb: 6, state: 'queued', created_at: iso(now - 2 * 60_000) },
      { id: 3, session: 'other.x', label: 'not-mine', min_free_gb: 6, state: 'queued', created_at: iso(now - 60 * 60_000) },
      { id: 4, session: 'exec-a', label: 'fits', min_free_gb: 2, state: 'queued', created_at: iso(now - 30 * 60_000) }, // 门槛够得着、只是在等前面跑完：不算卡住
    ]
    const p = new Patrol(s.store, s.core, undefined, s.clock, { stallMs: 1e12, longRunMs: 1e12, heavy: () => ({ jobs: jobs as any, free: 4.3 }) } as any)
    const f = p.findings().filter(x => x.key.startsWith('heavy'))
    expect(f.map(x => x.key)).toEqual(['heavy-stuck:1'])
    expect(f[0]!.text).toMatch(/20 分钟[\s\S]*6[\s\S]*4\.3/)
  })

  it('预设：看内存用 heavy_status，不要自己读 vm_stat 的 free 页（Windows 上：系统的内存数）', () => {
    for (const role of ['master', 'exec'] as const) expect(rolePrompt(role, role === 'master' ? MASTER_ID : 'exec-a')).toMatch(process.platform === 'darwin' ? /heavy_status[\s\S]*vm_stat/ : /heavy_status[\s\S]*不要自己读系统的内存数/)
  })
})

describe('G14 库版本钉子', () => {
  it('最新库版本是 6（① 重活加 cancelled、⑤ reminders 表）；以后每加一次迁移改这里', () => { expect(SCHEMA_VERSION).toBe(6) })
})

describe('G14 审稿 SHOULD 5：重活卡住只报一次（内存在门槛上下抖也不反复叫醒）', () => {
  it('报过以后内存升到门槛以上又掉回来 ⇒ 不再叫醒；离开队列 ⇒ 消失也不叫醒', async () => {
    const s = setupMem(); await s.core.ensureMaster(tmpdir('m'))
    await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    const now = s.clock()
    const jobs: any[] = [{ id: 1, session: 'exec-a', label: 'tts', min_free_gb: 6, state: 'queued', created_at: bjtIso(now - 20 * 60_000) }]
    let free = 4.3
    const p = new Patrol(s.store, s.core, undefined, s.clock, { stallMs: 1e12, longRunMs: 1e12, heavy: () => ({ jobs, free }) } as any)
    const notify = vi.spyOn(s.core, 'systemNotify')
    const patrolCalls = () => notify.mock.calls.filter(c => (c[0] as any).label === '巡检').length
    expect(p.tick()).toBe('reported'); expect(patrolCalls()).toBe(1)
    free = 6.5; p.tick()
    free = 4.1; p.tick()
    free = 6.2; p.tick()
    free = 4.0; p.tick()
    expect(patrolCalls()).toBe(1)
    jobs[0].state = 'running'; p.tick()
    expect(patrolCalls()).toBe(1)
  })
})

describe('G14 复核（不急的两处之一）：卡住项内存已经够了时报文不写「够不着」', () => {
  it('报过的重活还在排队、内存升到门槛以上 ⇒ 报文写「已经够了」，不写「够不着」', async () => {
    const s = setupMem(); await s.core.ensureMaster(tmpdir('m'))
    await s.tool(MASTER_ID, 'master_spawn')({ name: 'a', cwd: tmpdir('a'), title: 'A' })
    const jobs: any[] = [{ id: 1, session: 'exec-a', label: 'tts', min_free_gb: 6, state: 'queued', created_at: bjtIso(s.clock() - 20 * 60_000) }]
    let free = 4.3
    const p = new Patrol(s.store, s.core, undefined, s.clock, { stallMs: 1e12, longRunMs: 1e12, heavy: () => ({ jobs, free }) } as any)
    expect(p.findings().find(f => f.key === 'heavy-stuck:1')!.text).toMatch(/够不着/)
    p.tick(); free = 6.5
    const t = p.findings().find(f => f.key === 'heavy-stuck:1')!.text
    expect(t).not.toMatch(/够不着/)
    expect(t).toMatch(/已经够了/)
  })
})
