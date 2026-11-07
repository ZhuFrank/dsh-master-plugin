// G5-G 研究探针：沙盒里看 / 改工作区与会话归档。只认 127.0.0.1。
export const name = 'g5g-probe'
export const inject = ['webServer', 'workspaceRegistry', 'sessionController']
export const injectOptional = ['sessionProjections', 'workingDirectory']
export function apply(ctx) {
  const created = []
  ctx.on('session/created', (session) => {
    const rec = { id: String(session?.id), at: Date.now() }
    try { rec.headerKeys = Object.keys(session?.header ?? {}); rec.headerCwd = session?.header?.cwd; rec.headerPreset = session?.header?.agentPreset ?? session?.header?.preset } catch (e) { rec.headerErr = String(e) }
    try { rec.projPreset = ctx.get?.('sessionProjections')?.stateOf?.(session, 'agentPreset') } catch (e) { rec.projErr = String(e) }
    try { rec.wd = ctx.get?.('workingDirectory')?.get?.(session) } catch (e) { rec.wdErr = String(e) }
    created.push(rec)
    // 稍后再读一次（预设可能是创建之后才写进去的）
    setTimeout(() => { try { rec.projPresetLater = ctx.get?.('sessionProjections')?.stateOf?.(session, 'agentPreset') } catch (e) { rec.laterErr = String(e) } }, 1500)
  })
  const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(v)) }
  const body = req => new Promise((ok, bad) => { let s = ''; req.on('data', c => { s += c }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}) } catch (e) { bad(e) } }) })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/g5g-probe', handler: async (req, res) => {
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { error: 'local only' })
      const p = new URL(req.url, 'http://x').pathname.replace(/^\/g5g-probe/, '')
      const reg = ctx.workspaceRegistry
      const view = () => ({ workspaces: reg.list().map(w => ({ id: w.id, title: w.title, path: w.path, sessionIds: [...(w.sessionIds ?? [])] })), archived: [...(reg.archivedSessionIds ?? [])] })
      if (p === '/workspaces') return json(res, 200, view())
      if (p === '/created-log') return json(res, 200, created)
      if (p === '/create-with-preset') { const b = await body(req); const ws = await reg.create(b.cwd); const v = await ctx.sessionController.create({ sessionId: b.id, workspaceId: ws.id, ...(b.preset ? { agentPreset: b.preset } : {}) }); return json(res, 200, v) }
      if (p === '/delete-workspace') { const b = await body(req); const ok = await reg.delete(b.id); return json(res, 200, { ok, ...view() }) }
      if (p === '/archive-session') { const b = await body(req); try { await reg.archiveSession(b.id, b.stop ? { stopActivity: true } : {}); return json(res, 200, { ok: true, ...view() }) } catch (e) { return json(res, 200, { ok: false, error: String(e?.message ?? e), ...view() }) } }
      if (p === '/unarchive-session') { const b = await body(req); await reg.unarchiveSession(b.id); return json(res, 200, { ok: true, ...view() }) }
      if (p === '/create-workspace') { const b = await body(req); const w = await reg.create(b.path); return json(res, 200, { id: w.id, ...view() }) }
      if (p === '/host-sessions') return json(res, 200, await ctx.sessionController.list({}, AbortSignal.timeout(10_000)))
      return json(res, 404, { error: 'unknown' })
    } catch (e) { return json(res, 500, { error: String(e?.stack ?? e) }) }
  } }))
}
