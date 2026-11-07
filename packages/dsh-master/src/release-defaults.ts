/**
 * G10 公开版的默认值和卸载判断（纯函数，接线在 index.ts）。
 * - 旧单元（只有一个总管、不分项目的早期形态）：新装默认 off，不建旧总管；状态目录里已经有旧花名册的老用户保持 active。
 * - 项目总管的权限预设默认 workspace-write；要完全权限就在 profile 里配 projectMasterPreset: danger-full-access。
 * - 插件停用时判断「还选着吗」：没选（卸载 / 取消选择 / 关掉这一行）⇒ 删自己建的定时保底；选着（重启 / 热重载）⇒ 保留。
 */
import fs from 'node:fs'
import path from 'node:path'

export type LegacyMode = 'active' | 'archived' | 'off'

/** 旧单元模式：存档标记或配置 archived 最优先；其次照配置；都没有时看状态目录里有没有旧花名册。 */
export function resolveLegacyMode(o: { config?: LegacyMode; marker: boolean; legacySessions: number }): LegacyMode {
  if (o.marker || o.config === 'archived') return 'archived'
  if (o.config === 'active' || o.config === 'off') return o.config
  return o.legacySessions > 0 ? 'active' : 'off'
}

export const DEFAULT_PROJECT_MASTER_PRESET = 'workspace-write'
export function masterPresetOf(config: { projectMasterPreset?: string }): string {
  return config.projectMasterPreset ?? DEFAULT_PROJECT_MASTER_PRESET
}

/**
 * profile 现在还选着这个插件吗。
 * - 组合包列表（package.json 的 dsh.profile.bundles）里没有它 ⇒ false；
 * - cordis.patch.yml 里这一行写了 disabled: true（插件页的开关就是这么写的）⇒ false；
 * - 读不到 / 看不懂 ⇒ undefined（调用方按「还选着」处理，不删东西）。
 */
export function stillSelected(profileDir: string | undefined, pkgName: string, rowId: string): boolean | undefined {
  if (!profileDir) return undefined
  let bundles: unknown
  try { bundles = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))?.dsh?.profile?.bundles } catch { return undefined }
  if (!Array.isArray(bundles)) return undefined
  if (!bundles.includes(pkgName)) return false
  let patch = ''
  try { patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8') } catch { return true }
  return !rowDisabled(patch, rowId)
}

/** patch 顶层列表里 id 为 rowId 的那一项，直接子键 disabled 是不是 true（只认插件页写出的简单形式）。 */
function rowDisabled(patch: string, rowId: string): boolean {
  const items: string[][] = []
  for (const line of patch.split(/\r?\n/)) {
    if (/^-\s/.test(line)) items.push([line])
    else if (items.length && (/^\s/.test(line) || line === '')) items[items.length - 1]!.push(line)
    else if (line.trim() && !line.startsWith('#')) items.push([]) // 顶层出现别的东西：断开
  }
  const idRe = /^\s*-?\s*id:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/
  let hit = false
  for (const it of items) {
    const first = it[0] ?? ''
    const id = first.match(idRe)?.[1] ?? it.slice(1).find(l => /^ {2}id:/.test(l))?.match(idRe)?.[1]
    if (id !== rowId) continue
    for (const l of it) {
      const m = l.match(/^(?:- | {2})disabled:\s*(true|false)\s*(#.*)?$/)
      if (m) hit = m[1] === 'true'
    }
  }
  return hit
}
