import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryLayer } from 'dsh-master-devlog'
import { Core, MASTER_ID } from '../src/core.ts'
import { Delivery } from '../src/delivery.ts'
import { Store } from '../src/store.ts'
import { checkPost, readLimited, filterTasks, validateAction } from '../src/panel-api.ts'
import { PanelService, gateKey, type PanelPort, type TurnText } from '../src/panel-service.ts'
import { Attribution } from '../src/attrib.ts'
import { fileAddress, findPaths, stripHeader, NotifyBatcher, notifyItems, escapeIntrawordStars, linkItemNos, inlineNoParts, checkPath } from '../src/client/index.ts'
import { tmpdir, fakeClock, FakeDeliveryPort, FakeSessionPort } from './helpers.ts'

describe('面板 · 读请求体', () => {
  it('readLimited：超过上限返回 too_large（不保存超出的部分）', async () => {
    const big = new Request('http://x/', { method: 'POST', body: Buffer.alloc(2048) })
    expect(await readLimited(big, 1024)).toBe('too_large')
    const huge = new Request('http://x/', { method: 'POST', body: Buffer.alloc(8192) })
    expect(await readLimited(huge, 1024, 4096)).toBe('too_large')
    const small = new Request('http://x/', { method: 'POST', body: Buffer.alloc(100) })
    expect((await readLimited(small, 1024) as Buffer).length).toBe(100)
  })
})

describe('面板 · POST 请求头与动作白名单', () => {
  // 宿主转进来的 URL 是 http://dsh.internal/…，Host 头才是浏览器访问的地址
  const req = (h: Record<string, string>) => { const r = new Request('http://dsh.internal/api/dsh-master/action', { method: 'POST', headers: h, body: '{}' }); return r }
  const good = { host: '127.0.0.1:3090', origin: 'http://127.0.0.1:3090', 'x-dsh-master': '1', 'content-type': 'application/json' }
  it('Origin 必须是本服务、必须带 x-dsh-master、content-type 必须对', () => {
    expect(checkPost(req(good))).toBeUndefined()
    expect(checkPost(req({ ...good, origin: 'http://evil.example' }))).toMatch(/origin/)
    expect(checkPost(req({ ...good, origin: 'http://127.0.0.1:3091' }))).toMatch(/origin/) // 端口不同
    expect(checkPost(req({ ...good, origin: 'null' }))).toMatch(/origin/)
    expect(checkPost(req({ ...good, host: '192.168.0.5:3082', origin: 'http://192.168.0.5:3082' }))).toBeUndefined() // pocket 局域网入口：同源即可
    const { origin: _o, ...noOrigin } = good
    expect(checkPost(req(noOrigin))).toMatch(/origin/)
    const { 'x-dsh-master': _x, ...noHeader } = good
    expect(checkPost(req(noHeader))).toMatch(/x-dsh-master/)
    expect(checkPost(req({ ...good, 'content-type': 'text/plain' }))).toMatch(/content-type/)
    expect(checkPost(req({ ...good, 'content-type': 'application/octet-stream' }))).toMatch(/content-type/)
  })
  it('白名单只有 answer / done / cancel / confirm_tag；G4c 删掉的 send / upload / new_task 一律拒', () => {
    for (const action of ['send', 'new_task', 'upload', 'rm -rf']) expect(validateAction({ action, text: 'hi', title: 't' })).toMatchObject({ error: expect.stringMatching(/不支持/) })
    expect(validateAction({ action: 'answer', ask: '1', answer: 'x' })).toMatchObject({ error: expect.stringMatching(/正整数/) })
    expect(validateAction({ action: 'cancel', task: 'T009', note: '不做了' })).toEqual({ action: 'cancel', task: 'T009', note: '不做了' })
    expect(validateAction({ action: 'done', task: 'DROP TABLE' })).toMatchObject({ error: expect.stringMatching(/格式/) })
    expect(validateAction({ action: 'confirm_tag', session: 'master', turn: 3, task: 'T005' })).toEqual({ action: 'confirm_tag', session: 'master', turn: 3, task: 'T005' })
    expect(validateAction({ action: 'confirm_tag', session: '../x y', turn: 3, task: 'T005' })).toMatchObject({ error: expect.stringMatching(/session/) })
    expect(validateAction({ action: 'confirm_tag', session: 'master', turn: 0, task: 'T005' })).toMatchObject({ error: expect.stringMatching(/turn/) })
  })
})

describe('面板 · 视图筛选', () => {
  const day = 24 * 3600_000; const now = Date.parse('2026-11-20T12:00:00+08:00')
  const t = (id: string, state: string, created: string, updated: string) => ({ id, kind: 'light' as const, title: id, owner: 'exec-a', state, gate: null, meta: '{}', created_at: created, updated_at: updated })
  const tasks = [t('L1101-1', '进行中', '2026-11-01T10:00:00+08:00', '2026-11-01T10:00:00+08:00'),
    t('L1110-1', '完成', '2026-11-10T10:00:00+08:00', new Date(now - 8 * day).toISOString()),
    t('L1118-1', '取消', '2026-11-18T10:00:00+08:00', new Date(now - 1 * day).toISOString())]
  it('进行中 + 结束 7 天内 / 已归档（结束超过 7 天）', () => {
    expect(filterTasks(tasks, 'active', now).map(x => x.id)).toEqual(['L1101-1', 'L1118-1'])
    expect(filterTasks(tasks, 'archived', now).map(x => x.id)).toEqual(['L1110-1'])
    expect(filterTasks(tasks, 'all', now)).toHaveLength(3)
  })
  it('按派出日期（北京时间，含首尾）', () => {
    expect(filterTasks(tasks, 'all', now, { from: '2026-11-10', to: '2026-11-18' }).map(x => x.id)).toEqual(['L1110-1', 'L1118-1'])
    expect(filterTasks(tasks, 'all', now, { to: '2026-11-01' }).map(x => x.id)).toEqual(['L1101-1'])
  })
})

class FakePanelPort implements PanelPort {
  prompts: Array<{ sessionId: string; content: any[] }> = []
  reads = 0
  turns = new Map<string, TurnText>()
  async promptUser(sessionId: string, _r: string, content: any[]) { this.prompts.push({ sessionId, content }) }
  async turnText(sessionId: string, turn: number) { this.reads++; return this.turns.get(`${sessionId}:${turn}`) }
}
function setupPanel() {
  const dir = tmpdir('panel'); const clock = fakeClock()
  const store = new Store(path.join(dir, 'master.db'))
  const mem = new MemoryLayer({ dbFile: path.join(dir, 'memory.db'), docsRoot: path.join(dir, 'docs'), clock })
  const dport = new FakeDeliveryPort()
  const core = new Core(store, new Delivery(store, dport, clock), new FakeSessionPort(), clock, { idleGraceMs: 1000, mem })
  const attrib = new Attribution(store, core, clock)
  const pport = new FakePanelPort()
  const panel = new PanelService(store, core, attrib, pport, clock)
  return { dir, clock, store, core, attrib, pport, panel, dport }
}
const flush = () => new Promise(r => setImmediate(r))

describe('面板 · 动作效果', () => {
  let s: ReturnType<typeof setupPanel>
  beforeEach(async () => {
    s = setupPanel(); await s.core.ensureMaster(tmpdir('m'))
    await s.core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
    await s.core.dispatch({ task: 'L1103-1', kind: 'light', title: 't', to: 'a', text: '做' }, MASTER_ID)
  })
  it('answer：等你定标为已回答、告诉总管；回答过的不能再答', async () => {
    const { id } = await s.core.askUser({ task: 'L1103-1', question: '用 A 还是 B？', options: ['A', 'B'] })
    // G11-1 起负责人在岗时答案直投成员（见 g11.test.ts）；这里关掉负责人，测退回总管的那条路
    s.store.closeSession('exec-a', new Date().toISOString())
    await s.panel.act({ action: 'answer', ask: id, answer: 'A' })
    expect(s.store.getAsk(id)).toMatchObject({ state: 'answered', answer: 'A' })
    expect(s.pport.prompts.at(-1)!.content[0].text).toContain('回答：A')
    expect(s.pport.prompts.at(-1)!.content[0].text).toContain('（@L1103-1）') // 写成 @任务，这一轮直接归到它
    await expect(s.panel.act({ action: 'answer', ask: id, answer: 'B' })).rejects.toThrow(/回答过/)
  })
  it('cancel / done：变成终态、通知执行会话（取消用 followup 叫停）；之后的回报算迟到回报不改状态', async () => {
    await s.panel.act({ action: 'cancel', task: 'L1103-1', note: '不需要了' })
    expect(s.store.getTask('L1103-1')!.state).toBe('取消')
    await flush()
    const toOwner = s.dport.calls.filter(c => c.to === 'exec-a' && c.text.includes('取消了 L1103-1'))
    expect(toOwner.map(c => c.mode)).toEqual(['followup'])
    await expect(s.panel.act({ action: 'done', task: 'L1103-1' })).rejects.toThrow(/已经是「取消」/)
    const r: any = await s.core.report({ task: 'L1103-1', state: '完成', action: '做完了' }, 'exec-a')
    expect(r.late).toBe(true)
    expect(s.store.getTask('L1103-1')!.state).toBe('取消')
  })
  it('confirm_tag：把某一轮定为某任务（第 0 层，压过其他层）；时间线出现这一轮', async () => {
    s.attrib.processStep(MASTER_ID, 4, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '顺便看下 L1103-1 的情况' }] }])
    expect(s.attrib.turnsOf(MASTER_ID)).toEqual([{ turn: 4, primary: null, also: [], maybe: ['L1103-1'] }])
    await s.panel.act({ action: 'confirm_tag', session: MASTER_ID, turn: 4, task: 'L1103-1' })
    expect(s.attrib.turnsOf(MASTER_ID)[0]!.primary).toMatchObject({ task: 'L1103-1', layer: 0 })
    const turns = s.panel.thread('L1103-1').items.filter((i: any) => i.kind === 'turn')
    expect(turns).toMatchObject([{ session: MASTER_ID, turn: 4, role: 'primary', why: '你确认的', excerpt: '顺便看下 L1103-1 的情况' }])
    await expect(s.panel.act({ action: 'confirm_tag', session: MASTER_ID, turn: 99, task: 'L1103-1' })).rejects.toThrow(/没有第 99 轮/)
    await expect(s.panel.act({ action: 'confirm_tag', session: 'exec-zz', turn: 4, task: 'L1103-1' })).rejects.toThrow(/花名册/)
  })
  it('产物列表：回报里出现过的文件路径（新的在前，去重）+ 任务书的产物目录', async () => {
    await s.core.report({ task: 'L1103-1', state: '进展', action: '写了 /Users/x/a.md', body: '读数 42，见 /Users/x/b.png' }, 'exec-a')
    await s.core.report({ task: 'L1103-1', state: '就绪', action: '改好 /Users/x/a.md 和 /tmp/c.txt' }, 'exec-a')
    expect(s.panel.thread('L1103-1').task!.products).toEqual(['/Users/x/a.md', '/tmp/c.txt', '/Users/x/b.png'])
  })
  it('展开一轮：按会话 + 轮次从会话记录读全文；结束的轮次缓存，没结束的每次现读；不在花名册的拒', async () => {
    s.pport.turns.set('master:3', { turn: 3, seqStart: 10, seqEnd: 20, ended: true, parts: [{ role: 'user', text: '原话', seq: 11 }, { role: 'assistant', text: '**回复**全文', seq: 19 }] })
    s.pport.turns.set('master:4', { turn: 4, seqStart: 21, seqEnd: null, ended: false, parts: [] })
    expect((await s.panel.turnFull(MASTER_ID, 3)).parts.map(p => p.text)).toEqual(['原话', '**回复**全文'])
    await s.panel.turnFull(MASTER_ID, 3); expect(s.pport.reads).toBe(1)
    await s.panel.turnFull(MASTER_ID, 4); await s.panel.turnFull(MASTER_ID, 4); expect(s.pport.reads).toBe(3)
    await expect(s.panel.turnFull('nobody', 3)).rejects.toThrow(/花名册/)
    await expect(s.panel.turnFull(MASTER_ID, 99)).rejects.toThrow(/没有第 99 轮/)
  })
  it('闸门格子按开头 G 编号合并：「G1」与「G1（实现 + 自测）」算一个；G4b 不和 G4 合并', () => {
    expect(['G1', 'G1（实现 + 自测）', ' g2 收尾', 'G4b', 'G4', '试运行'].map(gateKey)).toEqual(['G1', 'G1', 'G2', 'G4b', 'G4', '试运行'])
    const at = '2026-11-03T21:00:00+08:00'
    s.store.addEvent({ at, task: 'L1103-1', session: 'exec-a', type: 'task/dispatched', data: { gate: 'G1（实现 + 自测）' } })
    s.store.addEvent({ at, task: 'L1103-1', session: 'exec-a', type: 'task/report', data: { gate: 'G1', line: 'x' } })
    s.store.addEvent({ at, task: 'L1103-1', session: MASTER_ID, type: 'task/reviewed', data: { gate: 'G1', verdict: '通过' } })
    s.store.addEvent({ at, task: 'L1103-1', session: 'exec-a', type: 'task/dispatched', data: { gate: 'G2（收尾）' } })
    s.store.updateTask('L1103-1', { gate: 'G2（收尾）' }, at)
    expect(s.panel.thread('L1103-1').task!.gates).toEqual([{ gate: 'G1', state: 'passed' }, { gate: 'G2', state: 'current' }])
  })
  it('会话页：花名册、在线、未结任务、最近回报', async () => {
    await s.core.report({ task: 'L1103-1', state: '进展', action: '做到一半' }, 'exec-a')
    const rows = s.panel.sessionsView()
    const a = rows.find(r => r.id === 'exec-a')!
    expect(a.open.map(t => t.id)).toEqual(['L1103-1'])
    expect(a.lastReport?.line).toMatch(/\[L1103-1\] 状态=进展/)
  })
})

describe('面板 · 客户端小工具', () => {
  it('fileAddress 照宿主写法：工作区内转相对；工作区外保留开头 /', () => {
    expect(fileAddress('master', '/w', '/w/docs/a b.md')).toBe('dsh-resource://file/session/master/docs/a%20b.md')
    expect(fileAddress('master', '/w', '/x/y.md')).toBe('dsh-resource://file/session/master//x/y.md')
  })
  it('stripHeader：只去掉开头那一段插件消息头', () => {
    expect(stripHeader('[dsh-master 消息 · 来自 master · 发给 exec-w · L1103-1 · 派活 · 2026-11-03 2108]（消息键 dispatch:L1103-1:-:57f6）派活：写')).toBe('派活：写')
    expect(stripHeader('正文里提到 [dsh-master 消息 · x]（消息键 y） 不去')).toBe('正文里提到 [dsh-master 消息 · x]（消息键 y） 不去')
  })
  it('G5-F ④ findPaths：路径后紧跟全角标点 / 空白都算结束（3090 上 L1103-7 / L1103-8 的真实回报）', () => {
    expect(findPaths('产物：/Users/alice/work/.tmp/e2e-1105/stats.md（601B，16 行；该目录下唯一文件）')).toEqual(['/Users/alice/work/.tmp/e2e-1105/stats.md'])
    expect(findPaths('写入 /Users/alice/work/.tmp/e2e-1105/choice.txt（181B，4 行）')).toEqual(['/Users/alice/work/.tmp/e2e-1105/choice.txt'])
    for (const p of ['）', '：', '，', '。', '；', '、', '！', '？', ' ', '\n', ',', ';', '. '])
      expect(findPaths(`见 /tmp/x/a.md${p}后面`), JSON.stringify(p)).toEqual(['/tmp/x/a.md'])
    expect(findPaths('两个：/tmp/a.md、/tmp/b.txt；还有 /tmp/c.json。')).toEqual(['/tmp/a.md', '/tmp/b.txt', '/tmp/c.json'])
    expect(findPaths('/tmp/a.md.bak 是备份')).toEqual(['/tmp/a.md.bak'])
  })
  it('findPaths：只认绝对路径 + 扩展名，去掉标点', () => {
    expect(findPaths('产物 /Users/alice/x/hello.py，任务书：/Users/alice/.dsh-master/dsh-master/docs/tasks/T101.md。和 `/tmp/a.txt`')).toEqual(
      ['/Users/alice/x/hello.py', '/Users/alice/.dsh-master/dsh-master/docs/tasks/T101.md', '/tmp/a.txt'])
    expect(findPaths('没有路径 /Users/alice 只有目录')).toEqual([])
  })
})

describe('面板 · 浏览器通知合并', () => {
  it('第一批只当基线；之后新条目 60 秒内合并成一条；旧条目不重复', () => {
    const b = new NotifyBatcher(60_000)
    expect(b.feed([{ key: 'a', text: 'A' }], 0)).toBeUndefined()                        // 基线
    expect(b.feed([{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], 1000)).toEqual({ title: '总管看板', body: 'B' })
    expect(b.feed([{ key: 'c', text: 'C' }], 5000)).toBeUndefined()                      // 60 秒内：攒着
    expect(b.feed([{ key: 'd', text: 'D' }, { key: 'b', text: 'B' }], 30_000)).toBeUndefined()
    expect(b.flush(61_000)).toEqual({ title: '总管看板：2 件事', body: 'C\nD' })        // 到点合并
    expect(b.flush(200_000)).toBeUndefined()
  })
  it('notifyItems：等你定、等你处理的任务；结束的任务不算', () => {
    const items = notifyItems({ asks: [{ id: 3, task: 'T1', question: '选哪个' }],
      tasks: [{ id: 'T1', state: '待验收', title: 'x', closed: false }, { id: 'T2', state: '进行中', title: 'y', closed: false }, { id: 'T3', state: '取消', title: 'z', closed: true }] })
    expect(items.map(i => i.key)).toEqual(['ask:3', 'task:T1:待验收'])
  })
})

describe('面板 · 接口只挂 connection.fetch（钉子）', () => {
  it('源码里 webServer.register 只有一处：debugControl 打开时的 /dsh-master-debug；面板路由都在 connection.fetch 下', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '../src/index.ts'), 'utf8')
    const web = [...src.matchAll(/webServer\.register\(\{[^}]*path: '([^']+)'/g)].map(m => m[1])
    expect(web).toEqual(['/dsh-master-debug'])
    expect(src).toMatch(/if \(config\.debugControl\) registerDebug\(/)
    const fetchRoutes = [...src.matchAll(/(?:getRoute\(|connection\.fetch\.register\(\{ path: )'([^']+)'/g)].map(m => m[1])
    expect(fetchRoutes.sort()).toEqual(['/api/dsh-master/action', '/api/dsh-master/candidates', '/api/dsh-master/projects', '/api/dsh-master/refs', '/api/dsh-master/sessions', '/api/dsh-master/state', '/api/dsh-master/thread', '/api/dsh-master/turn', '/api/dsh-master/turns', '/api/dsh-master/whoami'])
    expect(src).not.toMatch(/dsh-master\/upload/) // G4c 删掉的上传接口不再挂
  })
})

describe('面板 · G5-E Markdown 预处理与路径白名单', () => {
  it('单星号：字母 / 数字中间的 * 转义（宿主会把 5*3*2 吃成斜体），*x* 与代码里的不动', () => {
    expect(escapeIntrawordStars('5*3*2 和 a*b*c')).toBe('5\\*3\\*2 和 a\\*b\\*c')
    expect(escapeIntrawordStars('斜体 *x*，单独一个 * 号')).toBe('斜体 *x*，单独一个 * 号')
    expect(escapeIntrawordStars('代码 `5*3*2` 和\n```\n5*3*2\n```')).toBe('代码 `5*3*2` 和\n```\n5*3*2\n```')
  })
  it('#编号：只有属于当前时间线的才变链接；等你定 #N、代码、URL 里的不动', () => {
    const nos = new Set([12, 40])
    expect(linkItemNos('见 #12 和 #13，回答等你定 #40，`#12`，https://a.com/#12，[x](#12)', nos))
      .toBe('见 [#12](dshm-item/12) 和 #13，回答等你定 #40，`#12`，https://a.com/#12，[x](#12)')
    expect(inlineNoParts('先看 #40 再看 #7', nos)).toEqual(['先看 ', { no: 40 }, ' 再看 #7'])
    expect(inlineNoParts('没有编号', nos)).toEqual(['没有编号'])
  })
  it('路径白名单：会话工作目录和 docs 目录里的文件放行；..、隐藏段、带协议、目录外拒绝；相对路径按作者工作目录解析', () => {
    const roots = ['/w', '/h/.dsh-master/dsh-master/docs']
    expect(checkPath('/w/a.md', roots)).toEqual({ ok: true, abs: '/w/a.md' })
    expect(checkPath('docs/x.md', roots, '/w')).toEqual({ ok: true, abs: '/w/docs/x.md' })
    expect(checkPath('./b//c.md', roots, '/w')).toEqual({ ok: true, abs: '/w/b/c.md' })
    expect(checkPath('/h/.dsh-master/dsh-master/docs/handbooks/m.md', roots)).toMatchObject({ ok: true }) // 根目录本身带隐藏段没关系
    for (const [p, why] of [['../../etc/passwd', /\.\./], ['/w/../etc/passwd', /\.\./], ['/w/.git/config', /隐藏/], ['manager/.waiting/x.md', /隐藏/],
      ['/etc/passwd', /不在允许/], ['javascript:alert(1)', /不是文件路径/], ['file:///etc/hosts', /不是文件路径/], ['', /空/]] as const)
      expect(checkPath(p, roots, '/w'), p).toMatchObject({ ok: false, why: expect.stringMatching(why) })
    expect(checkPath('a.md', roots)).toMatchObject({ ok: false, why: expect.stringMatching(/基准/) })
  })
})

describe('面板 · G7 ⑨ 结案后补问的等你定', () => {
  it('轻任务按「完成」结案后总管再补问 ⇒ 过了 7 天仍在近 7 天视图（带着等你定），不进已归档', async () => {
    const s = setupPanel(); await s.core.ensureMaster(tmpdir('m'))
    await s.core.spawn({ name: 'a', cwd: tmpdir('a'), title: 'A' }, MASTER_ID)
    await s.core.dispatch({ task: 'L1107-1', kind: 'light', title: 't', to: 'a', text: '做' }, MASTER_ID)
    await s.core.report({ task: 'L1107-1', state: '完成', action: '做完了' }, 'exec-a')
    expect(s.store.getTask('L1107-1')!.state).toBe('完成')
    await s.core.askUser({ task: 'L1107-1', question: '音色能用吗？', options: ['能', '不能'] })
    s.clock.advance(8 * 24 * 3600_000)
    const active = s.panel.state({ view: 'active' })
    expect(active.tasks.map((t: any) => [t.id, t.closed, t.openAsks])).toEqual([['L1107-1', true, 1]])
    expect(s.panel.state({ view: 'archived' }).tasks).toEqual([])
  })
})
