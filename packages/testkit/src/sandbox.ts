/**
 * 沙盒 DSH：临时 DSH_HOME + DSH_AGENTS_HOME、随机端口、假模型、link 装 dsh-master；测完按 PID 关。
 * 绝不碰 ~/.dsh。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { startMockLlm, type MockLlm } from './mock-llm.ts'
import { assertOutsideRepos } from './guard.ts'

export interface SandboxOptions {
  /** 测试名：决定临时目录名和假模型日志文件名。 */
  name: string
  /** 要装进 profile 的插件包目录（绝对路径）。 */
  plugins: string[]
  /** 追加给 dsh-master 插件行的配置。 */
  pluginConfig?: Record<string, unknown>
  /** 测试产物根目录（日志、home）。 */
  root: string
  slowMs?: number
  /** 假模型声明的输入模态（默认只有 text）。 */
  mockInput?: string[]
  /** 去掉 GIT_CONFIG_* 之后再给沙盒 DSH 进程加的环境变量（探针用，比如复现宿主的环境变量行为）。 */
  envOverride?: Record<string, string>
}

/** 去掉 GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n（见 start() 里的说明）。 */
export function withoutGitConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)))
}

export interface Sandbox {
  home: string
  port: number
  url: string
  mock: MockLlm
  logDir: string
  pid(): number | undefined
  start(): Promise<void>
  stop(signal?: NodeJS.Signals): Promise<void>
  restart(): Promise<void>
  dispose(): Promise<void>
  get<T = any>(p: string): Promise<T>
  post<T = any>(p: string, body: unknown): Promise<T>
  waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs?: number): Promise<T>
}

export async function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = net.createServer(); s.unref()
    s.on('error', bad)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)) })
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function yaml(v: unknown, indent: number): string {
  return JSON.stringify(v, null, 0).replace(/^/, ' '.repeat(indent)) // JSON 是合法 YAML（flow 风格）
}

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  assertOutsideRepos(opts.root, '沙盒目录')
  const stamp = `${opts.name}-${Date.now()}`
  const base = path.join(opts.root, stamp)
  const home = path.join(base, 'home')
  const agentsHome = path.join(base, 'agents-home')
  const logDir = path.join(base, 'logs')
  for (const d of [home, agentsHome, logDir]) fs.mkdirSync(d, { recursive: true })
  const mock = await startMockLlm({ logFile: path.join(logDir, `mock-requests.${opts.name}.jsonl`), slowMs: opts.slowMs })
  const port = await freePort()

  // profile：只写文件，不跑 pnpm；插件用 node_modules 软链（与 dsh plugin add link: 的结果一致）
  const profile = path.join(home, 'profiles', 'master')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  const names: string[] = []
  for (const dir of opts.plugins) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    names.push(pkg.name)
    const link = path.join(profile, 'node_modules', ...pkg.name.split('/'))
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(dir, link)
  }
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-master', private: true,
    dependencies: Object.fromEntries(names.map((n, i) => [n, `link:${opts.plugins[i]}`])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...names] } } }, null, 2))
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n')
  fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  // G10：公开版默认不建旧总管（legacy off）、项目总管默认 workspace-write。G1–G9 的端到端是照旧单元、完全权限写的，沙盒默认照旧；
  // 测公开版默认值的用例（g10-release）显式传 legacy: undefined / projectMasterPreset: undefined 把这两项拿掉。
  const cfg = Object.fromEntries(Object.entries({ stateDir: path.join(home, 'dsh-master'), debugControl: true, pumpIntervalMs: 500, legacy: 'active', projectMasterPreset: 'danger-full-access', ...opts.pluginConfig }).filter(([, v]) => v !== undefined))
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '# 沙盒 profile（testkit 生成）',
    '- id: agent-default-model', '  config:', '    provider: mock', '    model: mock-1',
    '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        displayName: Mock (testkit)', '        apiKeyEnv: DSHM_MOCK_KEY',
    '        api: openai-completions', `        baseURL: ${mock.baseURL}`, '        models:', '          - id: mock-1', '            name: Mock 1',
    '            contextWindow: 131072', '            reasoningEfforts: false', ...(opts.mockInput ? [`            input: ${JSON.stringify(opts.mockInput)}`] : []), '        retryPolicy:', '          mode: normal', '          maxRetries: 0',
    '- id: dsh-master', '  config:', yaml(cfg, 4), '',
  ].join('\n'))

  let child: ChildProcess | undefined
  let starts = 0
  const url = `http://127.0.0.1:${port}`
  const get = async (p: string) => { const r = await fetch(url + p); const t = await r.text(); if (!r.ok) throw new Error(`GET ${p} ${r.status} ${t}`); return JSON.parse(t) }
  const post = async (p: string, body: unknown) => { const r = await fetch(url + p, { method: 'POST', body: JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(`POST ${p} ${r.status} ${t}`); return JSON.parse(t) }
  const waitFor = async <T,>(what: string, fn: () => any, timeoutMs = 60_000): Promise<T> => {
    const until = Date.now() + timeoutMs
    let lastErr: unknown
    while (Date.now() < until) {
      try { const v = await fn(); if (v !== undefined && v !== false && v !== null) return v as T } catch (e) { lastErr = e }
      await sleep(300)
    }
    throw new Error(`等待超时：${what}${lastErr ? `（最后错误：${String(lastErr)}）` : ''}`)
  }

  const sb: Sandbox = {
    home, port, url, mock, logDir,
    pid: () => child?.pid,
    get, post, waitFor,
    async start() {
      if (child) throw new Error('already started')
      starts++
      const out = fs.openSync(path.join(logDir, `dsh.${starts}.log`), 'a')
      child = spawn('dsh', ['--profile', 'master', '--no-open', '--port', String(port)], {
        cwd: base, stdio: ['ignore', out, out], detached: false,
        // G10：去掉 GIT_CONFIG_*。跑测试的 shell 里有 GIT_CONFIG_COUNT/KEY_n/VALUE_n 时，DSH 的 bash 沙盒只把 COUNT 传给命令、
        // KEY/VALUE 不传 ⇒ 沙盒里所有 git 命令报「missing config key GIT_CONFIG_KEY_0」。这是宿主行为，测试不该被开发机环境左右。
        env: { ...withoutGitConfigEnv(process.env), DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, DSHM_MOCK_KEY: 'dummy-not-a-secret', ...opts.envOverride },
      })
      fs.closeSync(out)
      const c = child
      c.on('exit', () => { if (child === c) child = undefined })
      await waitFor('沙盒 DSH 起来且 dsh-master 就绪', async () => {
        if (!child) throw new Error(`dsh 进程已退出，见 ${logDir}/dsh.${starts}.log`)
        // 插件启动流程走完（G6-5：旧单元存档后旧总管不加载，不能再拿「master 不是 cold」当就绪）
        const r = await get('/dsh-master-debug/ready').catch(() => undefined)
        if (r?.ready === true) return r
        const s = await get('/dsh-master-debug/state')
        return r === undefined && s.sessions?.some((x: any) => x.id === 'master' && x.live !== 'cold') ? s : undefined
      }, 90_000)
    },
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      const c = child
      if (!c?.pid) return
      const exited = new Promise<void>(r => c.once('exit', () => r()))
      c.kill(signal)
      await Promise.race([exited, sleep(15_000)])
      if (child === c && c.exitCode === null) { c.kill('SIGKILL'); await Promise.race([exited, sleep(5_000)]) }
      child = undefined
    },
    async restart() { await sb.stop(); await sb.start() },
    async dispose() { await sb.stop(); await mock.close() },
  }
  return sb
}
