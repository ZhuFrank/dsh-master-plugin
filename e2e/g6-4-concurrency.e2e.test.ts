/**
 * G6-4 — 并发与权限（假模型 + 沙盒 + 独立无头 Chrome；不碰 3090 / 3082）：
 * 一个项目两个成员共用项目根，成员默认「工作区内修改」。
 * - 认领不重叠：两边都能改；重叠的派活被拒（说出是谁）；写别人认领的文件（write / bash）被拦，提示是谁认领的；
 * - 两个成员改同一个没认领的文件：宿主乐观锁拦下后写的（FS_STALE_VERSION），插件记进时间线、告诉它先重读；重读后两个人的改动都在；
 * - 成员 git add / commit 被拦，仓库里没有新提交；只读 git status 照用；
 * - 产物目录 .dsh-master/out/ 能写，.dsh-master/ 其余照拦；往项目外写：直接写被沙盒拒，申请放宽弹「等你批」；
 * - 任务完成后认领失效，别人就能改了；看板任务详情显示认领和这些事件（1280 / 390 截图）。
 * 顺带实测（只记录不断言）：「工作区内修改」下 bash 能不能联网（plan-v3 开放项）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it, expect, afterAll } from 'vitest'
import { createSandbox, launchChrome, freePort, type Sandbox, type CdpPage, E2E_WORK, E2E_SANDBOX } from '@dsh-master/testkit'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'docs/g6-4'); fs.mkdirSync(OUT, { recursive: true })
const call = (tool: string, args: unknown) => `CALL ${tool} ${JSON.stringify(args)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const f of cleanups.reverse()) await f().catch(() => {}) })
const tokenOf = (sb: Sandbox) => [...fs.readFileSync(path.join(sb.logDir, 'dsh.1.log'), 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)![1]!
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })

it('G6-4：认领、乐观锁、成员不提交、产物目录与往外写', async () => {
  const base = path.join(E2E_WORK, `g64-${Date.now()}`)
  const alpha = (() => {
    const d = path.join(base, 'alpha'); for (const s of ['src/a', 'src/b']) fs.mkdirSync(path.join(d, s), { recursive: true })
    execFileSync('git', ['init', '-q', d]); fs.writeFileSync(path.join(d, 'shared.txt'), 'v1\n'); fs.writeFileSync(path.join(d, 'src/a/keep.txt'), 'a\n')
    git(d, 'add', '.'); git(d, 'commit', '-qm', 'init'); return fs.realpathSync(d)
  })()
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside, { recursive: true })
  const sb = await createSandbox({ name: 'g6-4', root: E2E_SANDBOX, plugins: [path.join(ROOT, 'packages/dsh-master'), path.join(ROOT, 'spike/g5g-probe-plugin')], pluginConfig: { idleGraceMs: 2000, fakeFreeGb: 32 } })
  cleanups.push(() => sb.dispose())
  await sb.start()
  const prompt = (sid: string, text: string) => sb.post('/dsh-master-debug/prompt', { sessionId: sid, text })
  const quiet = () => sb.waitFor('假模型安静', async () => { const n = sb.mock.requests().length; await sleep(2500); return sb.mock.requests().length === n })
  const hist = async (sid: string) => JSON.stringify(await sb.get(`/dsh-master-debug/history?sessionId=${encodeURIComponent(sid)}`))
  const events = (type: string) => sb.get(`/dsh-master-debug/events?project=alpha&type=${encodeURIComponent(type)}`) as Promise<any[]>
  const run = async (sid: string, tool: string, args: unknown) => { await prompt(sid, call(tool, args)); await quiet() }
  const A = (p: string) => path.join(alpha, p)
  const commits = () => git(alpha, 'rev-list', '--count', 'HEAD').trim()

  // ── 开张、两个成员（默认「工作区内修改」）──
  await sb.post('/dsh-master-debug/create', { id: 'a-master', cwd: alpha, preset: 'dsh-master-master' })
  await sb.waitFor('alpha 开张', async () => (await sb.get('/dsh-master-debug/projects')).units.includes('alpha'))
  expect(fs.existsSync(A('.dsh-master/out'))).toBe(true)
  await run('a-master', 'master_spawn', { name: 'x', title: '成员 X', purpose: '改 src/a' })
  await run('a-master', 'master_spawn', { name: 'y', title: '成员 Y', purpose: '改 src/b' })

  // ── 认领：不重叠都能派；重叠被拒并说出是谁 ──
  await run('a-master', 'master_dispatch', { task: 'L1106-1', kind: 'light', title: 'X 改 a', to: 'x', text: '改 src/a', claims: ['src/a/'] })
  await run('a-master', 'master_dispatch', { task: 'L1106-2', kind: 'light', title: 'Y 改 b', to: 'y', text: '改 src/b', claims: ['src/b/'] })
  await run('a-master', 'master_dispatch', { task: 'L1106-3', kind: 'light', title: 'Y 也改 a', to: 'y', text: 'x', claims: ['src/a/f.ts'] })
  expect(await hist('a-master')).toContain('认领重叠：src/a/f.ts 和 L1106-1（alpha.x）认领的 src/a')
  expect((await sb.get('/dsh-master-debug/state?project=alpha')).tasks.some((t: any) => t.id === 'L1106-3')).toBe(false)

  // ── 各改各的：都能写 ──
  await run('alpha.x', 'write', { file_path: A('src/a/x1.txt'), content: 'X1\n' })
  await run('alpha.y', 'write', { file_path: A('src/b/y1.txt'), content: 'Y1\n' })
  expect([fs.readFileSync(A('src/a/x1.txt'), 'utf8'), fs.readFileSync(A('src/b/y1.txt'), 'utf8')]).toEqual(['X1\n', 'Y1\n'])
  // ── 越界：Y 写 X 认领的文件（write 工具、bash 重定向）被拦，提示是谁认领的 ──
  await run('alpha.y', 'write', { file_path: A('src/a/hack.txt'), content: 'H\n' })
  await run('alpha.y', 'bash', { description: 'write into a', command: 'echo H > src/a/hack2.txt' })
  expect(fs.existsSync(A('src/a/hack.txt')) || fs.existsSync(A('src/a/hack2.txt'))).toBe(false)
  expect(await hist('alpha.y')).toContain('src/a/hack.txt 在 L1106-1 的认领范围里（负责的是 alpha.x，认领了 src/a）')
  expect((await events('claims/deny')).map((e: any) => [e.task, e.data.file]).filter(([t]: any) => t === 'L1106-1')).toEqual([['L1106-1', 'src/a/hack.txt'], ['L1106-1', 'src/a/hack2.txt']])

  // ── 两个成员改同一个没认领的文件：乐观锁拦下后写的；重读后两个人的改动都在 ──
  await run('alpha.x', 'read', { file_path: A('shared.txt') })
  await run('alpha.y', 'read', { file_path: A('shared.txt') })
  await run('alpha.y', 'edit', { file_path: A('shared.txt'), old_string: 'v1\n', new_string: 'v1\nY 加的一行\n' })
  await run('alpha.x', 'edit', { file_path: A('shared.txt'), old_string: 'v1\n', new_string: 'v1\nX 加的一行\n' })
  expect(fs.readFileSync(A('shared.txt'), 'utf8')).toBe('v1\nY 加的一行\n') // X 的没写进去，Y 的没被冲掉
  const hx = await hist('alpha.x')
  expect(hx).toMatch(/changed since it was read|FS_STALE_VERSION/)
  expect(hx).toContain('[dsh-master 提示] 这个文件在你读过以后被改过了')
  expect((await events('fs/conflict')).map((e: any) => [e.task, e.session, e.data.kind, e.data.file])).toEqual([['L1106-1', 'alpha.x', 'stale', 'shared.txt']])
  await run('alpha.x', 'read', { file_path: A('shared.txt') })
  await run('alpha.x', 'edit', { file_path: A('shared.txt'), old_string: 'Y 加的一行\n', new_string: 'Y 加的一行\nX 加的一行\n' })
  expect(fs.readFileSync(A('shared.txt'), 'utf8')).toBe('v1\nY 加的一行\nX 加的一行\n')

  // ── 成员提交：被拦，仓库没有新提交；只读的 git status 照用 ──
  const before = commits()
  await run('alpha.x', 'bash', { description: 'commit', command: 'git add -A && git commit -m "x 的改动"' })
  expect(commits()).toBe(before)
  expect(git(alpha, 'diff', '--cached', '--name-only').trim()).toBe('') // 暂存区也没动
  expect(await hist('alpha.x')).toContain('项目成员不提交、不动暂存区和分支')
  expect((await events('guard/git-deny')).map((e: any) => [e.task, e.session])).toEqual([['L1106-1', 'alpha.x']])
  await run('alpha.x', 'bash', { description: 'status', command: 'git status --short' })
  expect(await hist('alpha.x')).toMatch(/shared\.txt/)

  // ── 产物目录能写，.dsh-master/ 其余照拦 ──
  await run('alpha.x', 'write', { file_path: A('.dsh-master/out/L1106-1/r.md'), content: '# 产物\n' })
  await run('alpha.x', 'write', { file_path: A('.dsh-master/docs/hack.md'), content: 'x' })
  expect(fs.readFileSync(A('.dsh-master/out/L1106-1/r.md'), 'utf8')).toBe('# 产物\n')
  expect(fs.existsSync(A('.dsh-master/docs/hack.md'))).toBe(false)

  // ── 顺带实测：「工作区内修改」下 bash 联网（只记录）──
  const net: string[] = []
  // 对照：同一条命令在沙盒外（测试进程里）跑一遍；外网用国内站点（example.com 在这台机器上要 6 秒，3 秒内测不出）
  const ctl = (url: string) => { try { return execFileSync('bash', ['-c', `curl -sS -m 3 -o /dev/null -w 'HTTP=%{http_code}' ${url} 2>&1; echo " exit=$?"`], { encoding: 'utf8' }).trim() } catch (e) { return String(e) } }
  for (const [label, url] of [['本机回环（沙盒自己的服务）', sb.url], ['外网 https://www.baidu.com', 'https://www.baidu.com']] as const) {
    await run('alpha.x', 'bash', { description: 'net probe', command: `curl -sS -m 3 -o /dev/null -w 'HTTP=%{http_code}' ${url} 2>&1; echo " exit=$?"` })
    const h = await hist('alpha.x'); const i = h.lastIndexOf('HTTP=')
    net.push(`${label}：成员（沙盒里）${i >= 0 ? h.slice(Math.max(0, h.lastIndexOf('curl:', i) > i - 200 ? h.lastIndexOf('curl:', i) : i), i + 20).replace(/\\n/g, ' ') : '（没拿到输出）'} ｜ 对照（沙盒外）${ctl(url)}`)
  }
  fs.writeFileSync(path.join(OUT, 'network.txt'), `「工作区内修改」下成员 bash 联网实测（curl -m 3）\n${net.join('\n')}\n`)

  // ── 任务完成 ⇒ 认领失效，Y 就能改 src/a 了 ──
  await run('alpha.x', 'master_report', { task: 'L1106-1', state: '完成', action: '改完了', body: `改了 ${A('src/a/x1.txt')}、${A('shared.txt')}` })
  await run('alpha.y', 'write', { file_path: A('src/a/later.txt'), content: 'Y later\n' })
  expect(fs.readFileSync(A('src/a/later.txt'), 'utf8')).toBe('Y later\n')

  // ── 往项目外写：直接写被沙盒拒；申请放宽弹「等你批」，批之前文件不在 ──
  await run('alpha.x', 'write', { file_path: path.join(outside, 'o.txt'), content: 'o' })
  expect(await hist('alpha.x')).toMatch(/FS_SANDBOX_DENIED|denied under workspace-write/)
  await run('alpha.x', 'bash', { description: 'outside', command: `echo o > ${path.join(outside, 'b.txt')}` })
  expect(fs.existsSync(path.join(outside, 'o.txt')) || fs.existsSync(path.join(outside, 'b.txt'))).toBe(false)
  await prompt('alpha.x', call('write', { file_path: path.join(outside, 'o.txt'), content: 'o', sandbox_permissions: 'danger-full-access', justification: '把产物交到项目外的目录' }))
  await sb.waitFor('等你批', async () => ((await sb.get('/dsh-master-debug/waiting')) as any[]).some((w: any) => w.session === 'alpha.x' && w.kind === 'approval'), 30_000)
  expect(fs.existsSync(path.join(outside, 'o.txt'))).toBe(false)

  // ── 看板：任务详情显示认领（已失效）和越界 / 冲突 / 提交被拦的事件 ──
  const chrome = await launchChrome({ port: await freePort(), profileDir: path.join(base, 'chrome') })
  cleanups.push(() => chrome.kill())
  const p: CdpPage = await chrome.page()
  const board = `[...document.querySelectorAll('[data-testid=dsh-master-board]')].find(e=>e.offsetParent!==null)`
  for (const [w, hgt] of [[1280, 860], [390, 844]] as const) {
    await p.size(w, hgt); await p.open(`${sb.url}/?token=${tokenOf(sb)}`, 5000)
    await p.ev(`(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='继续');el&&(el.closest('button')||el).click()})()`); await sleep(600)
    await p.waitFor('探针客户端', `!!window.__g6probe`, 15_000)
    await p.ev(`window.__g6probe.openSession('a-master')`); await sleep(2000)
    await p.ev(`[...document.querySelectorAll('[data-testid=dshm-header-board]')].find(e=>e.offsetParent!==null)?.click()`)
    await p.waitFor('alpha 看板', `${board}?.dataset.project === 'alpha' && !!${board}.querySelector('[data-task="L1106-1"]')`, 20_000)
    await p.ev(`${board}.querySelector('[data-task="L1106-1"]').click()`)
    await p.waitFor('任务详情', `!!document.querySelector('[data-testid=dshm-claims]')`, 10_000)
    expect(await p.ev<string>(`document.querySelector('[data-testid=dshm-claims]').innerText`)).toMatch(/^认领（已失效）：\s*src\/a/)
    await p.waitFor('时间线事件', `document.querySelector('[data-testid=dshm-timeline]')?.innerText.includes('被宿主拦下')`, 10_000)
    const tl = await p.ev<string>(`document.querySelector('[data-testid=dshm-timeline]').innerText`)
    expect(tl).toContain('alpha.y 想改 src/a/hack.txt，被拦下：在 L1106-1（alpha.x）认领的 src/a 里')
    expect(tl).toContain('alpha.x 改 shared.txt 被宿主拦下：读过以后别人改过（乐观锁），要重读再改')
    expect(tl).toContain('alpha.x 想动 git，被拦下（成员不提交）')
    await p.ev(`document.querySelector('[data-testid=dshm-claims]').scrollIntoView({block:'start'})`); await sleep(300)
    await p.shot(path.join(OUT, `${w}-task-claims.png`))
    await p.ev(`[...document.querySelectorAll('[data-testid=dshm-timeline] [data-kind=event]')].find(e=>e.innerText.includes('被宿主拦下'))?.scrollIntoView({block:'center'})`); await sleep(300)
    await p.shot(path.join(OUT, `${w}-task-events.png`))
    expect(await p.ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
  }
  await p.close()
}, 400_000)
