import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import { tmpStore } from './helpers.ts'
import { Store } from '../src/store.ts'

describe('Store', () => {
  it('建库：迁移到最新版本、WAL、文件权限 0600', () => {
    const s = tmpStore()
    expect(s.version).toBe(4)
    expect((s.db.prepare('PRAGMA journal_mode').get() as any).journal_mode).toBe('wal')
    expect(fs.statSync(s.file).mode & 0o777).toBe(0o600)
  })

  it('events 只能追加：UPDATE / DELETE 都被触发器拦下', () => {
    const s = tmpStore()
    s.addEvent({ at: 'x', type: 't' })
    expect(() => s.db.exec(`UPDATE events SET type = 'y'`)).toThrow(/append-only/)
    expect(() => s.db.exec(`DELETE FROM events`)).toThrow(/append-only/)
    expect(s.events()).toHaveLength(1)
  })

  it('messages 只能追加：UPDATE / DELETE 都被触发器拦下', () => {
    const s = tmpStore()
    s.insertMessage({ at: 'x', at_ms: 1, key: 'k', from_id: 'a', to_id: 'b', task: null, mode: 'followup', text: 't' })
    expect(() => s.db.exec(`UPDATE messages SET text = 'y'`)).toThrow(/append-only/)
    expect(() => s.db.exec(`DELETE FROM messages`)).toThrow(/append-only/)
    expect(s.getMessage('k')?.text).toBe('t')
  })

  it('嵌套事务：内层失败只回滚内层，外层失败全部回滚', () => {
    const s = tmpStore()
    s.tx(() => {
      s.addEvent({ at: 'a', type: 'outer' })
      expect(() => s.tx(() => { s.addEvent({ at: 'b', type: 'inner' }); throw new Error('x') })).toThrow('x')
    })
    expect(s.events().map(e => e.type)).toEqual(['outer'])
    expect(() => s.tx(() => { s.addEvent({ at: 'c', type: 'gone' }); throw new Error('y') })).toThrow('y')
    expect(s.events().map(e => e.type)).toEqual(['outer'])
  })

  it('重开同一个文件不重复迁移、数据还在', () => {
    const s = tmpStore()
    s.addEvent({ at: 'a', type: 'keep' }); s.close()
    const again = new Store(s.file)
    expect(again.version).toBe(4)
    expect(again.events().map((e: any) => e.type)).toEqual(['keep'])
  })
})
