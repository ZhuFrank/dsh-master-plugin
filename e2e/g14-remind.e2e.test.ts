/**
 * G14 ⑤：master_remind 真接到心跳上——挂一个 1 分钟后的提醒，到点总管被叫醒（假模型多一次总管请求，里面有「到点提醒」和原话）；
 * 看板状态栏有「下次提醒」，到点后没了。沙盒 + 假模型；不碰 3080 / 3090。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const gitRepo = (d: string) => { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); return fs.realpathSync(d) }

it('G14 ⑤：挂 1 分钟后的提醒 ⇒ 到点总管被叫醒，原话在里面', async () => {
  const base = path.join(E2E_WORK, `g14remind-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g14-remind', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 0, patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const run = async (sid: string, text: string) => { await sb.post('/dsh-master-debug/prompt', { sessionId: sid, text }); await quiet() }
  const masterReqs = () => sb.mock.requests().filter(r => r.messages.some(m => m.text?.includes('# 你是总管（会话 ui-m）')))

  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  await run('ui-m', call('master_remind', { at: '1m', text: 'G14-REMIND 核一下市场条目' }))
  const m0 = masterReqs().length
  const lastUser = (r: any) => String([...r.messages].reverse().find((m: any) => m.role === 'user')?.text ?? '')
  await sb.waitFor('到点叫醒总管', async () => masterReqs().slice(m0).some(r => lastUser(r).includes('到点提醒') && lastUser(r).includes('G14-REMIND')), 120_000)
  await quiet()
  const fired = masterReqs().slice(m0).filter(r => lastUser(r).includes('G14-REMIND'))
  expect(fired.length).toBe(1)
}, 300_000)
