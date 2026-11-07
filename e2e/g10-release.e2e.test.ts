/**
 * G10 公开版的默认值与卸载（假模型 + 沙盒 + 真定时服务；不碰 3080 / 3090）：
 * 1. 公开版默认（不配 legacy / projectMasterPreset）：不建旧总管、没有旧总管的定时保底；开张项目照常有定时保底；
 *    项目总管默认 workspace-write，往项目外写被沙盒拦；重启后定时保底还是那一条；
 *    从 profile 的组合包列表里去掉插件（= 卸载 / 取消选择，HMR 热重组）⇒ 插件建的定时保底被删掉。
 * 2. Frank 的 3090 那种配置（存档标记 + projectMasterPreset: danger-full-access）：旧单元仍是存档、项目总管仍能往项目外写。
 * 3. 老用户升级：状态目录里已经有旧花名册、配置里不写 legacy ⇒ 仍是 active（旧总管的定时保底还在）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const gitRepo = (d: string) => { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) }
const TITLE = 'dsh-master 定时巡检保底'
const profileDir = (sb: Sandbox) => path.join(sb.home, 'profiles', 'master')
const tokenOf = (sb: Sandbox) => [...fs.readdirSync(sb.logDir).filter(f => /^dsh\.\d+\.log$/.test(f)).sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
  .flatMap(f => [...fs.readFileSync(path.join(sb.logDir, f), 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].map(m => m[1]!))].at(-1)!

function helpers(sb: Sandbox) {
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }
  /** 插件的调试接口看到的定时保底（插件在的时候用）。 */
  const schedules = async (sid: string) => (((await sb.get('/dsh-master-debug/schedules')) ?? []) as any[]).filter(c => c.sessionId === sid && String(c.title).startsWith(TITLE) && c.status !== 'inactive')
  /** 直接读宿主落盘的 storages/schedule.json（插件卸载后调试接口没了，用这个）。 */
  const fileSchedules = (sid: string) => {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(sb.home, 'storages', 'schedule.json'), 'utf8')).tables.tasks as Record<string, any>
      return Object.entries(t).filter(([, c]) => c.sessionId === sid && String(c.record?.title ?? '').startsWith(TITLE) && c.status !== 'inactive').map(([k]) => k)
    } catch { return [] }
  }
  const open = async (sid: string, cwd: string, id: string) => {
    await sb.post('/dsh-master-debug/create', { id: sid, cwd })
    await sb.post('/dsh-master-debug/select-preset', { sessionId: sid, preset: 'dsh-master-master' })
    await sb.waitFor(`${id} 开张`, async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === id))
    await quiet()
  }
  return { quiet, run, schedules, fileSchedules, open }
}

it('G10 ①：公开版默认——不建旧总管、项目总管 workspace-write、重启保留定时保底、卸载删掉定时保底', async () => {
  const base = path.join(E2E_WORK, `g10-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside, { recursive: true })
  const sb = await createSandbox({ name: 'g10-default', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 600, patrol: { intervalMs: 3_600_000 }, legacy: undefined, projectMasterPreset: undefined } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const { run, schedules, fileSchedules, open } = helpers(sb)
  await sb.waitFor('插件就绪', async () => (await sb.get('/dsh-master-debug/ready')).ready === true)

  // 不建旧总管：宿主里没有 master 会话，也没有它的定时保底
  const hostIds = async () => (((await sb.get('/dsh-master-debug/host-sessions'))?.items ?? []) as any[]).map(x => String(x.sessionId))
  expect(await hostIds()).not.toContain('master')
  expect(await schedules('master')).toEqual([])
  // 看板入口：没项目、没旧单元 ⇒ 给开张说明，不去打开不存在的旧总管会话
  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p = await chrome.page(); await p.size(1280, 860)
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
  await p.waitFor('左侧入口', `!!document.querySelector('[aria-label*="总管看板"]')`)
  await p.ev(`document.querySelector('[aria-label*="总管看板"]').click()`)
  await p.waitFor('开张说明', `!!document.querySelector('[data-testid=dshm-no-project]')`, 15_000)
  expect(await p.ev<boolean>(`!!document.querySelector('[data-testid=dshm-project-picker]')`)).toBe(false)
  await sleep(2000)
  expect(await hostIds()).not.toContain('master')
  await chrome.kill()

  // 开张项目：项目总管有定时保底；默认 workspace-write ⇒ 往项目外写被拦
  await open('ui-m', alpha, 'alpha')
  const first = await sb.waitFor('项目定时保底建好', async () => { const s = await schedules('ui-m'); return s.length === 1 ? s : undefined })
  const out1 = path.join(outside, 'g10-1.txt')
  await run('ui-m', call('bash', { command: `touch ${out1}`, description: '往项目外写一个文件' }))
  expect(fs.existsSync(out1)).toBe(false)
  expect(await hostIds()).not.toContain('master')

  // 重启：profile 还选着插件 ⇒ 定时保底保留（还是那一条）
  await sb.restart()
  await sb.waitFor('重启后就绪', async () => (await sb.get('/dsh-master-debug/ready').catch(() => ({}))).ready === true)
  await sleep(2000)
  expect((await schedules('ui-m')).map(c => c.id)).toEqual(first.map(c => c.id))

  // 卸载：从组合包列表里去掉插件（插件页「卸载」/「关闭组合包」写的就是这里），HMR 热重组 ⇒ 插件停用、定时保底删掉
  expect(fileSchedules('ui-m').length).toBe(1)
  const pj = path.join(profileDir(sb), 'package.json')
  const m = JSON.parse(fs.readFileSync(pj, 'utf8'))
  m.dsh.profile.bundles = m.dsh.profile.bundles.filter((b: string) => b !== 'dsh-master')
  fs.writeFileSync(pj, JSON.stringify(m, null, 2))
  await sb.waitFor('插件卸下', async () => { try { await sb.get('/dsh-master-debug/ready'); return undefined } catch { return true } }, 60_000)
  await sb.waitFor('定时保底删掉', () => fileSchedules('ui-m').length === 0 || undefined, 30_000)
}, 300_000)

it('G10 ②：Frank 的 3090 那种配置（存档标记 + danger-full-access）⇒ 行为不变', async () => {
  const base = path.join(E2E_WORK, `g10f-${Date.now()}`)
  const beta = gitRepo(path.join(base, 'beta'))
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside, { recursive: true })
  const sb = await createSandbox({ name: 'g10-frank', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 600, patrol: { intervalMs: 3_600_000 }, masterCwd: gitRepo(path.join(base, 'legacy-master')),
      legacy: undefined, projectMasterPreset: 'danger-full-access' } })
  cleanups.push(() => sb.dispose())
  // 3090 的状态目录里有 legacy-archived 标记文件
  fs.mkdirSync(path.join(sb.home, 'dsh-master'), { recursive: true }); fs.writeFileSync(path.join(sb.home, 'dsh-master', 'legacy-archived'), '')
  await sb.start()
  const { run, schedules, open } = helpers(sb)
  await sb.waitFor('插件就绪', async () => (await sb.get('/dsh-master-debug/ready')).ready === true)
  expect((await sb.get('/dsh-master-debug/events?type=legacy%2Farchived')).length).toBe(1)
  await open('b-m', beta, 'beta')
  await sb.waitFor('项目定时保底建好', async () => (await schedules('b-m')).length === 1 || undefined)
  const out = path.join(outside, 'g10-frank.txt')
  await run('b-m', call('bash', { command: `touch ${out}`, description: '往项目外写一个文件' }))
  expect(fs.existsSync(out)).toBe(true)
}, 240_000)

it('G10 ③：老用户升级——状态目录里已有旧花名册、配置不写 legacy ⇒ 仍是 active', async () => {
  const base = path.join(E2E_WORK, `g10o-${Date.now()}`)
  const sb = await createSandbox({ name: 'g10-old', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 600, patrol: { intervalMs: 3_600_000 }, masterCwd: gitRepo(path.join(base, 'legacy-master')), legacy: 'active' } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const { schedules } = helpers(sb)
  await sb.waitFor('旧总管定时保底建好', async () => (await schedules('master')).length === 1 || undefined)
  // 去掉配置里的 legacy，重启：旧花名册还在 ⇒ 仍是 active
  const patch = path.join(profileDir(sb), 'cordis.patch.yml')
  const before = fs.readFileSync(patch, 'utf8')
  // testkit 把插件配置写成一行 JSON（"legacy":"active" 在中间）⇒ 去掉这一个键
  const after = before.replace(/"legacy":"active",/, '')
  expect(after).not.toBe(before)
  fs.writeFileSync(patch, after)
  await sb.restart()
  await sb.waitFor('重启后就绪', async () => (await sb.get('/dsh-master-debug/ready').catch(() => ({}))).ready === true)
  await sleep(2000)
  expect((await schedules('master')).length).toBe(1)
  // 旧单元真的是 active：旧总管还被装上总管工具（off / archived 时旧会话当普通会话，没有 master_* 工具）
  // 只看定时保底和单元表不够——off 不删已有的保底、legacy 单元总在表里（反向验证 g10-legacy-upgrade 抓到过）
  const { run } = helpers(sb)
  await run('master', '升级后还在吗 LEGACY-UP')
  const req = [...sb.mock.requests()].reverse().find(r => r.messages.some(m => m.role === 'user' && m.text.includes('LEGACY-UP')))
  expect(req).toBeDefined()
  expect(req!.tools).toContain('master_patrol')
}, 240_000)
