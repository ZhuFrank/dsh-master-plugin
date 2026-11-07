/**
 * 脚本化的 OpenAI 兼容假模型（只给测试用，不连任何真实模型、不用任何凭据）。
 * 看「最后一条 assistant 之后」的用户消息（跳过 DSH 自动加的 runtime / time / skill 上下文）：
 *  - 最后一条是 tool 结果 → 文本 "TOOL_RESULT_SEEN: <前 300 字>"
 *  - 有一行 `CALL <tool> <json>` → 返回这个工具调用
 *  - 否则 → "ECHO(n): <前 400 字>"；含 SLOW 时延迟 slowMs 再回答
 * 每个请求追加写进 logFile（jsonl），按测试分文件（G1 教训：不要清空，不要共用）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

export type MockFailure = 'refuse' | 'error' | null
export interface MockLlm { port: number; baseURL: string; logFile: string; requests(): MockRequest[]; close(): Promise<void>
  /** 模拟模型接口断网：refuse = 连接直接断开；error = HTTP 500；null = 恢复。失败的请求记在 failures() 里，不进 requests()。 */
  fail(mode: MockFailure): void; failures(): number }
export interface MockRequest { at: string; n: number; plan: Plan; messages: Array<{ role: string; text: string; parts?: string[] }>; tools: string[] }
type Plan = { text: string } | { tool: { name: string; args: string } }

const NOISE = /^(Current runtime context|<system-reminder>|Time sampled)/

function textOf(m: any): string {
  if (typeof m?.content === 'string') return m.content
  if (Array.isArray(m?.content)) return m.content.map((c: any) => c?.text ?? '').join('')
  return ''
}

export function planFor(messages: any[]): Plan {
  const last = messages[messages.length - 1]
  if (last?.role === 'tool') return { text: 'TOOL_RESULT_SEEN: ' + textOf(last).slice(0, 300) }
  let i = messages.length - 1
  while (i >= 0 && messages[i].role !== 'assistant') i--
  const users = messages.slice(i + 1).filter(m => m.role === 'user').map(textOf).filter(t => !NOISE.test(t))
  const joined = users.join('\n---\n')
  const m = joined.match(/^CALL (\S+) (.+)$/m)
  if (m) return { tool: { name: m[1]!, args: m[2]! } }
  return { text: `ECHO(${users.length}): ` + joined.slice(0, 400).replace(/\s+/g, ' ') }
}

export async function startMockLlm(opts: { logFile: string; slowMs?: number }): Promise<MockLlm> {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true })
  let n = 0
  let failure: MockFailure = null; let failed = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-1', object: 'model' }] })); return
    }
    if (failure === 'refuse') { failed++; req.socket.destroy(); return }
    if (failure === 'error') { failed++; res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock: upstream unavailable', type: 'server_error' } })); return }
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', async () => {
      let body: any = {}
      try { body = JSON.parse(raw) } catch {}
      const id = ++n
      const messages = body.messages ?? []
      const plan = planFor(messages)
      const rec: MockRequest = { at: new Date().toISOString(), n: id, plan, messages: messages.map((m: any) => ({ role: m.role, text: textOf(m), ...(Array.isArray(m.content) ? { parts: m.content.map((c: any) => c?.type ?? '?') } : {}) })), tools: (body.tools ?? []).map((t: any) => t?.function?.name) }
      fs.appendFileSync(opts.logFile, JSON.stringify(rec) + '\n')
      if ('text' in plan && /SLOW/.test(plan.text)) await new Promise(r => setTimeout(r, opts.slowMs ?? 6000))
      const base = { id: `mock-${id}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model ?? 'mock-1' }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const sse = (o: unknown) => res.write('data: ' + JSON.stringify(o) + '\n\n')
      if ('tool' in plan) {
        sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: plan.tool.name, arguments: '' } }] }, finish_reason: null }] })
        sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: plan.tool.args } }] }, finish_reason: null }] })
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: plan.text }, finish_reason: null }] })
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    port, baseURL: `http://127.0.0.1:${port}/v1`, logFile: opts.logFile,
    requests: () => fs.existsSync(opts.logFile) ? fs.readFileSync(opts.logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [],
    close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()) }),
    fail: (mode: MockFailure) => { failure = mode },
    failures: () => failed,
  }
}
