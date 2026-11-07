#!/bin/bash
# 用每日备份恢复 dsh-master 状态目录。用法：
#   scripts/restore-backup.sh <备份目录，如 ~/.dsh-master/dsh-master/backups/20261104> <状态目录，如 ~/.dsh-master/dsh-master>
# 先停实例。先把备份完整复制到临时目录，成功了才换上去：任何一步失败，原状态目录都原样不动。
# 原来的状态目录不删，挪到 <状态目录>.before-restore-<时间>；旧的 backups/ 带回新目录。
# 2026-11-04 修：备份目录就在状态目录里面时，旧版先挪走状态目录、备份跟着被挪走，复制失败后只剩一个空目录。
set -u
[ -n "${1:-}" ] && [ -n "${2:-}" ] || { echo "用法：$0 <备份目录> <状态目录>"; exit 2; }
SRC=$(cd "$1" 2>/dev/null && pwd -P) || { echo "备份目录不存在：$1"; exit 2; }
DST_PARENT=$(cd "$(dirname "$2")" 2>/dev/null && pwd -P) || { echo "状态目录的上级不存在：$2"; exit 2; }
DST="${DST_PARENT}/$(basename "$2")"
[ -f "${SRC}/master.db" ] || { echo "备份里没有 master.db：${SRC}"; exit 2; }
if [ -f "${DST}/.lock" ]; then
  P=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pid',''))" "${DST}/.lock" 2>/dev/null)
  if [ -n "${P}" ] && kill -0 "${P}" 2>/dev/null; then echo "状态目录正被进程 ${P} 使用：先停实例（scripts/master-instance.sh stop）再恢复"; exit 3; fi
fi
TS=$(TZ=Asia/Shanghai date '+%Y%m%d-%H%M%S')
STAGE="${DST}.restoring-${TS}"; OLD="${DST}.before-restore-${TS}"
fail() { echo "恢复失败：$1（原状态目录没动；临时目录已清掉）"; rm -rf "${STAGE}"; exit 1; }
# 1) 先完整复制到临时目录（这时原目录还在，备份在它里面也没关系）
mkdir -p "${STAGE}" && chmod 700 "${STAGE}" || fail "建不了临时目录 ${STAGE}"
cp -p "${SRC}/master.db" "${STAGE}/master.db" || fail "复制 master.db"
if [ -f "${SRC}/memory.db" ]; then cp -p "${SRC}/memory.db" "${STAGE}/memory.db" || fail "复制 memory.db"; fi
if [ -d "${SRC}/docs" ]; then cp -pR "${SRC}/docs" "${STAGE}/docs" || fail "复制 docs"; fi
cmp -s "${SRC}/master.db" "${STAGE}/master.db" || fail "master.db 复制后不一致"
if [ -d "${DST}/backups" ]; then cp -pR "${DST}/backups" "${STAGE}/backups" || fail "复制旧的 backups"; fi
# 2) 换上去：原目录挪走，临时目录改名；改名失败就把原目录挪回来
if [ -e "${DST}" ]; then mv "${DST}" "${OLD}" || fail "挪不走原状态目录"; echo "原状态目录已挪到 ${OLD}"; fi
if ! mv "${STAGE}" "${DST}"; then [ -e "${OLD}" ] && mv "${OLD}" "${DST}"; fail "换不上新目录（已把原目录挪回）"; fi
echo "已从 ${SRC} 恢复到 ${DST}"
echo "下一步：node <插件目录>/lib/doctor.js --state ${DST}  自检，然后启动实例"
