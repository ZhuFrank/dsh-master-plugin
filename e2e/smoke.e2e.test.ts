import path from 'node:path'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, type Sandbox, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
let sb: Sandbox | undefined
afterAll(async () => { await sb?.dispose() })

it('冒烟：沙盒 DSH 起来，dsh-master 加载，总管会话建好并带总管工具', async () => {
  sb = await createSandbox({ name: 'smoke', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')] })
  await sb.start()
  await sb.post('/dsh-master-debug/prompt', { sessionId: 'master', text: 'hello' })
  const req = await sb.waitFor('假模型收到总管的请求', () => sb!.mock.requests().find(r => r.messages.some(m => m.text === 'hello')))
  expect(req.tools).toEqual(expect.arrayContaining(['master_spawn', 'master_dispatch', 'master_review']))
  expect(req.tools).not.toContain('master_report')
  expect(req.tools).not.toContain('write')
})
