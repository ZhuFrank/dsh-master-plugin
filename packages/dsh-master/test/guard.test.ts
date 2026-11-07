import { describe, it, expect } from 'vitest'
import { guardDecision, NO_WAIT } from '../src/guard.ts'

const cfg = { protectedPaths: ['/tmp/home/dsh-master'] }
const bash = (command: unknown, extra: Record<string, unknown> = {}, role?: 'master' | 'exec') => guardDecision({ name: 'bash', args: { command, ...extra }, role }, cfg)

describe('guard', () => {
  it('拦 bash 写状态目录（含 G1 的 false && echo x >>）', () => {
    for (const c of [
      'false && echo x >> /tmp/home/dsh-master/master.db',
      'echo x > /tmp/home/dsh-master/a.md',
      'sqlite3 /tmp/home/dsh-master/master.db "delete from tasks"',
      'rm -rf /tmp/home/dsh-master',
      'cp evil.db /tmp/home/dsh-master/master.db',
      'sed -i "" s/a/b/ /tmp/home/dsh-master/x.md',
      'python3 -c "open(\'/tmp/home/dsh-master/x\',\'w\')"',
      'cat x | tee /tmp/home/dsh-master/x',
    ]) expect(bash(c), c).toMatch(/dsh-master 守卫/)
  })
  it('放行：读状态目录、和状态目录无关的写', () => {
    expect(bash('cat /tmp/home/dsh-master/x.md')).toBeUndefined()
    expect(bash('ls -la /tmp/home/dsh-master')).toBeUndefined()
    expect(bash('echo hi > /tmp/other/file')).toBeUndefined()
  })
  it('拦 write / edit 到状态目录（绝对、相对、~ 写法），放行别处', () => {
    expect(guardDecision({ name: 'write', args: { file_path: '/tmp/home/dsh-master/board.md', content: 'x' } }, cfg)).toMatch(/守卫/)
    expect(guardDecision({ name: 'edit', args: { file_path: 'dsh-master/x.md' }, cwd: '/tmp/home' }, cfg)).toMatch(/守卫/)
    expect(guardDecision({ name: 'write', args: { file_path: '/tmp/home/dsh-master-other/x' } }, cfg)).toBeUndefined()
    expect(guardDecision({ name: 'write', args: { file_path: '/tmp/home/x.md' } }, cfg)).toBeUndefined()
  })
  it('参数缺失或类型不对时不抛错、不误拦（pre-execute 在参数校验之前跑）', () => {
    for (const args of [undefined, null, 'str', [], { command: 42 }, { file_path: 3 }, {}]) {
      expect(() => guardDecision({ name: 'bash', args }, cfg)).not.toThrow()
      expect(guardDecision({ name: 'write', args }, cfg)).toBeUndefined()
    }
  })
  it('noWait：只对总管——sleep、超过 30 秒的命令、超过 5 秒的后台任务等待', () => {
    expect(bash('sleep 60', {}, 'master')).toBe(NO_WAIT)
    expect(bash('make && sleep 5', {}, 'master')).toBe(NO_WAIT)
    expect(bash('ls', { timeoutMs: 60_000 }, 'master')).toBe(NO_WAIT)
    expect(guardDecision({ name: 'job_output', args: { wait: true, timeout_ms: 60_000 }, role: 'master' }, cfg)).toBe(NO_WAIT)
    expect(bash('sleep 60', {}, 'exec')).toBeUndefined()
    expect(bash('echo sleepy', {}, 'master')).toBeUndefined()
  })
})
