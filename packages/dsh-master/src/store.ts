/**
 * 总管状态库（node:sqlite，WAL，文件权限 0600）。
 * 只有插件进程写；events / messages 两张表由触发器保证只能追加。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export type Role = 'master' | 'exec'
export type SessionStatus = 'active' | 'closed'
export type TaskKind = 'light' | 'heavy'
export type DeliveryMode = 'followup' | 'steer' | 'inject'
export type DeliveryState = 'pending' | 'delivered' | 'error'

export interface SessionRow { id: string; role: Role; title: string; cwd: string; handbook: string | null; status: SessionStatus; created_at: string; closed_at: string | null }
export interface TaskRow { id: string; kind: TaskKind; title: string; owner: string; state: string; gate: string | null; meta: string; created_at: string; updated_at: string }
export interface EventRow { seq: number; at: string; task: string | null; session: string | null; type: string; data: string }
export interface MessageRow { seq: number; at: string; at_ms: number; key: string; from_id: string; to_id: string; task: string | null; mode: DeliveryMode; text: string }
export interface DeliveryRow { key: string; to_id: string; from_id: string; mode: DeliveryMode; text: string; summary: string; state: DeliveryState; attempts: number; next_at_ms: number; last_error: string | null; created_at: string; updated_at: string }
export interface AttribDbRow { session: string; turn: number; task: string; layer: number; reason: string; at: string; at_ms: number }
export interface TurnTextRow { session: string; turn: number; at: string; at_ms: number; excerpt: string }
export interface AskRow { id: number; code: string; task: string; question: string; options: string; state: 'open' | 'answered'; answer: string | null; created_at: string; answered_at: string | null }
export interface GateRow { task: string; gate: string; title: string; produces: string; ord: number; defined_at: string }
/** Q 编号：Q<月日>-<序号>。created_at 是北京时间 ISO（2026-11-05T23:11:00+08:00）。 */
export const Q_CODE_RE = /^Q\d{4}-\d{1,3}$/

/** 每个迁移只追加，不改旧的。 */
const MIGRATIONS: string[] = [
  `CREATE TABLE sessions(
     id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('master','exec')), title TEXT NOT NULL, cwd TEXT NOT NULL,
     handbook TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')), created_at TEXT NOT NULL, closed_at TEXT);
   CREATE TABLE tasks(
     id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('light','heavy')), title TEXT NOT NULL, owner TEXT NOT NULL,
     state TEXT NOT NULL, gate TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE events(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, task TEXT, session TEXT, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
   CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
   CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
   CREATE TABLE messages(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, at_ms INTEGER NOT NULL, key TEXT NOT NULL UNIQUE,
     from_id TEXT NOT NULL, to_id TEXT NOT NULL, task TEXT, mode TEXT NOT NULL, text TEXT NOT NULL);
   CREATE INDEX messages_pair ON messages(from_id, to_id, at_ms);
   CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'messages is append-only'); END;
   CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'messages is append-only'); END;
   CREATE TABLE deliveries(
     key TEXT PRIMARY KEY, to_id TEXT NOT NULL, from_id TEXT NOT NULL, mode TEXT NOT NULL, text TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL CHECK(state IN ('pending','delivered','error')), attempts INTEGER NOT NULL DEFAULT 0, next_at_ms INTEGER NOT NULL,
     last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX deliveries_due ON deliveries(state, next_at_ms);
   CREATE TABLE asks(
     id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]',
     state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','answered')), answer TEXT, created_at TEXT NOT NULL, answered_at TEXT);`,
  // v2（G3）：轮次时间落库（空闲兜底重启后不漏）、元数据、重活队列
  `CREATE TABLE turns(session TEXT PRIMARY KEY, started_ms INTEGER, last_report_ms INTEGER);
   CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
   CREATE TABLE heavy_jobs(
     id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, label TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL, min_free_gb REAL NOT NULL,
     state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed')), exit_code INTEGER, log TEXT NOT NULL,
     created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);`,
  // v3（G4c）：每轮的归属（会话 + 轮次 + 任务，层级只往小的改）和每轮的摘句
  `CREATE TABLE turn_attrib(session TEXT NOT NULL, turn INTEGER NOT NULL, task TEXT NOT NULL, layer INTEGER NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY(session, turn, task));
   CREATE INDEX turn_attrib_task ON turn_attrib(task);
   CREATE TABLE turn_text(session TEXT NOT NULL, turn INTEGER NOT NULL, at TEXT NOT NULL, at_ms INTEGER NOT NULL, excerpt TEXT NOT NULL, PRIMARY KEY(session, turn));`,
  // v4（G6-1）：闸门定义（编号 / ≤20 字标题 / 产物，task_spec_write 写入）；等你定加 Q 编号（Q<月日>-<序号>，按库编号 ⇒ 按项目编号），旧行按创建日补上
  `CREATE TABLE gates(task TEXT NOT NULL, gate TEXT NOT NULL, title TEXT NOT NULL, produces TEXT NOT NULL DEFAULT '', ord INTEGER NOT NULL, defined_at TEXT NOT NULL, PRIMARY KEY(task, gate));
   ALTER TABLE asks ADD COLUMN code TEXT;
   UPDATE asks SET code = 'Q' || substr(created_at, 6, 2) || substr(created_at, 9, 2) || '-' ||
     (SELECT count(*) FROM asks a2 WHERE substr(a2.created_at, 1, 10) = substr(asks.created_at, 1, 10) AND a2.id <= asks.id);
   CREATE UNIQUE INDEX asks_code ON asks(code);`,
]
/** 当前库结构版本（自检命令用它判断库和插件是否匹配）。 */
export const SCHEMA_VERSION = MIGRATIONS.length


export interface TurnRow { session: string; started_ms: number | null; last_report_ms: number | null }
export interface HeavyJobRow { id: number; session: string; label: string; command: string; cwd: string; min_free_gb: number; state: 'queued' | 'running' | 'done' | 'failed'; exit_code: number | null; log: string; created_at: string; started_at: string | null; ended_at: string | null }

export class Store {
  readonly db: DatabaseSync
  /** opts.maxVersion 只给测试用：建一个停在旧版本的库（验证升级）。 */
  constructor(readonly file: string, opts: { maxVersion?: number } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const fresh = !fs.existsSync(file)
    this.db = new DatabaseSync(file)
    if (fresh) fs.chmodSync(file, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const target = Math.min(opts.maxVersion ?? MIGRATIONS.length, MIGRATIONS.length)
    // 升级前先留一份完整副本（VACUUM INTO 是一致快照）：要回退就把它拷回来，旧版插件照样能读
    if (!fresh && this.version > 0 && this.version < target) {
      const bak = `${file}.pre-v${target}.bak`
      if (!fs.existsSync(bak)) { this.db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`); fs.chmodSync(bak, 0o600) }
    }
    this.migrate(target)
  }

  get version(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  }

  private migrate(target = MIGRATIONS.length): void {
    for (let v = this.version; v < target; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  private depth = 0
  /** 同步事务：fn 抛错就回滚。可嵌套（内层用 SAVEPOINT）。fn 里不能 await。 */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0
    const sp = `sp${this.depth}`
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`)
    this.depth++
    try {
      const out = fn()
      this.depth--
      this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`)
      return out
    } catch (error) {
      this.depth--
      this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
      throw error
    }
  }

  close(): void { this.db.close() }

  // ---- sessions ----
  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
  }
  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY created_at, id').all() as unknown as SessionRow[]
  }
  upsertSession(row: Omit<SessionRow, 'closed_at' | 'status'> & { status?: SessionStatus }): void {
    this.db.prepare(`INSERT INTO sessions(id, role, title, cwd, handbook, status, created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, cwd = excluded.cwd, handbook = excluded.handbook, status = 'active', closed_at = NULL`)
      .run(row.id, row.role, row.title, row.cwd, row.handbook, row.status ?? 'active', row.created_at)
  }
  closeSession(id: string, at: string): boolean {
    return Number(this.db.prepare(`UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'active'`).run(at, id).changes) > 0
  }

  // ---- tasks ----
  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  }
  listTasks(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC, id').all() as unknown as TaskRow[]
  }
  insertTask(row: TaskRow): void {
    this.db.prepare('INSERT INTO tasks(id, kind, title, owner, state, gate, meta, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.kind, row.title, row.owner, row.state, row.gate, row.meta, row.created_at, row.updated_at)
  }
  updateTask(id: string, patch: { state?: string; gate?: string | null; owner?: string }, at: string): void {
    const cur = this.getTask(id)
    if (!cur) throw new Error(`task not found: ${id}`)
    this.db.prepare('UPDATE tasks SET state = ?, gate = ?, owner = ?, updated_at = ? WHERE id = ?')
      .run(patch.state ?? cur.state, patch.gate === undefined ? cur.gate : patch.gate, patch.owner ?? cur.owner, at, id)
  }

  // ---- events（只追加）----
  addEvent(e: { at: string; task?: string | null; session?: string | null; type: string; data?: unknown }): number {
    const r = this.db.prepare('INSERT INTO events(at, task, session, type, data) VALUES(?,?,?,?,?)')
      .run(e.at, e.task ?? null, e.session ?? null, e.type, JSON.stringify(e.data ?? {}))
    return Number(r.lastInsertRowid)
  }
  events(filter: { task?: string; session?: string; type?: string; sinceSeq?: number; limit?: number } = {}): EventRow[] {
    const where: string[] = []; const args: (string | number)[] = []
    if (filter.task) { where.push('task = ?'); args.push(filter.task) }
    if (filter.session) { where.push('session = ?'); args.push(filter.session) }
    if (filter.type) { where.push('type = ?'); args.push(filter.type) }
    if (filter.sinceSeq !== undefined) { where.push('seq > ?'); args.push(filter.sinceSeq) }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${filter.limit ? 'DESC LIMIT ' + Number(filter.limit) : ''}`
    const rows = this.db.prepare(sql).all(...args) as unknown as EventRow[]
    return filter.limit ? rows.reverse() : rows
  }

  // ---- messages（只追加）+ deliveries ----
  getMessage(key: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE key = ?').get(key) as MessageRow | undefined
  }
  insertMessage(m: Omit<MessageRow, 'seq'>): void {
    this.db.prepare('INSERT INTO messages(at, at_ms, key, from_id, to_id, task, mode, text) VALUES(?,?,?,?,?,?,?,?)')
      .run(m.at, m.at_ms, m.key, m.from_id, m.to_id, m.task, m.mode, m.text)
  }
  countMessages(from: string, to: string, sinceMs: number): number {
    return Number((this.db.prepare('SELECT count(*) AS c FROM messages WHERE from_id = ? AND to_id = ? AND at_ms > ?').get(from, to, sinceMs) as { c: number }).c)
  }
  recentMessages(limit = 50): MessageRow[] {
    return (this.db.prepare('SELECT * FROM messages ORDER BY seq DESC LIMIT ?').all(limit) as unknown as MessageRow[]).reverse()
  }
  insertDelivery(d: DeliveryRow): void {
    this.db.prepare(`INSERT INTO deliveries(key, to_id, from_id, mode, text, summary, state, attempts, next_at_ms, last_error, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.key, d.to_id, d.from_id, d.mode, d.text, d.summary, d.state, d.attempts, d.next_at_ms, d.last_error, d.created_at, d.updated_at)
  }
  getDelivery(key: string): DeliveryRow | undefined {
    return this.db.prepare('SELECT * FROM deliveries WHERE key = ?').get(key) as DeliveryRow | undefined
  }
  dueDeliveries(nowMs: number): DeliveryRow[] {
    return this.db.prepare(`SELECT * FROM deliveries WHERE state = 'pending' AND next_at_ms <= ? ORDER BY rowid`).all(nowMs) as unknown as DeliveryRow[]
  }
  deliveriesByState(state: DeliveryState): DeliveryRow[] {
    return this.db.prepare('SELECT * FROM deliveries WHERE state = ? ORDER BY rowid').all(state) as unknown as DeliveryRow[]
  }
  markDelivery(key: string, patch: { state: DeliveryState; attempts: number; next_at_ms: number; last_error: string | null }, at: string): void {
    this.db.prepare('UPDATE deliveries SET state = ?, attempts = ?, next_at_ms = ?, last_error = ?, updated_at = ? WHERE key = ?')
      .run(patch.state, patch.attempts, patch.next_at_ms, patch.last_error, at, key)
  }

  // ---- turns（轮次时间落库）----
  getTurn(session: string): TurnRow | undefined {
    return this.db.prepare('SELECT * FROM turns WHERE session = ?').get(session) as TurnRow | undefined
  }
  listTurns(): TurnRow[] { return this.db.prepare('SELECT * FROM turns').all() as unknown as TurnRow[] }
  setTurnStart(session: string, ms: number): void {
    this.db.prepare('INSERT INTO turns(session, started_ms) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET started_ms = excluded.started_ms').run(session, ms)
  }
  setLastReport(session: string, ms: number): void {
    this.db.prepare('INSERT INTO turns(session, last_report_ms) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET last_report_ms = excluded.last_report_ms').run(session, ms)
  }

  // ---- meta ----
  getMeta(k: string): string | undefined { return (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v }
  setMeta(k: string, v: string): void { this.db.prepare('INSERT INTO meta(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v) }

  // ---- heavy jobs ----
  addHeavyJob(j: Omit<HeavyJobRow, 'id' | 'state' | 'exit_code' | 'started_at' | 'ended_at'>): number {
    return Number(this.db.prepare(`INSERT INTO heavy_jobs(session, label, command, cwd, min_free_gb, state, log, created_at) VALUES(?,?,?,?,?,'queued',?,?)`)
      .run(j.session, j.label, j.command, j.cwd, j.min_free_gb, j.log, j.created_at).lastInsertRowid)
  }
  heavyJobs(state?: HeavyJobRow['state']): HeavyJobRow[] {
    return (state ? this.db.prepare('SELECT * FROM heavy_jobs WHERE state = ? ORDER BY id').all(state) : this.db.prepare('SELECT * FROM heavy_jobs ORDER BY id').all()) as unknown as HeavyJobRow[]
  }
  updateHeavyJob(id: number, patch: { state: HeavyJobRow['state']; exit_code?: number | null; started_at?: string; ended_at?: string }): void {
    const cur = this.db.prepare('SELECT * FROM heavy_jobs WHERE id = ?').get(id) as unknown as HeavyJobRow
    this.db.prepare('UPDATE heavy_jobs SET state = ?, exit_code = ?, started_at = ?, ended_at = ? WHERE id = ?')
      .run(patch.state, patch.exit_code ?? cur.exit_code, patch.started_at ?? cur.started_at, patch.ended_at ?? cur.ended_at, id)
  }

  // ---- asks ----
  addAsk(a: { task: string; question: string; options: string[]; at: string }): number {
    return this.tx(() => {
      const day = a.at.slice(0, 10)
      const n = Number((this.db.prepare('SELECT count(*) AS c FROM asks WHERE substr(created_at, 1, 10) = ?').get(day) as { c: number }).c) + 1
      const code = `Q${a.at.slice(5, 7)}${a.at.slice(8, 10)}-${n}`
      return Number(this.db.prepare('INSERT INTO asks(task, question, options, created_at, code) VALUES(?,?,?,?,?)').run(a.task, a.question, JSON.stringify(a.options), a.at, code).lastInsertRowid)
    })
  }
  askByCode(code: string): AskRow | undefined { return this.db.prepare('SELECT * FROM asks WHERE code = ?').get(code) as AskRow | undefined }
  // ---- 闸门定义（G6-1）----
  setGates(task: string, gates: Array<{ gate: string; title: string; produces: string }>, at: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM gates WHERE task = ?').run(task)
      gates.forEach((g, i) => this.db.prepare('INSERT INTO gates(task, gate, title, produces, ord, defined_at) VALUES(?,?,?,?,?,?)').run(task, g.gate, g.title, g.produces, i, at))
    })
  }
  gatesFor(task: string): GateRow[] { return this.db.prepare('SELECT * FROM gates WHERE task = ? ORDER BY ord').all(task) as unknown as GateRow[] }
  gateDef(task: string, gate: string): GateRow | undefined { return this.db.prepare('SELECT * FROM gates WHERE task = ? AND gate = ?').get(task, gate) as GateRow | undefined }
  getAsk(id: number): AskRow | undefined { return this.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as AskRow | undefined }
  answerAsk(id: number, answer: string, at: string): boolean {
    return Number(this.db.prepare(`UPDATE asks SET state = 'answered', answer = ?, answered_at = ? WHERE id = ? AND state = 'open'`).run(answer, at, id).changes) > 0
  }
  asksFor(task: string): AskRow[] { return this.db.prepare('SELECT * FROM asks WHERE task = ? ORDER BY id').all(task) as unknown as AskRow[] }
  messagesFor(task: string | null): MessageRow[] {
    return (task === null ? this.db.prepare(`SELECT * FROM messages WHERE task IS NULL AND (from_id = 'user' OR to_id = 'user') ORDER BY seq`).all()
      : this.db.prepare('SELECT * FROM messages WHERE task = ? ORDER BY seq').all(task)) as unknown as MessageRow[]
  }
  // ---- 每轮归属（G4c）----
  /** 记一条归属；同一轮同一任务只往更强（层级更小）的改。 */
  addAttrib(r: AttribDbRow): void {
    this.db.prepare(`INSERT INTO turn_attrib(session, turn, task, layer, reason, at, at_ms) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(session, turn, task) DO UPDATE SET layer = excluded.layer, reason = excluded.reason, at = excluded.at, at_ms = excluded.at_ms WHERE excluded.layer < turn_attrib.layer`)
      .run(r.session, r.turn, r.task, r.layer, r.reason, r.at, r.at_ms)
  }
  attribsFor(session: string): AttribDbRow[] { return this.db.prepare('SELECT * FROM turn_attrib WHERE session = ? ORDER BY turn, layer').all(session) as unknown as AttribDbRow[] }
  /** 某任务涉及的所有轮次（含这些轮次里别的任务的行，好判断谁是主任务）。 */
  attribsTouching(task: string): AttribDbRow[] {
    return this.db.prepare(`SELECT a.* FROM turn_attrib a JOIN (SELECT DISTINCT session, turn FROM turn_attrib WHERE task = ?) t ON a.session = t.session AND a.turn = t.turn ORDER BY a.at_ms, a.layer`).all(task) as unknown as AttribDbRow[]
  }
  setTurnText(r: TurnTextRow): void { this.db.prepare('INSERT OR IGNORE INTO turn_text(session, turn, at, at_ms, excerpt) VALUES(?,?,?,?,?)').run(r.session, r.turn, r.at, r.at_ms, r.excerpt) }
  turnText(session: string, turn: number): TurnTextRow | undefined { return this.db.prepare('SELECT * FROM turn_text WHERE session = ? AND turn = ?').get(session, turn) as TurnTextRow | undefined }

  toUserMessages(limit: number): MessageRow[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE to_id = 'user' ORDER BY seq DESC LIMIT ?`).all(limit) as unknown as MessageRow[]).reverse()
  }
  openAsks(): AskRow[] {
    return this.db.prepare(`SELECT * FROM asks WHERE state = 'open' ORDER BY id`).all() as unknown as AskRow[]
  }
}
