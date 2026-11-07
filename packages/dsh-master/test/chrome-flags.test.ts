import fs from 'node:fs'
import path from 'node:path'
import { it, expect } from 'vitest'

// 每起一次 Chrome，系统临时目录 com.google.Chrome.code_sign_clone/ 就留一份副本（2026-11-05 总管清查出 150 个）。
// 所有起 Chrome 的地方都要带 --disable-features=MacAppCodeSignClone。
const ROOT = path.resolve(import.meta.dirname, '../../..')
function* files(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.tmp', 'lib', '.git'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* files(p); else if (/\.(m?ts|mjs|js|sh)$/.test(e.name)) yield p
  }
}
it('所有起 Chrome 的地方都关掉 MacAppCodeSignClone', () => {
  const launches: string[] = []
  for (const f of files(ROOT)) for (const [i, line] of fs.readFileSync(f, 'utf8').split('\n').entries())
    if (line.includes("'--headless") && !line.includes('MacAppCodeSignClone')) launches.push(`${path.relative(ROOT, f)}:${i + 1}`)
  expect(launches).toEqual([])
  expect(fs.readFileSync(path.join(ROOT, 'packages/testkit/src/cdp.ts'), 'utf8')).toContain('--disable-features=MacAppCodeSignClone')
})

// G8：无头 Chrome 每轮在用户目录里下载组件（设备端模型 optimization_guide_model_store 约 41M、Safe Browsing 约 19M），
// 旧位置 588 轮攒了 13G ⇒ 关掉组件更新、后台联网和设备端模型下载。几个 feature 必须写在同一个 --disable-features 里（写两个只有最后一个生效）。
it('testkit 起的无头 Chrome 关掉组件下载', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/testkit/src/cdp.ts'), 'utf8')
  expect(src).toContain("'--disable-component-update'")
  expect(src).toContain("'--disable-background-networking'")
  const feats = [...src.matchAll(/--disable-features=([^'"`]+)/g)].map(m => m[1]!)
  expect(feats).toHaveLength(1)
  expect(feats[0]!.split(',')).toEqual(expect.arrayContaining(['MacAppCodeSignClone', 'OptimizationGuideModelDownloading', 'OptimizationHintsFetching']))
})
