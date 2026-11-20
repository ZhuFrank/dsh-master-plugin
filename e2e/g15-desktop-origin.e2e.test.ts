/**
 * G15 官方桌面端兼容（假模型 + 沙盒 + 独立无头 Chrome；不碰 3090 / 3082）：
 * 官方桌面端（Electron，dsh-app://app）转发 /api 时删掉 origin / host / cookie，再补上服务签发的 cookie 转给本机服务。
 * - 照这个形状（owner cookie、没有 Origin、带 x-dsh-master + json）点看板写操作 ⇒ 生效（0.2.1 是 403「origin 不是本服务」）；
 * - 没有 Origin 但缺 x-dsh-master / 不是 json ⇒ 仍 403；带了别的 Origin ⇒ 仍 403；
 * - 别的源的网页在浏览器里带 cookie 跨站伪造（自定义头 ⇒ 要预检）⇒ 浏览器拦下、服务端什么都没发生，响应里也没有 CORS 头；
 * - GET 看板照常。
 */
import fs from 'node:fs'
import http from 'node:http'
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
const tokenOf = (sb: Sandbox) => [...fs.readdirSync(sb.logDir).filter(f => /^dsh\.\d+\.log$/.test(f)).sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
  .flatMap(f => [...fs.readFileSync(path.join(sb.logDir, f), 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].map(m => m[1]!))].at(-1)!

it('G15：桌面端形状的请求（没有 Origin）能点看板写操作；跨站伪造仍被拦', async () => {
  const base = path.join(E2E_WORK, `g15-${Date.now()}`)
  const alpha = gitRepo(path.join(base, 'alpha'))
  const sb = await createSandbox({ name: 'g15', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master')],
    pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32, masterCwd: gitRepo(path.join(base, 'legacy-master')), patrol: { intervalMs: 3_600_000 } } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const events = (type: string) => sb.get(`/dsh-master-debug/events?project=alpha&type=${encodeURIComponent(type)}`) as Promise<any[]>
  await sb.post('/dsh-master-debug/create', { id: 'ui-m', cwd: alpha })
  await sb.post('/dsh-master-debug/select-preset', { sessionId: 'ui-m', preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).registry.some((p: any) => p.id === 'alpha'))
  await quiet()
  await sb.post('/dsh-master-debug/prompt', { sessionId: 'ui-m', text: call('master_ask_user', { task: 'L1120-1', question: '桌面端能答吗？', options: ['能', '不能'] }) })
  await quiet()

  // ── 浏览器拿到 owner cookie（和桌面端「补上服务签发的 cookie」是同一个）──
  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p = await chrome.page()
  await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
  const cookies: any[] = (await p.send('Network.getCookies', { urls: [sb.url] })).result.cookies
  expect(cookies.length).toBeGreaterThan(0)
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  // ── 桌面端形状：Node 直接发，没有 Origin（undici 不会自己加）──
  const H = { cookie, 'content-type': 'application/json', 'x-dsh-master': '1' }
  const post = async (headers: Record<string, string>, body: unknown, q = 'session=ui-m') => {
    const r = await fetch(`${sb.url}/api/dsh-master/action?${q}`, { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json().catch(() => undefined), acao: r.headers.get('access-control-allow-origin'), acah: r.headers.get('access-control-allow-headers') }
  }
  // GET 照常（读看板本来就不受影响）
  const stRes = await fetch(`${sb.url}/api/dsh-master/state?session=ui-m`, { headers: { cookie, accept: 'application/json' } })
  expect(stRes.status).toBe(200)
  const ask = ((await stRes.json()) as any).asks.find((a: any) => a.task === 'L1120-1')
  expect(ask).toBeDefined()

  // 反例先发，服务端都没动。插件这一层拒的回 JSON { code: 'forbidden', error }，宿主那一层拒的不是 JSON——分开断言，免得宿主先挡住、插件的校验其实没跑到
  const { 'x-dsh-master': _x, ...noHeader } = H
  const byPlugin = (r: { status: number; body: any }, msg: RegExp) => { expect(r.status).toBe(403); expect(r.body, '应由插件这一层拒（回 JSON）').toMatchObject({ code: 'forbidden', error: expect.stringMatching(msg) }) }
  byPlugin(await post(noHeader, { action: 'pause' }), /x-dsh-master/)
  byPlugin(await post({ ...H, 'x-dsh-master': '0' }, { action: 'pause' }), /x-dsh-master/)
  byPlugin(await post({ ...H, 'content-type': 'text/plain' }, { action: 'pause' }), /content-type/)
  byPlugin(await post({ ...H, 'content-type': 'application/x-www-form-urlencoded' }, { action: 'pause' }), /content-type/)
  byPlugin(await post({ ...H, 'content-type': 'multipart/form-data; boundary=x' }, { action: 'pause' }), /content-type/)
  // 带了别的 Origin / "null"：宿主自己先比 Origin，在它那一层就 403（不是 JSON）；插件这一层的同一判断在单测里钉
  for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:1']) {
    const r = await post({ ...H, origin }, { action: 'pause' })
    expect(r.status, origin).toBe(403)
  }
  expect(await events('project/paused')).toEqual([])
  // 预检（OPTIONS）：带不带 cookie，都不回任何 CORS 头——「自定义头逼出预检、预检过不去」整套设计的前提
  for (const headers of <Record<string, string>[]>[{ origin: 'http://127.0.0.1:1', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-dsh-master' },
    { cookie, origin: 'http://127.0.0.1:1', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-dsh-master' }]) {
    const r = await fetch(`${sb.url}/api/dsh-master/action?session=ui-m`, { method: 'OPTIONS', headers })
    expect(r.status, `OPTIONS ${headers.cookie ? '带' : '不带'} cookie`).not.toBe(204)
    for (const h of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-credentials', 'access-control-allow-methods']) expect(r.headers.get(h), h).toBeNull()
  }

  // 正例：暂停 → 生效；恢复 → 生效
  const paused = await post(H, { action: 'pause' })
  expect(paused, JSON.stringify(paused.body)).toMatchObject({ status: 200, body: { ok: true } })
  expect(paused.acao).toBeNull(); expect(paused.acah).toBeNull()
  expect((await events('project/paused')).map((e: any) => e.data.by)).toEqual(['user'])
  const resumed = await post(H, { action: 'resume' })
  expect(resumed, JSON.stringify(resumed.body)).toMatchObject({ status: 200, body: { ok: true } })
  expect((await events('project/resumed')).map((e: any) => e.data.by)).toEqual(['user'])
  // 答「等你定」——截图里报错的就是这个按钮
  const ans = await post(H, { action: 'answer', ask: Number(ask.id), answer: '能' })
  expect(ans, JSON.stringify(ans.body)).toMatchObject({ status: 200, body: { ok: true } })

  // ── 伪造：同机另一个端口的网页（同站：SameSite=Strict 的 cookie 会带上、不算 cross-site）带 cookie 发同样的请求 ⇒ 预检过不去，服务端没动 ──
  const evil = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html><title>evil</title>') })
  await new Promise<void>(r => evil.listen(0, '127.0.0.1', () => r()))
  cleanups.push(() => new Promise<void>(r => { evil.closeAllConnections(); evil.close(() => r()) }))
  const evilUrl = `http://127.0.0.1:${(evil.address() as any).port}/`
  await p.open(evilUrl, 1500)
  const before = (await events('project/paused')).length
  const forged = await p.ev<string>(`fetch(${JSON.stringify(sb.url + '/api/dsh-master/action?session=ui-m')},{method:'POST',mode:'cors',credentials:'include',headers:{'content-type':'application/json','x-dsh-master':'1'},body:JSON.stringify({action:'pause'})}).then(r=>'status '+r.status,e=>'blocked '+e.name)`)
  expect(forged).toMatch(/^blocked/)
  await sleep(1500)
  expect((await events('project/paused')).length, '跨站伪造不该让服务端暂停项目').toBe(before)
  // 不带自定义头的「简单请求」能发出去，但服务端拒（不带 x-dsh-master）
  await p.ev(`fetch(${JSON.stringify(sb.url + '/api/dsh-master/action?session=ui-m')},{method:'POST',mode:'no-cors',credentials:'include',headers:{'content-type':'text/plain'},body:JSON.stringify({action:'pause'})}).catch(()=>0)`)
  await sleep(1500)
  expect((await events('project/paused')).length, '简单请求也不该让服务端暂停项目').toBe(before)
})
