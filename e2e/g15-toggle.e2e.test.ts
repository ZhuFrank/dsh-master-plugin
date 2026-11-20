/**
 * G15 插件页「停用 → 启用」（或卸载 → 再装）不重启宿主（假模型 + 沙盒；不碰 3090 / 3082）：
 * 0.2.1 卸载时没摘掉挂在现有智能体上的工具和系统提示段 ⇒ 开着的总管会话每一轮都去读旧实例已关的库，
 * 「本轮运行失败 database is not open」，新实例的同名系统提示段 / 工具也挂不上去，要重启宿主才好。
 * 这里核：停用再启用之后，开着的总管会话下一轮照常跑到模型，守则只有一份（新实例的），工具还在。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const gitRepo = (d: string) => { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) }
const tokenOf = (sb: Sandbox) => [...fs.readdirSync(sb.logDir).filter(f => /^dsh\.\d+\.log$/.test(f)).sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
  .flatMap(f => [...fs.readFileSync(path.join(sb.logDir, f), 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].map(m => m[1]!))].at(-1)!
const ROLE = '# 你是总管（会话 ui-m）'

it('G15：插件停用再启用（不重启宿主），开着的总管会话照常跑', async () => {
  const base = path.join(E2E_WORK, `g15t-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g15t', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, masterCwd: gitRepo(path.join(base, 'legacy-master')), patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  await sb.post('/dsh-master-debug/prompt', { sessionId: 'ui-m', text: 'BEFORE-TOGGLE' })
  await quiet()
  const before = sb.mock.requests().find(r => r.messages.some(m => m.role === 'user' && m.text.includes('BEFORE-TOGGLE')))
  expect(before, '停用前总管能跑').toBeDefined()
  expect(before!.tools).toContain('master_dispatch')

  // ── 插件页的开关：pluginManager/setBundleEnabled（和桌面端、dsh web 插件页同一个接口）──
  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p = await chrome.page()
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  const setEnabled = (enabled: boolean) => p.ev<any>(`fetch('/api/pluginManager/setBundleEnabled',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'g15t-'+Date.now(),method:'pluginManager/setBundleEnabled',payload:{args:{name:'dsh-master',enabled:${enabled}}}})}).then(r=>r.json())`)
  expect(await setEnabled(false)).toMatchObject({ result: { ok: true, value: { enabled: false, changed: true } } })
  await sleep(4000)
  expect(await setEnabled(true)).toMatchObject({ result: { ok: true, value: { enabled: true, changed: true } } })
  await sb.waitFor('插件重新就绪', async () => (await sb.get('/dsh-master-debug/ready').catch(() => undefined))?.ready === true || undefined, 60_000)
  await sleep(2000)

  // ── 开着的总管会话再跑一轮：要跑到模型、守则只有一份、工具还在 ──
  const n0 = sb.mock.requests().length
  await sb.post('/dsh-master-debug/prompt', { sessionId: 'ui-m', text: 'AFTER-TOGGLE' })
  await quiet()
  const after = sb.mock.requests().slice(n0).find(r => r.messages.some(m => m.role === 'user' && m.text.includes('AFTER-TOGGLE')))
  expect(after, '停用再启用后，总管这一轮没跑到模型（0.2.1：database is not open）').toBeDefined()
  const sys = after!.messages.filter(m => m.role === 'system').map(m => m.text).join('\n')
  expect(sys.split(ROLE).length - 1, '总管守则应只有一份').toBe(1)
  expect(after!.tools).toContain('master_dispatch')
  expect(after!.tools.filter(t => t === 'master_dispatch')).toHaveLength(1)
  // 停用时旧实例删掉了定时保底（G10），重新启用后新实例要建回来，且只有一条（0.2.1：启动链在挂工具时断了，看板「下次保底 —」）
  const mySchedules = async () => (((await sb.get('/dsh-master-debug/schedules')) ?? []) as any[]).filter(c => c.sessionId === 'ui-m' && String(c.title).startsWith('dsh-master 定时巡检保底') && c.status !== 'inactive')
  await sb.waitFor('定时保底建回来', async () => (await mySchedules()).length >= 1 || undefined, 30_000)
  await sleep(3000)
  expect(await mySchedules()).toHaveLength(1)

  // ── 再来一次：停用后立刻启用（中间不等）。旧实例的「删定时保底」和新实例的「建定时保底」挤在一起，也只能剩一条 ──
  expect(await setEnabled(false)).toMatchObject({ result: { ok: true } })
  expect(await setEnabled(true)).toMatchObject({ result: { ok: true } })
  await sb.waitFor('插件再次就绪', async () => (await sb.get('/dsh-master-debug/ready').catch(() => undefined))?.ready === true || undefined, 60_000)
  await sb.waitFor('定时保底又建回来', async () => (await mySchedules()).length >= 1 || undefined, 30_000)
  await sleep(5000)
  expect(await mySchedules(), '快速停用再启用后，定时保底应恰好一条').toHaveLength(1)
  const n1 = sb.mock.requests().length
  await sb.post('/dsh-master-debug/prompt', { sessionId: 'ui-m', text: 'AFTER-FAST-TOGGLE' })
  await quiet()
  const fast = sb.mock.requests().slice(n1).find(r => r.messages.some(m => m.role === 'user' && m.text.includes('AFTER-FAST-TOGGLE')))
  expect(fast, '快速停用再启用后，总管这一轮也要跑到模型').toBeDefined()
  expect(fast!.messages.filter(m => m.role === 'system').map(m => m.text).join('\n').split(ROLE).length - 1).toBe(1)
})
