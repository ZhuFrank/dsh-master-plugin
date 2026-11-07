/** 记忆层自己的 SQLite（memory.db）：WAL、0600、只追加触发器、可嵌套事务。 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const MIGRATIONS: string[] = [
  `CREATE TABLE devlog(
     slug TEXT PRIMARY KEY, at TEXT NOT NULL, at_ms INTEGER NOT NULL, file TEXT NOT NULL, hook TEXT NOT NULL, tags TEXT NOT NULL,
     files_touched TEXT NOT NULL, depth TEXT NOT NULL, session TEXT, task TEXT, turn_key TEXT, related TEXT NOT NULL DEFAULT '[]', memories TEXT NOT NULL DEFAULT '[]');
   CREATE TABLE devlog_tags(slug TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(slug, tag));
   CREATE INDEX devlog_tags_tag ON devlog_tags(tag);
   CREATE TABLE devlog_files(slug TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(slug, path));
   CREATE TABLE devlog_amends(seq INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, at TEXT NOT NULL, line TEXT NOT NULL);
   CREATE TRIGGER devlog_amends_no_update BEFORE UPDATE ON devlog_amends BEGIN SELECT RAISE(ABORT, 'devlog_amends is append-only'); END;
   CREATE TRIGGER devlog_amends_no_delete BEFORE DELETE ON devlog_amends BEGIN SELECT RAISE(ABORT, 'devlog_amends is append-only'); END;
   CREATE TRIGGER devlog_no_delete BEFORE DELETE ON devlog BEGIN SELECT RAISE(ABORT, 'devlog is append-only'); END;
   CREATE TABLE decisions(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, decision TEXT NOT NULL, reasoning TEXT NOT NULL, context_slug TEXT NOT NULL, supersedes INTEGER, line TEXT NOT NULL);
   CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions is append-only'); END;
   CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions is append-only'); END;
   CREATE TABLE memories(
     name TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')), description TEXT NOT NULL,
     file TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, versions INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE files(path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, written_at TEXT NOT NULL);
   CREATE TABLE log(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session TEXT, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
   CREATE TRIGGER log_no_update BEFORE UPDATE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
   CREATE TRIGGER log_no_delete BEFORE DELETE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;`,
]

export class MemoryDb {
  readonly db: DatabaseSync
  private depth = 0
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const fresh = !fs.existsSync(file)
    this.db = new DatabaseSync(file)
    if (fresh) fs.chmodSync(file, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    for (let v = this.version; v < MIGRATIONS.length; v++) this.tx(() => { this.db.exec(MIGRATIONS[v]!); this.db.exec(`PRAGMA user_version = ${v + 1}`) })
  }
  get version(): number { return Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) }
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0; const sp = `msp${this.depth}`
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`); this.depth++
    try { const out = fn(); this.depth--; this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`); return out }
    catch (e) { this.depth--; this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`); throw e }
  }
  all<T>(sql: string, ...args: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...args) as unknown as T[] }
  get<T>(sql: string, ...args: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined }
  run(sql: string, ...args: (string | number | null)[]) { return this.db.prepare(sql).run(...args) }
  close(): void { this.db.close() }
}
