#!/bin/bash
# 打发布用的 tgz（GitHub Release 附件 / npm 包）：先 pnpm build，再在临时目录里去掉 devDependencies（workspace: 协议）后 npm pack。
# 用法：scripts/pack.sh [输出目录，默认 ./dist]
# Pack the release tarball: build, drop devDependencies (workspace: protocol) in a staging copy, then npm pack.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT="${1:-$REPO/dist}"; mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd -P)"
PKG="$REPO/packages/dsh-master"
(cd "$REPO" && pnpm -s build)
[ -f "$PKG/lib/index.js" ] && [ -f "$PKG/lib/client.js" ] || { echo "构建产物不全：$PKG/lib"; exit 1; }
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp -R "$PKG/lib" "$PKG/cordis.patch.yml" "$PKG/package.json" "$STAGE/"
for f in README.md README.zh-CN.md LICENSE; do [ -f "$PKG/$f" ] && cp "$PKG/$f" "$STAGE/"; done
node -e "const fs=require('fs');const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,'utf8'));delete d.devDependencies;delete d.scripts;fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n')" "$STAGE/package.json"
(cd "$STAGE" && npm pack --pack-destination "$OUT" --silent > /dev/null)
TGZ="$OUT/$(node -p "const d=require('$STAGE/package.json');d.name.replace('@','').replace('/','-')+'-'+d.version+'.tgz'")"
echo "已打包：${TGZ}（$(du -h "$TGZ" | cut -f1)，sha256 $(shasum -a 256 "$TGZ" | cut -c1-16)）"
tar tzf "$TGZ" | sed 's/^/  /'
