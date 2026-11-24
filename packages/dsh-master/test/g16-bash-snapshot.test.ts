/**
 * G16-2：bash 守卫判断快照。快照文件是在改 Windows 支持之前、用当时的代码（d7c7c47）生成的；
 * 之后 bash 的判断必须逐条一样（Mac / Linux 不变的证据）。以后有意改 bash 规则，就更新快照（vitest -u）并在回报里写明。
 * 只在非 Windows 上跑：bash 工具只在 Mac / Linux 上有（DSH 在 win32 上关掉 tool-bash），win32 的 path 语义也不同。
 * 不带 workdir 的条目全在这里；带 workdir 的是预期变化（G16 Q5），在 g16-windows.test.ts 里单独断言。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { guardDecision, bashWriteTargets, type GuardCall, type GuardConfig } from '../src/guard.ts'

const HOME = '/home/u'
const STATE = '/home/u/.dsh/dsh-master'
const ROOT = '/w/proj'
const DOT = '/w/proj/.dsh-master'
const OUT = '/w/proj/.dsh-master/out'
const LOGS = '/home/u/.dsh/logs'
const env = { HOME, DSH_HOME: '/home/u/.dsh' }

/** 路径写法：绝对 / 变量 / ~ / 相对 / 产物目录 / 无关目录 / 实例日志 */
const TARGETS = [
  `${STATE}/master.db`, '$DSH_HOME/dsh-master/docs/board.md', '${DSH_HOME}/dsh-master/x', '~/.dsh/dsh-master/memory.db',
  `${DOT}/docs/board.md`, '.dsh-master/docs/board.md', '.dsh-master/out/r.md', `${OUT}/r.md`,
  'src/a.ts', '/tmp/x.txt', `${LOGS}/dsh.log`, '$DSH_HOME/logs/dsh.log',
]
/** 命令形状：读、写、重定向、解释器、git、重活、等待 */
const SHAPES = [
  'cat {P}', 'ls -la {P}', 'grep -n x {P}', 'head -5 {P} 2>/dev/null', 'wc -l {P} >/dev/null 2>&1',
  'echo x > {P}', 'echo x >> {P}', 'printf y | tee {P}', 'cp a.md {P}', 'mv {P} b.md', 'rm -rf {P}', 'sed -i "" s/a/b/ {P}',
  'touch {P}', 'sqlite3 {P} "select 1"', 'python3 -c "open(\'{P}\',\'w\')"', 'node -e "1" {P}', 'tar xf a.tar -C {P}',
  'cd /w/proj && echo x > {P}', 'false && echo x >> {P}', 'cat {P} | wc -l',
]
const EXTRA = [
  'git status', 'git diff HEAD', 'git log -3', 'git add .', 'git commit -m x', 'git -C /w/proj commit -m x', 'git checkout main',
  'git checkout -- a.md', 'git restore a.md', 'git stash', 'git push', 'ffmpeg -i a.mp4 b.mp4', 'whisper a.wav', 'hyperframes render x',
  'blender -b x.blend', 'sleep 5', 'make && sleep 1', 'ls', 'echo hi', 'npm test', 'pnpm build > /tmp/b.log',
]
const ROLES: Array<'master' | 'exec' | undefined> = ['master', 'exec', undefined]
const CWDS = [ROOT, STATE, DOT, OUT, HOME, undefined]

function configs(): Array<[string, GuardConfig]> {
  const base = { protectedPaths: [STATE, DOT], env }
  return [
    ['plain', base],
    ['allow', { ...base, allowPaths: [OUT] }],
    ['allow+noGit+secret', { ...base, allowPaths: [OUT], noGit: true, secretPaths: [LOGS] }],
  ]
}

function corpus(): Array<{ key: string; call: GuardCall; cfg: GuardConfig }> {
  const cmds = [...SHAPES.flatMap(s => TARGETS.map(t => s.replaceAll('{P}', t))), ...EXTRA]
  const out: Array<{ key: string; call: GuardCall; cfg: GuardConfig }> = []
  for (const [cn, cfg] of configs()) for (const role of ROLES) for (const cwd of CWDS) {
    for (const command of cmds) out.push({ key: `${cn}|${role ?? '-'}|${cwd ?? '-'}|bash|${command}`, call: { name: 'bash', args: { command }, role, cwd }, cfg })
    out.push({ key: `${cn}|${role ?? '-'}|${cwd ?? '-'}|bash-timeout`, call: { name: 'bash', args: { command: 'ls', timeoutMs: 60_000 }, role, cwd }, cfg })
    for (const p of TARGETS.filter(t => !t.includes('$'))) for (const name of ['write', 'edit', 'read']) {
      out.push({ key: `${cn}|${role ?? '-'}|${cwd ?? '-'}|${name}|${p}`, call: { name, args: { file_path: p, content: 'x' }, role, cwd }, cfg })
    }
    out.push({ key: `${cn}|${role ?? '-'}|${cwd ?? '-'}|job_output`, call: { name: 'job_output', args: { wait: true, timeout_ms: 60_000 }, role, cwd }, cfg })
  }
  return out
}

const SNAP = path.join(import.meta.dirname, '__snapshots__')
const h8 = (v: unknown) => v === undefined || v === null ? '-' : createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 8)

/** 快照文件：第一行是语料条数和语料键的 sha256，之后每条一行（判断结果的短哈希，放行写 -），顺序和语料一致。
 *  不一致时列出是哪几条（键 + 现在的结果）。G16_SNAPSHOT_UPDATE=1 时重写（有意改 bash 规则时才用，回报里写明）。 */
function checkSnapshot(file: string, rows: Array<{ key: string; value: unknown }>) {
  const keysSha = createHash('sha256').update(rows.map(r => r.key).join('\n')).digest('hex')
  const lines = [`# corpus ${rows.length} keys-sha256 ${keysSha}`, ...rows.map(r => h8(r.value))]
  const full = path.join(SNAP, file)
  if (process.env.G16_SNAPSHOT_UPDATE === '1' || (!fs.existsSync(full) && !process.env.CI)) {
    fs.mkdirSync(SNAP, { recursive: true }); fs.writeFileSync(full, lines.join('\n') + '\n'); return
  }
  const want = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n')
  expect(want[0], '语料变了（条数或键）：先确认是有意的，再 G16_SNAPSHOT_UPDATE=1 重写').toBe(lines[0])
  const diff = rows.flatMap((r, i) => want[i + 1] === lines[i + 1] ? [] : [`${r.key} ⇒ ${JSON.stringify(r.value ?? null)}`])
  expect(diff.slice(0, 20), `和改动前不一样的有 ${diff.length} 条`).toEqual([])
}

describe.skipIf(process.platform === 'win32')('G16-2 bash 守卫判断快照（Mac / Linux 不变）', () => {
  it('guardDecision 逐条和改动前一样', () => {
    const rows = corpus()
    expect(rows.length).toBeGreaterThan(2000)
    checkSnapshot('g16-bash-guard.snap', rows.map(r => ({ key: r.key, value: guardDecision(r.call, r.cfg) })))
  })
  it('bashWriteTargets（认领 / 前情推送用）逐条和改动前一样', () => {
    const cmds = [...SHAPES.flatMap(s => TARGETS.map(t => s.replaceAll('{P}', t))), ...EXTRA]
    checkSnapshot('g16-bash-write-targets.snap', CWDS.flatMap(cwd => cmds.map(c => ({ key: `${cwd ?? '-'}|${c}`, value: bashWriteTargets(c, cwd, env) }))))
  })
})
