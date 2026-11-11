/**
 * G11-5：看 PATH 上那个 dsh 带的 dsh-base 组合包里，宿主的「写之前先读」防护（fs-observation-policy）开没开。
 * 0.2.1 的这一行没写 disabled（开着）；0.2.2 写着 disabled: true（默认关）。找不到组合包 ⇒ undefined。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function dshBasePatch(): string | undefined {
  let bin: string
  try { bin = fs.realpathSync(execFileSync('/usr/bin/which', ['dsh'], { encoding: 'utf8' }).trim()) } catch { return undefined }
  // 从 dsh 的入口往上找：<…>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base（全局装）或 <…>/node_modules/@deepseek-ai/dsh-base（本地装、提升到顶层）
  for (let d = path.dirname(bin); d !== path.dirname(d); d = path.dirname(d)) {
    for (const c of [path.join(d, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'), path.join(d, '@deepseek-ai/dsh-base/cordis.patch.yml')]) if (fs.existsSync(c)) return c
  }
  return undefined
}

export function hostFsObservationOn(): boolean | undefined {
  const f = dshBasePatch(); if (!f) return undefined
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  const i = lines.findIndex(l => /^\s*- id: fs-observation-policy\s*$/.test(l)); if (i < 0) return undefined
  for (let j = i + 1; j < lines.length && !/^\s*- id:/.test(lines[j]!) && lines[j]!.trim() !== ''; j++) if (/^\s*disabled:\s*true\s*$/.test(lines[j]!)) return false
  return true
}
