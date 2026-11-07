/**
 * G10 公开版的默认值（单测部分）：
 * - 旧单元：新装默认不建旧总管（off）；状态目录里已经有旧花名册的老用户保持 active；配置 / 存档标记优先。
 * - 项目总管权限默认 workspace-write；配置 projectMasterPreset 照旧生效（Frank 的 3090 写 danger-full-access）。
 * - 卸载 / 关掉插件时删定时保底：插件停用时看 profile 是否还选着它（package.json 的 dsh.profile.bundles、cordis.patch.yml 的 disabled）。
 * 接线（启动不建旧总管、卸载删保底、重启保留保底）在 e2e/g10-release.e2e.test.ts。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveLegacyMode, masterPresetOf, DEFAULT_PROJECT_MASTER_PRESET, stillSelected } from '../src/release-defaults.ts'
import { tmpdir } from './helpers.ts'

describe('G10 旧单元默认', () => {
  it('新装（没有旧花名册、没配置、没存档标记）⇒ off：不建旧总管', () => {
    expect(resolveLegacyMode({ marker: false, legacySessions: 0 })).toBe('off')
  })
  it('老用户：状态目录里已经有旧花名册 ⇒ active，升级后行为不变', () => {
    expect(resolveLegacyMode({ marker: false, legacySessions: 3 })).toBe('active')
  })
  it('存档标记或配置 archived ⇒ archived（优先于一切）', () => {
    expect(resolveLegacyMode({ marker: true, legacySessions: 0 })).toBe('archived')
    expect(resolveLegacyMode({ config: 'active', marker: true, legacySessions: 3 })).toBe('archived')
    expect(resolveLegacyMode({ config: 'archived', marker: false, legacySessions: 0 })).toBe('archived')
  })
  it('配置 active / off 照配置', () => {
    expect(resolveLegacyMode({ config: 'active', marker: false, legacySessions: 0 })).toBe('active')
    expect(resolveLegacyMode({ config: 'off', marker: false, legacySessions: 5 })).toBe('off')
  })
})

describe('G10 项目总管权限默认', () => {
  it('默认 workspace-write（只改工作区）', () => {
    expect(DEFAULT_PROJECT_MASTER_PRESET).toBe('workspace-write')
    expect(masterPresetOf({})).toBe('workspace-write')
  })
  it('配置了就照配置（Frank 的 3090：danger-full-access）', () => {
    expect(masterPresetOf({ projectMasterPreset: 'danger-full-access' })).toBe('danger-full-access')
  })
})

describe('G10 卸载判断：profile 是否还选着插件', () => {
  const profile = (bundles: string[] | undefined, patch?: string) => {
    const dir = tmpdir('g10-prof')
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(bundles ? { dependencies: {}, dsh: { profile: { bundles } } } : { dependencies: {} }))
    if (patch !== undefined) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch)
    return dir
  }
  it('还在组合包列表里、没被关 ⇒ true（重启 / 热重载：保留定时保底）', () => {
    expect(stillSelected(profile(['@deepseek-ai/dsh-base', 'dsh-master'], '- id: dsh-master\n  config:\n    masterCwd: /x\n'), 'dsh-master', 'dsh-master')).toBe(true)
  })
  it('从组合包列表里移除（卸载 / 取消选择）⇒ false', () => {
    expect(stillSelected(profile(['@deepseek-ai/dsh-base']), 'dsh-master', 'dsh-master')).toBe(false)
  })
  it('插件页关掉这一行（patch 里 disabled: true）⇒ false', () => {
    expect(stillSelected(profile(['dsh-master'], '- id: other\n  disabled: true\n- id: dsh-master\n  disabled: true\n'), 'dsh-master', 'dsh-master')).toBe(false)
    expect(stillSelected(profile(['dsh-master'], "- id: 'dsh-master'\n  config:\n    a: 1\n  disabled: true\n"), 'dsh-master', 'dsh-master')).toBe(false)
  })
  it('别的行被关、或者这行 disabled: false ⇒ 仍是 true', () => {
    expect(stillSelected(profile(['dsh-master'], '- id: other\n  disabled: true\n- id: dsh-master\n  config: {}\n'), 'dsh-master', 'dsh-master')).toBe(true)
    expect(stillSelected(profile(['dsh-master'], '- id: dsh-master\n  disabled: false\n'), 'dsh-master', 'dsh-master')).toBe(true)
  })
  it('读不到 profile（没有目录、坏 JSON、没有 bundles 字段）⇒ undefined：不确定就保留定时保底', () => {
    expect(stillSelected(undefined, 'dsh-master', 'dsh-master')).toBeUndefined()
    expect(stillSelected(path.join(tmpdir('g10-none'), 'nope'), 'dsh-master', 'dsh-master')).toBeUndefined()
    const bad = tmpdir('g10-bad'); fs.writeFileSync(path.join(bad, 'package.json'), '{oops')
    expect(stillSelected(bad, 'dsh-master', 'dsh-master')).toBeUndefined()
    expect(stillSelected(profile(undefined), 'dsh-master', 'dsh-master')).toBeUndefined()
  })
})
