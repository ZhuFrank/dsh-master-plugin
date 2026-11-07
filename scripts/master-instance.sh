#!/bin/bash
# dsh-master 长期实例启停：DSH_HOME=~/.dsh-master，profile master，端口 3090（避开 3080/3081/3082）。
# 用法：scripts/master-instance.sh deploy|start|stop|status|url|profile-init|plugin <pnpm 参数…>
# profile-init：从 DSH 自带的 web 模板建 profile master（已存在就拒绝，免得把装好的插件冲掉）
# plugin：等于 DSH_HOME=~/.dsh-master dsh plugin --profile master <参数…>（不用自己 export，也就装不进日常的 ~/.dsh）
# deploy：把构建好的插件复制到 $DSH_HOME/plugins/dsh-master（实例只链这份副本，开发目录里反复构建、跑反向验证都不影响它）
# 测试用覆盖：MASTER_DSH_HOME、MASTER_PORT（回归测试用临时目录和随机端口，碰不到长期实例）
#
# 2026-11-03 修：旧版 `cd ... && nohup dsh ... &` 把整个 `cd && nohup` 放进后台，$! 是 bash 外壳不是 node，
# stop 只杀外壳、node 被转给 1 号进程继续占端口，status 还报「没在运行」。现在：pid 文件记 node 本身；
# status 以端口监听为准；stop 等端口真正释放，必要时按端口找到本实例的 dsh 逐级 INT → TERM → KILL。
set -u
export DSH_HOME="${MASTER_DSH_HOME:-$HOME/.dsh-master}"
export DSH_AGENTS_HOME="${DSH_HOME}/agents-home"
PORT="${MASTER_PORT:-3090}"
PIDF="${DSH_HOME}/dsh.pid"; LOG="${DSH_HOME}/logs/dsh.log"
# 仓库根：脚本所在目录的上一级（不写死开发目录）
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
# 防线：绝不对日常用的 ~/.dsh 动手
if [ "$(cd "${DSH_HOME}" 2>/dev/null && pwd -P || echo "${DSH_HOME}")" = "$(cd "$HOME/.dsh" 2>/dev/null && pwd -P || echo "$HOME/.dsh")" ]; then echo "DSH_HOME 指向了日常用的 ~/.dsh，拒绝执行"; exit 2; fi

# 端口上监听的 pid（没有就空）
listener() { lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1; }
# 这个 pid 是不是本实例的 dsh（命令行带 --profile master 和本端口）
ours() { local c; c=$(ps -o command= -p "$1" 2>/dev/null) || return 1; [[ "$c" == *"dsh --profile master"* && "$c" == *"--port ${PORT}"* ]]; }
wait_exit() { # $1=pid，$2=秒；等这个进程退出
  local i; for i in $(seq 1 "$2"); do kill -0 "$1" 2>/dev/null || return 0; sleep 1; done; return 1
}

case "${1:-status}" in
  profile-init)
    if [ -d "${DSH_HOME}/profiles/master" ]; then echo "profile master 已存在（${DSH_HOME}/profiles/master），不重建；真要重建先手动挪走它"; exit 1; fi
    mkdir -p "${DSH_HOME}" && dsh --profile master --from-default-profile web --dump-config > /dev/null || { echo "建 profile 失败"; exit 1; }
    echo "已建 profile master：${DSH_HOME}/profiles/master" ;;
  plugin)
    shift; [ $# -gt 0 ] || { echo "用法：$0 plugin add|remove|list <包>"; exit 2; }
    dsh plugin --profile master "$@" ;;
  deploy)
    SRC="${REPO}/packages/dsh-master"; DST="${DSH_HOME}/plugins/dsh-master"
    [ -f "${SRC}/lib/index.js" ] || { echo "先在 ${REPO} 跑 pnpm build"; exit 1; }
    if [ -f "${REPO}/.tmp/mutate/RESTORE-ME.json" ]; then echo "反向验证还没还原完，先别部署"; exit 1; fi
    mkdir -p "${DST}.new/lib" && cp "${SRC}/package.json" "${SRC}/cordis.patch.yml" "${SRC}/README.md" "${DST}.new/" && cp "${SRC}"/lib/*.js "${DST}.new/lib/"
    [ -f "${DST}.new/lib/client.js" ] || { echo "缺 lib/client.js（面板客户端），先 pnpm build"; rm -rf "${DST}.new"; exit 1; }
    python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));d.pop('devDependencies',None);json.dump(d,open(p,'w'),indent=2,ensure_ascii=False)" "${DST}.new/package.json"
    rm -rf "${DST}.old"; [ -d "${DST}" ] && mv "${DST}" "${DST}.old"; mv "${DST}.new" "${DST}"; rm -rf "${DST}.old"
    echo "已部署到 ${DST}（index.js sha256 $(shasum -a 256 "${DST}/lib/index.js" | cut -c1-12)，client.js $(shasum -a 256 "${DST}/lib/client.js" | cut -c1-12)）；已在运行的实例要 stop/start 才会加载" ;;
  start)
    L=$(listener)
    if [ -n "$L" ]; then
      if ours "$L"; then echo "已在运行 pid=${L} 端口 ${PORT}"; echo "$L" > "$PIDF"; exit 0; fi
      echo "端口 ${PORT} 被别的进程占着（pid=${L}），不启动"; exit 1
    fi
    mkdir -p "${DSH_HOME}/logs"
    cd "${DSH_HOME}" || exit 1
    nohup dsh --profile master --no-open --port "${PORT}" >> "$LOG" 2>&1 &
    P=$!; echo "$P" > "$PIDF"
    for i in $(seq 1 60); do [ "$(listener)" = "$P" ] && break; kill -0 "$P" 2>/dev/null || break; sleep 1; done
    if [ "$(listener)" = "$P" ]; then echo "启动 pid=${P}（node 本身）端口 ${PORT}，日志 ${LOG}"
    else echo "启动失败：pid=${P} 没在监听 ${PORT}，看日志 ${LOG}"; exit 1; fi ;;
  stop)
    P=""; [ -f "$PIDF" ] && P=$(cat "$PIDF")
    L=$(listener)
    if [ -n "$L" ] && ! ours "$L"; then echo "端口 ${PORT} 上是别的进程（pid=${L}），不动它"; L=""; fi
    # 先停端口上的 node（真正干活的），再停 pid 文件里记的（旧版可能是 bash 外壳）
    TARGETS=$(printf '%s\n' "$L" "$P" | awk 'NF && !seen[$0]++')
    if [ -z "$TARGETS" ] || { ! kill -0 $TARGETS 2>/dev/null && [ -z "$L" ]; }; then rm -f "$PIDF"; echo "没在运行"; exit 0; fi
    for T in $TARGETS; do
      kill -0 "$T" 2>/dev/null || continue
      ok=""
      for SIG in INT TERM KILL; do
        kill -s "$SIG" "$T" 2>/dev/null
        if wait_exit "$T" 15; then ok=1; echo "已停 pid=${T}（${SIG}）"; break; fi
      done
      [ -z "$ok" ] && { echo "停不下来 pid=${T}"; exit 1; }
    done
    for i in $(seq 1 10); do [ -z "$(listener)" ] && break; sleep 1; done
    if [ -n "$(listener)" ]; then echo "端口 ${PORT} 还被占着 pid=$(listener)"; exit 1; fi
    rm -f "$PIDF"; echo "端口 ${PORT} 已释放" ;;
  status)
    L=$(listener)
    if [ -n "$L" ] && ours "$L"; then echo "运行中 pid=${L} 端口 ${PORT}"
    elif [ -n "$L" ]; then echo "端口 ${PORT} 被别的进程占着 pid=${L}（不是本实例）"; exit 1
    else echo "没在运行"; exit 3; fi ;;
  url) T=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" | tail -1); echo "http://127.0.0.1:${PORT}/?${T}" ;;
  *) echo "用法：$0 deploy|start|stop|status|url"; exit 2 ;;
esac
