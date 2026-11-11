/**
 * G12：「等你定」挂在当前列表里没有的任务上（总管先问后派，或者任务被筛掉了）⇒ 看板仍要能看到、能答。
 * orphanAsks(asks, tasks) 挑出这些问题，看板放在「还没建任务的提问」一块里。
 */
import { describe, it, expect } from 'vitest'
import { orphanAsks } from '../src/board-groups.ts'

const ask = (id: number, task: string) => ({ id, task, code: `Q1111-${id}`, question: `问题 ${id}`, options: [] as string[] })

describe('G12 orphanAsks：所属任务不在列表里的提问', () => {
  it('任务还没建（先问后派）⇒ 挑出来', () => {
    expect(orphanAsks([ask(1, 'L1111-1')], []).map(a => a.id)).toEqual([1])
  })
  it('任务在列表里 ⇒ 不挑（照旧挂在任务下面）', () => {
    expect(orphanAsks([ask(1, 'T001'), ask(2, 'L1111-1')], [{ id: 'T001' }]).map(a => a.id)).toEqual([2])
  })
  it('没有提问 ⇒ 空', () => {
    expect(orphanAsks([], [{ id: 'T001' }])).toEqual([])
  })
  it('保持原顺序', () => {
    expect(orphanAsks([ask(3, 'X'), ask(1, 'Y'), ask(2, 'T001')], [{ id: 'T001' }]).map(a => a.id)).toEqual([3, 1])
  })
})
