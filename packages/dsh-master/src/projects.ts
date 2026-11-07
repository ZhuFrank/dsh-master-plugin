/**
 * G6-1 项目登记表 + 按项目打开数据层（plan-v3「二、1 / 2」）。
 * - 项目 = git 仓库根（真实路径）；不在仓库里的目录，项目根就是它自己。
 * - 项目 ID：根目录名转小写 kebab；被别的根占了就加真实路径哈希的前 4 位。真实路径是唯一键，同一个根永远是同一个 ID。
 * - 每个项目：运行库集中在 <状态目录>/projects/<ID>/（master.db、memory.db）；文档在 <项目根>/.dsh-master/docs/。
 * - 总管会话 ID = 项目 ID；成员 = <项目 ID>.<名字>（宿主会话 ID 允许「.」，G6-1 实测）。
 * 这里只管数据层；开张（session/created）、守卫、.git/info/exclude 在 G6-2。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { MemoryLayer } from 'dsh-master-devlog'
import { Store } from './store.ts'
import { Core, type CoreOptions, type SessionPort } from './core.ts'
import { Delivery, type DeliveryPort } from './delivery.ts'
import { Attribution } from './attrib.ts'
import { bjtIso, type Clock } from './time.ts'

/** 从 cwd 往上找 .git（目录或 worktree 的 .git 文件）；找不到就用 cwd 自己。返回真实路径。 */
export function findProjectRoot(cwd: string): string {
  let cur = fs.realpathSync(cwd)
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur
    const up = path.dirname(cur)
    if (up === cur) return fs.realpathSync(cwd)
    cur = up
  }
}

/** 目录名 → 小写 kebab（只留 a-z 0-9 -；中文等其他字符去掉；空了就叫 project）。 */
export function slugOf(root: string): string {
  const s = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s || 'project'
}
export const shortHash = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 4)

export interface ProjectRow { id: string; root: string; master: string; created_at: string; status: 'active' | 'archived' }

export class ProjectRegistry {
  readonly db: DatabaseSync
  constructor(readonly file: string, private readonly clock: Clock) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const fresh = !fs.existsSync(file)
    this.db = new DatabaseSync(file)
    if (fresh) fs.chmodSync(file, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, master TEXT NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')));`)
  }
  byId(id: string): ProjectRow | undefined { return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined }
  byRoot(root: string): ProjectRow | undefined { return this.db.prepare('SELECT * FROM projects WHERE root = ?').get(root) as ProjectRow | undefined }
  list(): ProjectRow[] { return this.db.prepare(`SELECT * FROM projects WHERE status = 'active' ORDER BY created_at, id`).all() as unknown as ProjectRow[] }
  /** 给一个目录找项目（已登记的直接返回，不登记）。 */
  find(cwd: string): ProjectRow | undefined { return this.byRoot(findProjectRoot(cwd)) }
  /** 登记（已登记就原样返回）：ID 撞了就加哈希。master：总管会话 ID（用户自己建的会话是宿主起的 ID；不给就等于项目 ID）。 */
  ensure(cwd: string, master?: string): ProjectRow {
    const root = findProjectRoot(cwd)
    const had = this.byRoot(root)
    if (had) return had
    let id = slugOf(root)
    if (this.byId(id)) id = `${id}-${shortHash(root)}`
    for (let i = 2; this.byId(id); i++) id = `${slugOf(root)}-${shortHash(root)}-${i}` // 哈希前 4 位也撞了（极少）
    this.db.prepare('INSERT INTO projects(id, root, master, created_at) VALUES(?,?,?,?)').run(id, root, master ?? id, bjtIso(this.clock()))
    return this.byId(id)!
  }
}

export interface ProjectPaths { runtimeDir: string; dbFile: string; memoryDb: string; docsRoot: string }
export function projectPaths(stateDir: string, p: ProjectRow): ProjectPaths {
  const runtimeDir = path.join(stateDir, 'projects', p.id)
  return { runtimeDir, dbFile: path.join(runtimeDir, 'master.db'), memoryDb: path.join(runtimeDir, 'memory.db'), docsRoot: path.join(p.root, '.dsh-master', 'docs') }
}
/** 成员会话 ID 前缀。 */
export const memberPrefixOf = (p: ProjectRow) => `${p.id}.`

export interface ProjectContext { project: ProjectRow; paths: ProjectPaths; store: Store; mem: MemoryLayer; delivery: Delivery; core: Core; attrib: Attribution }
/** 按项目打开数据层：每个项目自己的库、记忆层、总管 ID、成员前缀。两个项目之间什么都不共用。 */
export function openProject(stateDir: string, p: ProjectRow, deps: { deliveryPort: DeliveryPort; sessionPort: SessionPort; clock: Clock; core?: Omit<CoreOptions, 'mem' | 'masterId' | 'memberPrefix'> }): ProjectContext {
  const paths = projectPaths(stateDir, p)
  const store = new Store(paths.dbFile)
  const mem = new MemoryLayer({ dbFile: paths.memoryDb, docsRoot: paths.docsRoot, clock: deps.clock })
  const delivery = new Delivery(store, deps.deliveryPort, deps.clock)
  const core = new Core(store, delivery, deps.sessionPort, deps.clock, { idleGraceMs: 120_000, ...deps.core, mem, masterId: p.master, memberPrefix: memberPrefixOf(p) })
  const attrib = new Attribution(store, core, deps.clock)
  return { project: p, paths, store, mem, delivery, core, attrib }
}

/** 项目的文档目录（<根>/.dsh-master/）—— 守卫保护它；只能经插件工具改。 */
export const projectDotDir = (root: string) => path.join(root, '.dsh-master')

/**
 * 开张时把 `.dsh-master/` 写进这个仓库本机的排除表（.git/info/exclude，不改 repo 的 .gitignore）。
 * worktree 的 .git 是文件，用 `git rev-parse --git-path info/exclude` 找真正的位置。没有 git 就跳过。
 * 返回写到的文件（已经有这一行时也返回它），没写返回 undefined。
 */
export function gitExclude(root: string): string | undefined {
  if (!fs.existsSync(path.join(root, '.git'))) return undefined
  let file: string
  try { file = path.resolve(root, execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) } catch { return undefined }
  const line = '/.dsh-master/'
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (cur.split('\n').some(l => l.trim() === line)) return file
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}# dsh-master 的任务书 / devlog / 手册（本机，不进 git）\n${line}\n`)
  return file
}

/**
 * owner 文件 <根>/.dsh-master/owner：记下是哪个实例（状态目录）在管这个项目，防止两个实例同时开同一个项目、一起写文档。
 * 已经被别的状态目录占着 ⇒ 返回占用者，不改文件；没人占或是自己 ⇒ 写上自己，返回 undefined。
 */
export function claimOwner(root: string, stateDir: string): { stateDir: string; host?: string; pid?: number; at?: string } | undefined {
  const f = path.join(projectDotDir(root), 'owner')
  try {
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (cur?.stateDir && path.resolve(cur.stateDir) !== path.resolve(stateDir)) return cur
  } catch { /* 没有或坏了 ⇒ 重写 */ }
  fs.mkdirSync(projectDotDir(root), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ stateDir: path.resolve(stateDir), host: os.hostname(), pid: process.pid, at: new Date().toISOString() }, null, 2) + '\n')
  return undefined
}
