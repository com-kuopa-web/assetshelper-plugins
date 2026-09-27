#!/usr/bin/env bash
# 本机一条命令：自建 LGPL ffmpeg → 打包成组件包 → 打印怎么验证/发布
#
#   bash scripts/build-local.sh                # 构建当前平台 + 打包（默认版本 7.1.5）
#   bash scripts/build-local.sh 8.1.3          # 指定 FFmpeg 版本
#   bash scripts/build-local.sh --clean        # 先清掉 .build/ 与 dist-plugins/（下载中断/构建失败后从零开始）
#   bash scripts/build-local.sh --skip-build   # 已经构建过（.build/out/bin/ffmpeg 存在）→ 只打包
#   FULL=1 bash scripts/build-local.sh         # 额外链接 lame/opus/ass/freetype
#
# 产物：dist-plugins/official.ffmpeg-<version>-<platform>-<arch>.zip（+ 解压目录 + sha256）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 0) 体检：避免 "$VAR 紧跟中文" 这类在 UTF-8 locale 下才会炸的写法
node scripts/check-shell-expansions.mjs >/dev/null || {
  echo "✗ shell 脚本体检未通过：执行 node scripts/check-shell-expansions.mjs 查看详情" >&2
  exit 1
}
node scripts/check-node-paths.mjs >/dev/null || {
  echo "✗ Node 脚本体检未通过：执行 node scripts/check-node-paths.mjs 查看详情" >&2
  exit 1
}

SKIP_BUILD=0
CLEAN=0
VERSION=""
for a in "$@"; do
  case "$a" in
    --clean) CLEAN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) VERSION="$a" ;;
  esac
done
VERSION="${VERSION:-7.1.5}"

case "$(uname -s)" in
  Darwin)               PLATFORM=darwin ;;
  Linux)                PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM=win32 ;;
  *) echo "不认识的平台：$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) ARCH="$(uname -m)" ;;
esac

if [ "$SKIP_BUILD" = "0" ]; then
  echo "▶ 1/2 自建 LGPL ffmpeg ${VERSION} （平台 $PLATFORM/${ARCH} ）"
  bash scripts/build-lgpl-ffmpeg.sh "$VERSION"
else
  echo "▶ 1/2 跳过构建（--skip-build）"
fi

BIN="$ROOT/.build/out/bin/ffmpeg"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"
if [ ! -f "$BIN" ]; then
  echo "✗ 找不到构建产物：${BIN} （先跑一次不带 --skip-build 的构建）" >&2
  exit 1
fi

echo "▶ 2/2 打包组件包（--require-lgpl 强制 LGPL）"
LICENSE_ARGS=(--license licenses/COPYING.LGPLv2.1)
# 合规记录：源码地址 + 源码包校验和（构建阶段已写进 .build/SOURCE-SHA256.txt）
SOURCE_URL="${FFMPEG_SRC_URL:-https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz}"
SOURCE_SHA="$(awk '{print $1}' "$ROOT/.build/SOURCE-SHA256.txt" 2>/dev/null || true)"
SOURCE_ARGS=(--source-url "$SOURCE_URL")
[ -n "$SOURCE_SHA" ] && SOURCE_ARGS+=(--source-sha256 "$SOURCE_SHA")
# FFmpeg 自己的 LICENSE.md 说明"哪些部分 LGPL、哪些是可选 GPL"——随组件分发最能防止误读
[ -f licenses/LICENSE.md ] && LICENSE_ARGS+=(--license licenses/LICENSE.md)
node scripts/build-ffmpeg-plugin.mjs \
  --bin "$BIN" \
  "${LICENSE_ARGS[@]}" \
  "${SOURCE_ARGS[@]}" \
  --version "$VERSION" \
  --out dist-plugins \
  --require-lgpl

SRC="$ROOT/dist-plugins/official.ffmpeg-${VERSION}.zip"
DST="$ROOT/dist-plugins/official.ffmpeg-${VERSION}-${PLATFORM}-${ARCH}.zip"
[ -f "$SRC" ] && mv -f "$SRC" "$DST"

cat <<TIP

✅ 完成：$DST
   （同目录还有解压后的 official.ffmpeg-${VERSION}/，含 manifest/licenses/NOTICES/build-info）

本地怎么验证（不用发布）：
  ① 直接装进本机 App：设置 → 播放 → FFmpeg → 「导入组件包…」→ 选解压后的目录 official.ffmpeg-${VERSION}
  ② 或手动放：把该目录拷到 {userData}/plugins/official.ffmpeg/${VERSION}/（插件解析约定路径）
  ③ 命令行验证二进制：$BIN -hide_banner -version

怎么发布（走 CI 出全平台包）：
  git tag ffmpeg-${VERSION} && git push origin ffmpeg-${VERSION}
  # CI 完成后：plugin-catalog.json 会被自动更新；App 端「组件源」留空即用官方源

只想先本地出一份清单（不发布）：
  node scripts/update-catalog.mjs --dir dist-plugins --catalog plugin-catalog.json \\
       --repo <owner>/assetshelper-plugins --tag ffmpeg-${VERSION}
TIP
