#!/bin/bash
# master-instance.sh 的回归测试（2026-11-03 stop/status bug）：临时 DSH_HOME + 随机端口，绝不碰长期实例 3090。
# ① start → pid 文件里是 node 本身且在监听 → status 运行中
# ② stop → 端口确实释放、进程没了 → status 报没在运行（退出码 3）
# ③ 复现旧 bug：pid 文件记成 bash 外壳（node 是它的子进程）→ stop 仍然把 node 停掉、端口释放
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; S="$ROOT/scripts/master-instance.sh"
PLUGIN="$HOME/.dsh-master/plugins/dsh-master"; [ -d "$PLUGIN" ] || PLUGIN="$ROOT/packages/dsh-master"
H=$(mktemp -d "${TMPDIR:-/tmp}/dshm-inst.XXXX"); PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
export MASTER_DSH_HOME="$H" MASTER_PORT="$PORT"
P="$H/profiles/master"; mkdir -p "$P/node_modules"; ln -s "$PLUGIN" "$P/node_modules/dsh-master"
printf '{"name":"dsh-profile-master","private":true,"dependencies":{"dsh-master":"link:%s"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-master"]}}}\n' "$PLUGIN" > "$P/package.json"
printf '[]\n' > "$P/cordis.yml"; printf '[]\n' > "$P/cordis.patch.yml"; printf 'packages:\n  - .\n' > "$P/pnpm-workspace.yaml"
fail=0; ok() { echo "  ✓ $1"; }; bad() { echo "  ✗ $1"; fail=1; }
listener() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }
cleanup() { L=$(listener); [ -n "$L" ] && kill -9 "$L" 2>/dev/null; cat "$H/old.log" "$H/logs/dsh.log" > "${KEEP_LOG:-/dev/null}" 2>/dev/null; rm -rf "$H"; }
trap cleanup EXIT
KEEP_LOG="${TMPDIR:-/tmp}/dshm-inst-last.log"
echo "临时 DSH_HOME=$H 端口=$PORT"

echo "① start"
"$S" start >/dev/null || bad "start 失败"
PID=$(cat "$H/dsh.pid"); L=$(listener)
[ -n "$L" ] && [ "$PID" = "$L" ] && ok "pid 文件（${PID}）就是监听端口的进程" || bad "pid 文件 $PID ≠ 监听进程 ${L:-无}"
[[ "$(ps -o command= -p "$PID")" == *"dsh --profile master"* ]] && ok "pid 文件里是 node（dsh）本身" || bad "pid 文件里不是 node：$(ps -o command= -p "$PID")"
"$S" status | grep -q "运行中" && ok "status 运行中" || bad "status 没报运行中"

echo "② stop"
"$S" stop >/dev/null || bad "stop 返回失败"
[ -z "$(listener)" ] && ok "端口 $PORT 已释放" || bad "端口仍被 $(listener) 占着"
kill -0 "$PID" 2>/dev/null && bad "node $PID 还活着" || ok "node $PID 已退出"
out=$("$S" status); rc=$?
[ "$rc" = 3 ] && [[ "$out" == *"没在运行"* ]] && ok "status 报没在运行（退出码 3）" || bad "status 输出「${out}」退出码 $rc"

echo "③ 旧 bug 复现：pid 文件记成 bash 外壳"
( cd "$H" && DSH_HOME="$H" DSH_AGENTS_HOME="$H/agents-home" nohup dsh --profile master --no-open --port "$PORT" >> "$H/old.log" 2>&1 ) &
SHELLPID=$!; echo "$SHELLPID" > "$H/dsh.pid"
for i in $(seq 1 60); do [ -n "$(listener)" ] && break; sleep 1; done
NODE=$(listener)
[ -n "$NODE" ] && [ "$NODE" != "$SHELLPID" ] && ok "复现成功：外壳 ${SHELLPID}、node $NODE" || bad "没复现出外壳/子进程结构（外壳 $SHELLPID node ${NODE:-无}）"
"$S" status | grep -q "运行中" && ok "pid 文件是外壳时 status 仍按端口报运行中" || bad "status 没认出端口上的 node"
"$S" stop >/dev/null
[ -z "$(listener)" ] && ok "stop 后端口释放" || bad "stop 后端口仍被 $(listener) 占着（旧 bug）"
[ -n "${NODE:-}" ] && kill -0 "$NODE" 2>/dev/null && bad "node $NODE 还活着（被转给 1 号进程）" || ok "node 已退出"
"$S" status >/dev/null; [ $? = 3 ] && ok "status 报没在运行" || bad "status 没报没在运行"

echo "④ profile-init：已有 profile 不重建"
out=$("$S" profile-init 2>&1); rc=$?
[ "$rc" = 1 ] && [[ "$out" == *"已存在"* ]] && ok "已有 profile 时拒绝（退出码 1）" || bad "profile-init 输出「${out}」退出码 $rc"

echo "⑤ DSH_HOME 指向日常的 ~/.dsh：一律拒绝"
before=$(ls -la "$HOME/.dsh" 2>/dev/null | md5)
out=$(MASTER_DSH_HOME="$HOME/.dsh" "$S" status 2>&1); rc=$?
[ "$rc" = 2 ] && [[ "$out" == *"拒绝执行"* ]] && ok "status 拒绝（退出码 2）" || bad "输出「${out}」退出码 $rc"
out=$(MASTER_DSH_HOME="$HOME/.dsh" "$S" plugin list 2>&1); rc=$?
[ "$rc" = 2 ] && ok "plugin 拒绝（退出码 2）" || bad "plugin 输出「${out}」退出码 $rc"
[ "$(ls -la "$HOME/.dsh" 2>/dev/null | md5)" = "$before" ] && ok "~/.dsh 没被动过" || bad "~/.dsh 变了"

[ $fail = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
