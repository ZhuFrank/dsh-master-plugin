/** 独立无头 Chrome + 极简 CDP 客户端（测试用；自己的 user-data-dir，测完按 PID 关）。 */
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export interface CdpPage {
  send(method: string, params?: any): Promise<any>
  ev<T = any>(js: string): Promise<T>
  /** clip：只截页面上这一块（CSS 像素）。 */
  shot(file: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void>
  size(w: number, h: number): Promise<void>
  open(url: string, waitMs?: number): Promise<void>
  waitFor<T>(what: string, js: string, timeoutMs?: number): Promise<T>
  /**
   * G11-5：用真实鼠标事件（CDP Input.dispatchMouseEvent）点 js 选出来的元素的中心；找不到返回 false。
   * 比脚本 element.click() 更接近用户操作（点在哪个元素上由页面决定）。注意：0.2.2 选择题卡片上旧测试点不中，
   * 原因是旧选择器找错了元素（不是选项本身），不是卡片不认脚本点击——反向验证 g115-click 证实过脚本 click 点对元素也行。
   */
  click(js: string): Promise<boolean>
  close(): Promise<void>
}
export interface Chrome { port: number; page(): Promise<CdpPage>; kill(): Promise<void> }

export async function launchChrome(opts: { port: number; profileDir: string }): Promise<Chrome> {
  fs.mkdirSync(opts.profileDir, { recursive: true })
  const proc: ChildProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // G8：关掉组件下载（设备端模型 optimization_guide_model_store 约 41M 等），实测一个用户目录 53M → 2.6M；几个 feature 必须写在同一个 --disable-features 里
    ['--headless=new', '--disable-features=MacAppCodeSignClone,OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints',
      '--disable-component-update', '--disable-background-networking', '--disable-gpu-shader-disk-cache',
      `--remote-debugging-port=${opts.port}`, `--user-data-dir=${opts.profileDir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${opts.port}/json/version`); break } catch { await sleep(250) } }
  return {
    port: opts.port,
    async page() {
      const tab = await (await fetch(`http://127.0.0.1:${opts.port}/json/new?about:blank`, { method: 'PUT' })).json()
      const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r))
      let id = 0; const pend = new Map<number, (m: any) => void>()
      ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id) } })
      const send = (method: string, params: any = {}) => new Promise<any>(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
      const ev = async (js: string) => { const r = await send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate 失败'); return r.result?.result?.value }
      await send('Page.enable'); await send('Runtime.enable')
      const p: CdpPage = {
        send, ev,
        async shot(file, clip) { const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')) },
        async size(w, h) {
          const mobile = w < 700
          await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile })
          await send('Emulation.setTouchEmulationEnabled', { enabled: mobile })
          await send('Emulation.setUserAgentOverride', { userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' : '' })
        },
        async open(url, waitMs = 6000) { await send('Page.navigate', { url }); await sleep(waitMs) },
        async click(js) {
          const c = await ev(`(()=>{const e=(${js});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
          if (!c) return false
          for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 })
          return true
        },
        async waitFor(what, js, timeoutMs = 20_000) {
          const until = Date.now() + timeoutMs; let last: unknown
          while (Date.now() < until) { try { const v = await ev(js); if (v) return v } catch (e) { last = e } await sleep(300) }
          throw new Error(`页面等待超时：${what}${last ? `（${String(last)}）` : ''}`)
        },
        async close() { ws.close(); await fetch(`http://127.0.0.1:${opts.port}/json/close/${tab.id}`).catch(() => {}) },
      }
      return p
    },
    async kill() { if (proc.exitCode === null) { proc.kill(); await Promise.race([new Promise(r => proc.once('exit', r)), sleep(5000)]) } },
  }
}
