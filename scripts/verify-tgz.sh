#!/bin/bash
# G10：按「用户拿到 Release tgz」的方式实测安装（不用 link:，不用开发目录）。
# 临时 DSH_HOME + DSH_AGENTS_HOME（放在 ~/dsh-master-e2e/work，仓库外），不碰 ~/.dsh、3080、3090。
# 步骤：建 profile → dsh plugin add <tgz> → 启动 → 用启动令牌换 cookie → 读面板接口 → 核对公开版默认值 → 停机。
# 通过就删掉自己的工作目录；失败留着给人看。令牌只写进 0600 文件，不打印。
# 用法：scripts/verify-tgz.sh <tgz> <标签> [dsh 可执行文件，默认 PATH 里的 dsh] [node 的 bin 目录，放到 PATH 最前]
# Install-test the release tarball the way a user would; never touches ~/.dsh or running instances.
set -uo pipefail
TGZ="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"; LABEL="$2"; DSH="${3:-dsh}"; NODEBIN="${4:-}"
[ -f "$TGZ" ] || { echo "没有 tgz：$TGZ"; exit 2; }
[ -n "$NODEBIN" ] && export PATH="$NODEBIN:$PATH"
WORK="$HOME/dsh-master-e2e/work/g10-tgz-${LABEL}-$(date +%s)"
mkdir -p "$WORK"; chmod 700 "$WORK"
export DSH_HOME="$WORK/home" DSH_AGENTS_HOME="$WORK/agents"; mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME"
PID=""; fail=0
note() { echo "[$LABEL] $*"; }
bad() { echo "[$LABEL] ✗ $*"; fail=1; }
stop() {
  [ -n "$PID" ] || return 0
  kill "$PID" 2>/dev/null; for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null; PID=""
}
trap stop EXIT
note "node $(node --version) · dsh $("$DSH" --version 2>/dev/null) · tgz $(shasum -a 256 "$TGZ" | cut -c1-12)"

# 1. 建 profile（名字 master，从内置 web 模板；不能叫 web）
"$DSH" --profile master --from-default-profile web --dump-config > "$WORK/init.out" 2> "$WORK/init.err" \
  || { bad "建 profile 失败（见 init.err）"; exit 1; }
# 2. 装 tgz
"$DSH" plugin --profile master add "$TGZ" > "$WORK/add.log" 2>&1 || { bad "dsh plugin add 失败（见 add.log），DSH 的原话："; grep -E "rejected|incompatible|allow-version|restored" "$WORK/add.log" | sort -u | sed "s/^/[$LABEL]   /"; exit 1; }
grep -q '"dsh-master"' "$DSH_HOME/profiles/master/package.json" && node -e "
  const p=require(process.argv[1]); if(!p.dsh.profile.bundles.includes('dsh-master')) process.exit(1)" "$DSH_HOME/profiles/master/package.json" \
  && note "✓ 装上了，组合包列表里有 dsh-master" || bad "profile 里没登记 dsh-master"
[ -f "$DSH_HOME/profiles/master/node_modules/dsh-master/lib/index.js" ] && [ ! -L "$DSH_HOME/profiles/master/node_modules/dsh-master" ] \
  && note "✓ 插件是从 tgz 解出来的（不是软链）" || bad "插件目录不对"
# 3. 启动
PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
(cd "$WORK" && exec "$DSH" --profile master --no-open --port "$PORT" > "$WORK/dsh.log" 2>&1) &
PID=$!
for _ in $(seq 1 120); do grep -q 'token=' "$WORK/dsh.log" 2>/dev/null && break; kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
grep -q 'token=' "$WORK/dsh.log" || { bad "DSH 没起来（见 dsh.log）"; exit 1; }
sleep 3
grep -q 'did not activate' "$WORK/dsh.log" && bad "有插件没激活：$(grep -A1 'did not activate' "$WORK/dsh.log" | tail -1 | cut -c1-160)" || note "✓ 启动日志里没有「did not activate」"
# 4. 用启动令牌换 cookie（令牌只进 0600 文件）
umask 077
grep -o 'token=[A-Za-z0-9_-]*' "$WORK/dsh.log" | tail -1 > "$WORK/token.txt"
curl -s -o /dev/null -c "$WORK/jar.txt" "http://127.0.0.1:$PORT/?$(cat "$WORK/token.txt")"
code=$(curl -s -o "$WORK/projects.json" -w '%{http_code}' -b "$WORK/jar.txt" -H "Origin: http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/dsh-master/projects")
[ "$code" = 200 ] && note "✓ 面板接口 /api/dsh-master/projects 200" || bad "面板接口返回 $code"
unauth=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/dsh-master/projects")
case "$unauth" in 401|403) note "✓ 不带登录 $unauth";; *) bad "不带登录居然 $unauth";; esac
# 5. 公开版默认值：不建旧总管、没有旧总管的定时保底、状态目录建好
node -e "const p=require(process.argv[1]); if(p.legacyMaster!==null) process.exit(1)" "$WORK/projects.json" \
  && note "✓ legacyMaster = null（新装不建旧总管）" || bad "legacyMaster 不是 null：$(head -c 200 "$WORK/projects.json")"
if ls "$DSH_HOME"/sessions/*/master 2>/dev/null | grep -q .; then bad "建出了旧总管会话 master"; else note "✓ 没有 master 会话"; fi
if [ -f "$DSH_HOME/storages/schedule.json" ] && grep -q 'dsh-master 定时巡检保底' "$DSH_HOME/storages/schedule.json"; then bad "有定时保底"; else note "✓ 没有定时保底"; fi
[ -f "$DSH_HOME/dsh-master/master.db" ] && note "✓ 状态库建好了" || bad "没有 \$DSH_HOME/dsh-master/master.db"
# 6. 停机
stop
grep -qi 'uncaught\|unhandled' "$WORK/dsh.log" && bad "日志里有未处理的异常" || note "✓ 日志里没有未处理的异常"
if [ $fail = 0 ]; then rm -rf "$WORK"; note "通过（工作目录已删）"; else note "失败，工作目录留着：$WORK"; fi
exit $fail
