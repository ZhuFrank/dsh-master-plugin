/**
 * G6-5 — 等宿主服务就绪（3090 上存档模式启动太快，拿不到 schedule 就悄悄跳过，旧总管的定时保底没删掉）。
 * 「服务晚几秒才就绪」的整条链路在 e2e/g6-5-legacy-archived.e2e.test.ts（fakeScheduleDelayMs）。
 */
import { describe, it, expect } from 'vitest'
import { waitService } from '../src/services.ts'
import { gitAncestor, repoFootprint } from '../../testkit/src/guard.ts'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from './helpers.ts'

describe('G6-5 等宿主服务就绪', () => {
  it('服务晚几次才出现：等到它，返回服务；每次之间按间隔等', async () => {
    let calls = 0; const slept: number[] = []
    const svc = { name: 'schedule' }
    const got = await waitService(() => (++calls >= 4 ? svc : undefined), { timeoutMs: 10_000, intervalMs: 1000, sleep: async ms => { slept.push(ms) } })
    expect(got).toBe(svc); expect(calls).toBe(4); expect(slept).toEqual([1000, 1000, 1000])
  })
  it('一直没有：等满超时返回 undefined（调用方要记下来，不能悄悄跳过）', async () => {
    let calls = 0
    expect(await waitService(() => { calls++; return undefined }, { timeoutMs: 5000, intervalMs: 1000, sleep: async () => {} })).toBeUndefined()
    expect(calls).toBe(6) // 0、1、2、3、4、5 秒各看一次
  })
  it('一开始就有：不等', async () => {
    let slept = 0
    expect(await waitService(() => 1, { sleep: async () => { slept++ } })).toBe(1)
    expect(slept).toBe(0)
  })
})

describe('G6-5 测试护栏', () => {
  it('gitAncestor：仓库里的目录（含还不存在的子目录）找得到仓库根；仓库外的找不到', () => {
    const base = tmpdir('guard'); const repo = path.join(base, 'r'); fs.mkdirSync(repo, { recursive: true }); execFileSync('git', ['init', '-q', repo])
    const real = fs.realpathSync(repo)
    expect(gitAncestor(path.join(repo, 'a', 'b'))).toBe(real)
    expect(gitAncestor(path.join(base, 'outside'))).toBeUndefined()
  })
  it('repoFootprint：.dsh-master/ 出现、exclude 被改都会让快照变', () => {
    const repo = path.join(tmpdir('fp'), 'r'); fs.mkdirSync(repo, { recursive: true }); execFileSync('git', ['init', '-q', repo])
    const a = repoFootprint(repo)
    fs.mkdirSync(path.join(repo, '.dsh-master'))
    const b = repoFootprint(repo); expect(b).not.toBe(a)
    fs.rmdirSync(path.join(repo, '.dsh-master')); expect(repoFootprint(repo)).toBe(a)
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/.dsh-master/\n'); expect(repoFootprint(repo)).not.toBe(a)
  })
})
