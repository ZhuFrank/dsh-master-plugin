/**
 * 自检命令行：node <插件>/lib/doctor.js [--state <状态目录>] [--json]
 * 状态目录默认 $DSH_HOME/dsh-master（DSH_HOME 未设时 ~/.dsh/dsh-master）。只读、只列问题、不修；实例运行中也能跑。
 * 退出码：0 没问题，1 有问题，2 打不开（目录不对 / 库版本比插件新）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryLayer } from 'dsh-master-devlog'
import { Store, SCHEMA_VERSION } from './store.ts'
import { doctor } from './doctor.ts'
import { systemClock } from './time.ts'

const args = process.argv.slice(2)
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const stateDir = path.resolve(opt('--state') ?? path.join(home, 'dsh-master'))
const dbFile = path.join(stateDir, 'master.db')
const fail = (msg: string) => { console.error(`dsh-master 自检：${msg}`); process.exit(2) }
if (!fs.existsSync(dbFile)) fail(`找不到 ${dbFile}（用 --state 指定状态目录）`)
const ro = new DatabaseSync(dbFile, { readOnly: true })
const ver = Number((ro.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
ro.close()
if (ver !== SCHEMA_VERSION) fail(`库版本 v${ver} 和这个插件（v${SCHEMA_VERSION}）不一致，先部署对应版本的插件再自检`)
const store = new Store(dbFile)
const mem = fs.existsSync(path.join(stateDir, 'memory.db')) ? new MemoryLayer({ dbFile: path.join(stateDir, 'memory.db'), docsRoot: path.join(stateDir, 'docs'), clock: systemClock }) : undefined
const problems = doctor(store, mem, { now: systemClock(), backupDir: path.join(stateDir, 'backups') })
if (args.includes('--json')) console.log(JSON.stringify({ stateDir, problems }, null, 1))
else {
  console.log(`dsh-master 自检：${stateDir}`)
  if (!problems.length) console.log('没有发现问题。')
  else { console.log(`发现 ${problems.length} 个问题（只列出，不自动修）：`); for (const p of problems) console.log(`- [${p.kind}] ${p.text}`) }
}
process.exit(problems.length ? 1 : 0)
