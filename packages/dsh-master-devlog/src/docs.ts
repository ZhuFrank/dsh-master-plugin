/**
 * 受管文件：插件写出的 markdown 都经这里写（原子替换），并记下 sha256。
 * verify() 找出被别人改过 / 删掉的文件（带外改动检测：守卫只能拦常见写法，这里兜底）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { MemoryDb } from './db.ts'

export interface Drift { path: string; kind: string; problem: 'modified' | 'missing'; expected: string; actual?: string }

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

export class ManagedDocs {
  constructor(readonly root: string, private readonly db: MemoryDb, private readonly now: () => string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  abs(rel: string): string {
    const p = path.resolve(this.root, rel)
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error(`路径越界：${rel}`)
    return p
  }
  read(rel: string): string | undefined {
    const p = this.abs(rel)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined
  }
  /**
   * 写文件。若上次写出后被插件之外的方式改过（校验值不符）：把那个外部版本另存一份、记一条 docs/drift 日志，再写——
   * 不阻塞工作，也不让带外改动悄悄消失（巡检会报出来）。
   */
  write(rel: string, content: string, kind: string): void {
    const p = this.abs(rel)
    const row = this.db.get<{ sha256: string }>('SELECT sha256 FROM files WHERE path = ?', rel)
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined
    if (row && (cur === undefined || sha256(cur) !== row.sha256)) {
      let saved: string | null = null
      if (cur !== undefined) {
        saved = path.join(path.dirname(this.root), 'drift-copies', `${rel.replace(/[\\/]/g, '__')}.${Date.now()}`)
        fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 })
        fs.writeFileSync(saved, cur, { mode: 0o600 })
      }
      this.db.run('INSERT INTO log(at, session, type, data) VALUES(?,?,?,?)', this.now(), null, 'docs/drift',
        JSON.stringify({ path: rel, problem: cur === undefined ? 'missing' : 'modified', expected: row.sha256, actual: cur === undefined ? null : sha256(cur), saved }))
    }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.tmp-${process.pid}`
    fs.writeFileSync(tmp, content, { mode: 0o600 })
    fs.renameSync(tmp, p)
    this.db.run(`INSERT INTO files(path, sha256, size, kind, written_at) VALUES(?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, kind = excluded.kind, written_at = excluded.written_at`,
      rel, sha256(content), Buffer.byteLength(content), kind, this.now())
  }
  /** 写的时候被吸收掉的带外改动（docs/drift 日志），seq 之后的。 */
  absorbedDrift(sinceSeq: number): Array<{ seq: number; path: string; problem: string; saved: string | null }> {
    return this.db.all<{ seq: number; data: string }>(`SELECT seq, data FROM log WHERE type = 'docs/drift' AND seq > ? ORDER BY seq`, sinceSeq)
      .map(r => ({ seq: r.seq, ...JSON.parse(r.data) }))
  }
  lastLogSeq(): number { return this.db.get<{ s: number | null }>('SELECT max(seq) AS s FROM log')?.s ?? 0 }
  verify(): Drift[] {
    const out: Drift[] = []
    for (const f of this.db.all<{ path: string; sha256: string; kind: string }>('SELECT path, sha256, kind FROM files ORDER BY path')) {
      const cur = this.read(f.path)
      if (cur === undefined) out.push({ path: f.path, kind: f.kind, problem: 'missing', expected: f.sha256 })
      else { const h = sha256(cur); if (h !== f.sha256) out.push({ path: f.path, kind: f.kind, problem: 'modified', expected: f.sha256, actual: h }) }
    }
    return out
  }
}
