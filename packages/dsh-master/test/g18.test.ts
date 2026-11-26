/**
 * G18：凭据文件（$DSH_HOME/.credentials.yaml 存模型 key 和网页登录 cookie 的签名密钥、$DSH_HOME/.env、$DSH_HOME/liveshare/）
 * 任何会话都不能读写——成员、未入编会话、总管都一样；logs 照旧只给总管（G7 行为不变）。
 * 来源：T028 G2-2 Windows 沙盒里归档成员读到 .credentials.yaml 223 个字符（log.md 第 24 项）。
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { guardDecision, NO_CREDENTIAL, NO_SECRET, type GuardConfig } from '../src/guard.ts'

const ROLES = ['exec', undefined, 'master'] as const

// ---------------- posix ----------------
const H = '/home/u/.dsh'
const px: GuardConfig = {
  protectedPaths: [`${H}/dsh-master`, '/w/.dsh-master'], allowPaths: ['/w/.dsh-master/out'], secretPaths: [`${H}/logs`],
  credentialPaths: [`${H}/.credentials.yaml`, `${H}/.env`, `${H}/liveshare`],
  env: { HOME: '/home/u', DSH_HOME: H }, pathImpl: path.posix,
}
const pcall = (name: string, args: unknown, role: typeof ROLES[number], cwd = '/w') => guardDecision({ name, args, role, cwd }, px)
const bash = (command: string, role: typeof ROLES[number], cwd = '/w', extra: Record<string, unknown> = {}) => pcall('bash', { command, ...extra }, role, cwd)

const POSIX_DENY: Array<[string, unknown, string?]> = [
  ['read', { file_path: `${H}/.credentials.yaml` }],
  ['read', { path: '~/.dsh/.credentials.yaml' }],
  ['read', { file_path: '.credentials.yaml' }, H],
  ['read', { file_path: `${H}/.env` }],
  ['read', { path: `${H}/liveshare/owner-shares.json` }],
  ['read', { file_path: `${H}/.cred*` }],
  ['grep', { pattern: 'sk-', path: H }],
  ['grep', { pattern: 'sk-' }, H],
  ['write', { file_path: `${H}/.credentials.yaml`, content: 'x' }],
  ['edit', { file_path: `${H}/.env`, old_string: 'a', new_string: 'b' }],
  ['bash', { command: `cat ${H}/.credentials.yaml` }],
  ['bash', { command: 'cat "$DSH_HOME/.credentials.yaml"' }],
  ['bash', { command: 'cat "$DSH_HOME"/.credentials.yaml' }],
  ['bash', { command: 'cat ${DSH_HOME}/.credentials.yaml | wc -c' }],
  ['bash', { command: 'wc -c ~/.dsh/.credentials.yaml' }],
  ['bash', { command: 'cd $DSH_HOME && cat .credentials.yaml' }],
  ['bash', { command: 'cd ~/.dsh; head -c 20 .env' }],
  ['bash', { command: 'cat .credentials.yaml', workdir: H }],
  ['bash', { command: 'cat .credentials.yaml' }, H],
  ['bash', { command: `python3 -c "print(open('${H}/.credentials.yaml').read())"` }],
  ['bash', { command: 'base64 $DSH_HOME/.credentials.yaml' }],
  ['bash', { command: 'cat $DSH_HOME/.cred*' }],
  ['bash', { command: 'cat ~/.dsh/*.yaml' }],
  ['bash', { command: `cat ${H}/.c?edentials.yaml` }],
  ['bash', { command: 'cat $DSH_HOME/.*' }],
  ['bash', { command: 'cat $DSH_HOME/*' }],
  ['bash', { command: 'grep -r sk- $DSH_HOME' }],
  ['bash', { command: 'grep -rn "secret" ~/.dsh/' }],
  ['bash', { command: 'rg sk- ~/.dsh' }],
  ['bash', { command: 'tar czf /tmp/x.tgz ~/.dsh' }],
  ['bash', { command: 'cp -r $DSH_HOME /tmp/copy' }],
  ['bash', { command: 'find $DSH_HOME -type f -exec cat {} +' }],
  ['bash', { command: 'grep -r sk- .' }, H],
  ['bash', { command: 'F=.credentials.yaml; cat $DSH_HOME/$F' }],
  ['bash', { command: 'cat $X/.credentials.yaml' }],
  ['bash', { command: `cat ${H}/liveshare/owner-shares.json` }],
  ['bash', { command: `cp ${H}/.env /tmp/e` }],
]
const POSIX_ALLOW: Array<[string, unknown, string?]> = [
  ['bash', { command: 'cat .env' }],                         // 项目自己的 .env（工作目录 /w）
  ['bash', { command: 'cat /w/.env.example' }],
  ['bash', { command: `cat ${H}/.envrc` }],                  // 边界：.env 不能命中 .envrc
  ['bash', { command: 'ls -la $DSH_HOME' }],                 // 只列名字
  ['bash', { command: 'ls ~/.dsh/sessions' }],
  ['bash', { command: `cat ${H}/AGENTS.md` }],
  ['bash', { command: 'grep -r TODO /w/src' }],
  ['bash', { command: 'grep -rn foo ~/projects' }],
  ['bash', { command: 'find $DSH_HOME -name "*.md"' }],     // find 不带 -exec 只列名字
  ['read', { file_path: '/w/config.yaml' }],
  ['read', { file_path: '/w/.env' }],
  ['grep', { pattern: 'x', path: '/w' }],
  ['glob', { pattern: '**/*.yaml', path: H }],               // 只列名字
]

describe('G18 凭据文件（posix）', () => {
  for (const role of ROLES) {
    it(`${role ?? '未入编'}：各种读写法都拦`, () => {
      for (const [name, args, cwd] of POSIX_DENY) expect([name, args, pcall(name, args, role, cwd)]).toEqual([name, args, NO_CREDENTIAL])
    })
    it(`${role ?? '未入编'}：项目文件、DSH_HOME 里的非凭据、只列名字的照常放行`, () => {
      for (const [name, args, cwd] of POSIX_ALLOW) expect([name, args, pcall(name, args, role, cwd)]).toEqual([name, args, undefined])
    })
  }
  it('logs 行为不变：成员和未入编拦 NO_SECRET，总管能读', () => {
    expect(bash(`cat ${H}/logs/dsh.log`, 'exec')).toBe(NO_SECRET)
    expect(bash('tail $DSH_HOME/logs/dsh.log', undefined)).toBe(NO_SECRET)
    expect(pcall('read', { file_path: `${H}/logs/dsh.log` }, 'exec')).toBe(NO_SECRET)
    expect(bash(`cat ${H}/logs/dsh.log`, 'master')).toBeUndefined()
    expect(pcall('read', { file_path: `${H}/logs/dsh.log` }, 'master')).toBeUndefined()
  })
  it('没配 credentialPaths 时不拦（旧行为，配置为空的兜底）', () => {
    const { credentialPaths: _drop, ...noCred } = px
    expect(guardDecision({ name: 'read', args: { file_path: `${H}/.credentials.yaml` }, role: 'exec', cwd: '/w' }, noCred)).toBeUndefined()
  })
  it('heavy_run 提交前的检查也拦（总管也不能借重活读）', () => {
    expect(guardDecision({ name: 'bash', args: { command: 'cat $DSH_HOME/.credentials.yaml' }, role: 'master', cwd: '/w' }, { ...px, context: 'heavy' })).toBe(NO_CREDENTIAL)
  })
  it('拦的提示不复述路径以外的东西（不含 sk- 之类）', () => {
    expect(NO_CREDENTIAL).not.toMatch(/sk-|secret:/)
    expect(NO_CREDENTIAL).toContain('总管也不行')
  })
})

// ---------------- Windows ----------------
const W = path.win32
const WH = 'E:\\dsh-home'
const wx: GuardConfig = {
  protectedPaths: [`${WH}\\dsh-master`, 'E:\\proj\\.dsh-master'], allowPaths: ['E:\\proj\\.dsh-master\\out'], secretPaths: [`${WH}\\logs`],
  credentialPaths: [`${WH}\\.credentials.yaml`, `${WH}\\.env`, `${WH}\\liveshare`],
  env: { USERPROFILE: 'C:\\Users\\u', DSH_HOME: WH }, pathImpl: W,
}
const wcall = (name: string, args: unknown, role: typeof ROLES[number], cwd = 'E:\\proj') => guardDecision({ name, args, role, cwd }, wx)

const WIN_DENY: Array<[string, unknown, string?]> = [
  ['read', { path: `${WH}\\.credentials.yaml` }],
  ['read', { file_path: 'e:/DSH-HOME/.Credentials.yaml' }],
  ['read', { path: `${WH}\\.env` }],
  ['pwsh', { command: `Get-Content ${WH}\\.credentials.yaml` }],
  ['pwsh', { command: 'Get-Content "$env:DSH_HOME\\.credentials.yaml" | Measure-Object -Character' }],
  ['pwsh', { command: "(gc 'E:/dsh-home/.credentials.yaml' -Raw).Length" }],
  ['pwsh', { command: `type ${WH}\\.credentials.yaml` }],
  ['pwsh', { command: `[IO.File]::ReadAllText('${WH}\\.credentials.yaml').Length` }],
  ['pwsh', { command: `cmd /c type ${WH}\\.credentials.yaml` }],
  ['pwsh', { command: `Set-Location ${WH}; Get-Content .credentials.yaml` }],
  ['pwsh', { command: 'cd $env:DSH_HOME; gc .env' }],
  ['pwsh', { command: 'Get-Content .credentials.yaml', workdir: WH }],
  ['pwsh', { command: 'Get-Content .credentials.yaml' }, WH],
  ['pwsh', { command: "Get-Content (Join-Path $env:DSH_HOME '.credentials.yaml')" }],
  ['pwsh', { command: '$p = "$env:DSH_HOME"; Get-Content "$p\\.credentials.yaml"' }],
  ['pwsh', { command: 'gc $env:DSH_HOME\\.cred*' }],
  ['pwsh', { command: 'Get-Content $env:DSH_HOME\\*' }],
  ['pwsh', { command: 'Get-Content E:\\DSH-HOME\\.CREDENTIALS.YAML' }],
  ['pwsh', { command: 'Select-String -Path $env:DSH_HOME\\* -Pattern sk-' }],
  ['pwsh', { command: 'Get-ChildItem $env:DSH_HOME -Recurse -File | Get-Content' }],
  ['pwsh', { command: 'Compress-Archive -Path $env:DSH_HOME -DestinationPath E:\\proj\\x.zip' }],
  ['pwsh', { command: `Copy-Item ${WH}\\.env E:\\proj\\e.txt` }],
  ['pwsh', { command: 'findstr /s sk- .\\*' }, WH],
  ['pwsh', { command: `Get-Content ${WH}\\liveshare\\owner-shares.json` }],
]
const WIN_ALLOW: Array<[string, unknown, string?]> = [
  ['pwsh', { command: 'Get-Content .env' }],
  ['pwsh', { command: 'Get-ChildItem $env:DSH_HOME' }],
  ['pwsh', { command: 'Get-Content E:\\proj\\notes.md' }],
  ['pwsh', { command: 'Select-String -Path E:\\proj\\* -Pattern TODO' }],
  ['pwsh', { command: `Get-Content ${WH}\\AGENTS.md` }],
  ['read', { path: 'E:\\proj\\.env' }],
]

describe('G18 凭据文件（Windows 路径）', () => {
  for (const role of ROLES) {
    it(`${role ?? '未入编'}：read / PowerShell 各写法都拦`, () => {
      for (const [name, args, cwd] of WIN_DENY) expect([name, args, wcall(name, args, role, cwd)]).toEqual([name, args, NO_CREDENTIAL])
    })
    it(`${role ?? '未入编'}：项目文件照常放行`, () => {
      for (const [name, args, cwd] of WIN_ALLOW) expect([name, args, wcall(name, args, role, cwd)]).toEqual([name, args, undefined])
    })
  }
  it('logs 行为不变', () => {
    expect(wcall('pwsh', { command: `Get-Content ${WH}\\logs\\dsh.log` }, 'exec')).toBe(NO_SECRET)
    expect(wcall('pwsh', { command: `Get-Content ${WH}\\logs\\dsh.log` }, 'master')).toBeUndefined()
  })
})
