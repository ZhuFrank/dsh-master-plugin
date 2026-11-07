# dsh-master — design overview

**English** · [中文](#中文)

## Shape

```
DSH profile (one process)
└─ dsh-master bundle
   ├─ host plugin (lib/index.js)
   │   ├─ units: one per project  (+ the optional legacy unit)
   │   │   ├─ Store        master.db  — roster, tasks, gates, messages, deliveries, events (node:sqlite, WAL, 0600)
   │   │   ├─ MemoryLayer  memory.db + docs/  — devlog, decisions, memories, handbooks, task specs
   │   │   ├─ Core         role-scoped tools, dispatch / report / review, idle reminders
   │   │   ├─ Delivery     outbox → pump() → agent (plugin message source, de-dup, backoff)
   │   │   ├─ Patrol       findings with stable keys; report only when the signature changes
   │   │   └─ PanelService board views and whitelisted actions
   │   ├─ guard            tools/pre-execute: state-dir writes, git in shared roots, claims, secret paths
   │   ├─ attribution      every native turn → a task (@task, task id in tool/message, @session, mention)
   │   ├─ heavy queue      one heavy job at a time, gated on free memory
   │   └─ schedule         one safety-net host schedule per live master
   ├─ two agent presets    dsh-master 总管 (master, no write/edit) · dsh-master 执行会话 (member)
   └─ web client (lib/client.js)  right-side board, project picker, @task menu, banners
```

## Principles

- **The database is the source of truth; files are renderings.** Task specs, the board and devlog indexes are rendered from the stores. The plugin never parses Markdown back into state, and models change state only through tools.
- **Nothing pretends to be the user.** Cross-session messages carry the plugin's own source kind. They are written to an append-only table first and then delivered, so a restart resumes pending deliveries.
- **Quiet by default.** Patrol computes a set of findings with stable keys and compares a signature. Unchanged findings cost nothing. The host schedule exists only as a safety net, and when there is nothing unseen it is rejected before the model is called.
- **People decide, the plugin keeps the books.** Gates, reviews and *needs you* cards are explicit records. Members cannot interrupt the user; their questions go through the master.
- **Pure functions where it matters.** Guard decisions, attribution, board grouping, mention parsing and release defaults are pure, so each has unit tests. The wiring is covered by end-to-end tests against a real DSH with a mock model. Every rule also has a *mutation* that breaks it, and the named test has to go red.

## Projects

Creating a session with the master preset in a directory *opens* a project:

1. The directory is registered in `projects.db` with its master session.
2. `<root>/.dsh-master/` is created for task specs, handbooks, devlog and `out/`.
3. The master's permission preset is set from `projectMasterPreset`.

Members are spawned by the master into the project root, or into a git worktree of the same repository, with `projectMemberPreset`.

## Lifecycle

- **Startup:** live units recover pending deliveries and render their boards. Each live master gets one safety-net schedule, unless its project is paused.
- **Pause / resume:** the pause state lives in the project's own database. Pausing removes the schedule; resuming recreates exactly one.
- **Uninstall / disable:** when the plugin is disposed and the profile no longer selects it (it was dropped from `dsh.profile.bundles`, or its row is disabled), it deletes the schedules it created. A restart or hot reload keeps them.

---

## 中文

### 结构

见上图：一个 DSH profile 进程里，dsh-master 组合包有三部分：宿主端插件、两个 Agent 预设、网页端看板。

- **宿主端插件**按项目分成**单元**。每个单元有自己的：
  - 状态库：花名册、任务、闸门、消息、投递、事件；
  - 记忆层：devlog、决策、记忆、手册、任务书；
  - 业务核心：按角色给工具，派活、回报、验收、空闲提醒；
  - 投递：先落库，再投给 Agent；
  - 巡检；
  - 看板服务。
- **单元之外**是全局共用的几样：守卫、对话归属、重活队列、宿主定时保底。

### 原则

- **库是真相，文件只是渲染出来的。** 任务书、看板、devlog 索引都从库里渲染，不从 Markdown 读回状态；模型只能通过工具改状态。
- **不冒充用户。** 跨会话消息带插件自己的来源；先写进只追加的表再投递，重启后接着投。
- **默认安静。** 巡检把发现算成一组带稳定 key 的条目，比较签名，没变就什么都不做。宿主的定时保底只是兜底：没有总管没见过的发现，就在调模型之前拒掉。
- **人做决定，插件记账。** 闸门、验收、等你定都是明确的记录。成员不能打断用户，问题由总管代问。
- **关键逻辑写成纯函数。** 守卫判定、对话归属、看板分组、@ 识别、公开版默认值都是纯函数，有单测。接线由端到端测试覆盖：真实 DSH 加假模型。每条规则都配了一个**反向验证**：把那一行改坏，点名的测试必须变红。

### 项目

用总管预设在一个目录新建会话，就是**开张**：
1. 这个目录和它的总管会话登记进 `projects.db`；
2. 建好 `<项目根>/.dsh-master/`，放任务书、手册、devlog 和 `out/`；
3. 按 `projectMasterPreset` 设总管的权限。

成员由总管建在项目根里，或者建在同一个仓库的 git worktree 里，权限按 `projectMemberPreset` 设。

### 生命周期

- **启动**：恢复没投完的消息，渲染看板；每个在跑的总管建一条定时保底，已暂停的项目除外。
- **暂停 / 恢复**：暂停状态记在项目自己的库里。暂停时删掉定时保底；恢复时重建，只建一条。
- **卸载 / 关闭**：插件被停用时，如果 profile 已经不再选它（从组合包列表里移除，或者这一行被关掉），就删掉自己建的定时保底。重启、热重载时保留。
