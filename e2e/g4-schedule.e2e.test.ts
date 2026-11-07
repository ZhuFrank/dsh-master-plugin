/**
 * G3 遗留 (b) 的端到端（真 DSH 定时服务，间隔 60 秒——宿主下限）：
 * 到点时插件先自己巡检；没有发现 ⇒ pre-step 拒绝这一步（不调模型、记 patrol/schedule-quiet）；
 * 有发现（这里用一个等你定）⇒ 照常进模型；G7 ⑧：同样的发现总管见过以后，下一次到点又跳过。
 */
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, type Sandbox, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let sb: Sandbox | undefined
afterAll(async () => { await sb?.dispose() })
const MARK = '定时巡检保底消息'

it('定时保底：没发现就跳过（不调模型），有发现照常进模型', async () => {
  sb = await createSandbox({ name: 'g4-schedule', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, scheduleEverySeconds: 60, patrol: { intervalMs: 3_600_000 } } })
  const s = sb
  await s.start()
  const events = (type: string) => { const d = new DatabaseSync(path.join(s.home, 'dsh-master', 'master.db'), { readOnly: true }); try { return d.prepare('SELECT * FROM events WHERE type = ? ORDER BY seq').all(type) as any[] } finally { d.close() } }
  const schedReqs = () => s.mock.requests().filter(r => r.messages.some(m => m.role === 'user' && m.text.includes(MARK)))
  await s.waitFor('定时任务建好', async () => (await s.get<any[]>('/dsh-master-debug/schedules')).find(x => x.sessionId === 'master'))

  // 第一次到点：库里什么都没有 ⇒ 跳过
  await s.waitFor('第一次到点被跳过', () => events('patrol/schedule-quiet').length >= 1 || undefined, 100_000)
  await sleep(2000)
  expect(schedReqs(), '没有发现时保底消息不该送进模型').toHaveLength(0)

  // 制造一个发现：总管开一个等你定
  await s.post('/dsh-master-debug/prompt', { sessionId: 'master', text: call('master_ask_user', { task: 'L1103-9', question: '要不要继续？', options: ['要', '不要'] }) })
  await s.waitFor('等你定建好', async () => (await s.get<any>('/dsh-master-debug/state')).asks?.length || undefined)
  const quiet = events('patrol/schedule-quiet').length
  await s.waitFor('第二次到点进了模型', () => schedReqs().length >= 1 || undefined, 100_000)
  expect(events('patrol/schedule-quiet').length, '有发现时不该再记跳过').toBe(quiet)

  // G7 ⑧：发现还是那一件（总管已经见过）⇒ 下一次到点跳过，不再叫醒模型（3090 上同样两件等你定让 6 小时保底次次进模型）
  const seen = schedReqs().length
  await s.waitFor('同样的发现：下一次到点被跳过', () => events('patrol/schedule-quiet').length > quiet || undefined, 100_000)
  await sleep(2000)
  expect(schedReqs().length, '同样的发现不该再把保底送进模型').toBe(seen)
}, 400_000)
