/**
 * 等宿主的可选服务（比如 schedule）就绪。插件刚启动时宿主的服务可能还没注册好，ctx.get 拿到 undefined；
 * 以前拿不到就悄悄跳过（G6-5 在 3090 上：存档模式启动太快，删旧总管定时保底的代码拿不到 schedule，什么都没删）。
 */
export async function waitService<T>(get: () => T | undefined, opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T | undefined> {
  const timeout = opts.timeoutMs ?? 60_000, step = opts.intervalMs ?? 1000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); (t as any).unref?.() }))
  for (let waited = 0; ; waited += step) {
    const s = get()
    if (s) return s
    if (waited >= timeout) return undefined
    await sleep(step)
  }
}
