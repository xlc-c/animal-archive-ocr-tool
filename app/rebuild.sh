#!/bin/bash
# 重建 /tmp 构建环境、构建并把产物放回项目目录
set -e
set -o pipefail
# 本机未独立安装 Node：找不到 npm 时回退到 Kimi 自带的 node 运行时
if ! command -v npm >/dev/null 2>&1; then
  KIMI_RT="/c/Users/Administrator/AppData/Local/Programs/Kimi/resources/resources/runtime"
  if [ -f "$KIMI_RT/npm.cmd" ]; then
    export PATH="$KIMI_RT:$PATH"
    npm() { npm.cmd "$@"; }
  else
    echo "ERROR: 找不到 npm，也未发现 Kimi 自带 node 运行时" >&2
    exit 1
  fi
fi
# SRC 取脚本所在目录（即 app/），避免老平台写死的路径
SRC="$(cd "$(dirname "$0")" && pwd)"
BUILD=/tmp/build-app

mkdir -p $BUILD
rm -rf $BUILD/src $BUILD/public
cp -r $SRC/src $BUILD/src
[ -d $SRC/public ] && cp -r $SRC/public $BUILD/public || true
cp $SRC/index.html $SRC/package.json $SRC/package-lock.json $SRC/tsconfig*.json $SRC/vite.config.ts $SRC/tailwind.config.js $SRC/postcss.config.js $BUILD/
# tools 也要先清再拷：cp -r 到已存在的同名目录会嵌套成 tools/tools，旧脚本残留导致打包逻辑悄悄过期
rm -rf $BUILD/tools
[ -d $SRC/tools ] && cp -r $SRC/tools $BUILD/tools || true
if [ ! -d $BUILD/node_modules ]; then
  # 首次构建：复制本地 node_modules（老平台用的是模板目录，本机直接用项目自己的）
  cp -r $SRC/node_modules $BUILD/node_modules
fi
cd $BUILD
npm install --no-audit --no-fund
npm run build
rm -rf $SRC/dist
cp -r dist $SRC/dist
# 单文件离线版：内联 JS/CSS + 模型/wasm/字典 → dist-offline/
# 同时用单文件替换 dist（网站与离线版同一产物，预览/下载行为一致）
rm -rf $SRC/dist-offline
mkdir -p $SRC/dist-offline
node tools/make-offline.mjs dist $SRC/assets-bin $SRC/dist-offline/index.html
cp $SRC/dist-offline/index.html $SRC/dist/index.html
rm -rf $SRC/dist/assets $SRC/dist/models $SRC/dist/ort
echo "=== BUILD OK, dist(单文件) + dist-offline deployed ==="
