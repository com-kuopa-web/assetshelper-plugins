#!/usr/bin/env bash
# 从 **ffmpeg.org 官方源码** 自建 LGPL 版 ffmpeg（macOS / Linux / Windows(MSYS2) 通用）
#
# 为什么走源码：官方下载页写明 “FFmpeg only provides source code.”
# 第三方预编译产物（gyan / BtbN / evermeet / Homebrew）多为 --enable-gpl，macOS 上几乎没有 LGPL 产物。
#
# 默认是 **最小构建**：只用 FFmpeg 自带编解码器 +（macOS）VideoToolbox /（Windows）NVENC·QSV 等硬件编码，
# 不链接任何外部库 —— 依赖最少、编译最快、产物最小，且完全满足本项目的需要
# （截帧/探测靠解码，转码优先硬件编码，音轨用 `-c:a copy`）。
# 需要 libmp3lame/libopus/libass/freetype 时用 FULL=1（编译更慢、依赖更多）。
#
# 用法：
#   bash scripts/build-lgpl-ffmpeg.sh                 # 默认版本见下
#   bash scripts/build-lgpl-ffmpeg.sh 8.1.3           # 指定版本
#   FULL=1 bash scripts/build-lgpl-ffmpeg.sh 7.1.5    # 额外链接 lame/opus/ass/freetype
#   ENABLE_QSV=1 bash scripts/build-lgpl-ffmpeg.sh    # 启用 Intel QSV（**硬要求**，见下）
#   FFMPEG_SRC_SHA256=<已知哈希> bash scripts/build-lgpl-ffmpeg.sh   # 锁定源码校验和（推荐）
#   FFMPEG_SRC_URL=<镜像或 GitHub 归档地址> bash scripts/build-lgpl-ffmpeg.sh   # 官方源太慢/不稳时换源
#     （下载支持断点续传：中断后重跑同一命令会从断点继续）
#
# ⚠️ ENABLE_QSV=1 是**硬要求**，不是"尽量"（2026-09-26 改，F4）：
#   以前 oneVPL 没装上是"打印一句警告然后照样编"，于是 CI 里 pacman 失败时会**静默**产出
#   一份"其实没有 QSV 的 QSV 版"——文件名一模一样，用户端只是悄悄变慢或转码不可用，没有任何报错。
#   现在两个点都会**直接失败**：① configure 前必须找到 oneVPL；② 编完必须能从产物里
#   读出 `h264_qsv`（以**探测结果**为准，不看 configure 行里有没有 --enable-libvpl）。
#   另外会把产物真正依赖的 oneVPL 运行库和它的许可证原文一并收集好（见"产物"）。
#
# 依赖：
#   macOS  : xcode 命令行工具 + brew install nasm pkg-config        （最小构建仅此两项）
#   Ubuntu : sudo apt-get install -y nasm pkg-config
#   Windows: MSYS2 MINGW64 —— pacman -S --needed make nasm pkgconf diffutils
#   （FULL=1 再加 lame/opus/libass/freetype 的开发包；ENABLE_QSV=1 再加 onevpl）
#
# 产物：
#   .build/out/bin/ffmpeg[.exe]      ← 交给 scripts/build-ffmpeg-plugin.mjs 打包
#   .build/out/bin/<运行库>          ← QSV 时：产物**动态依赖**的 oneVPL DLL（与 ffmpeg 同目录）
#   .build/RUNTIME-FILES.txt         ← 上面那些运行库的**文件名**（一行一个，给打包步骤用）
#   .build/SOURCE-SHA256.txt         ← 源码包校验和（合规记录）
#   licenses/COPYING.LGPLv2.1        ← 从源码树复制（随组件包分发，LGPL 义务之一）
#   licenses/oneVPL-LICENSE.txt      ← QSV 时：从 MSYS2 包里取出的 oneVPL 许可证原文
set -euo pipefail

FFMPEG_VERSION="${1:-7.1.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="${WORKDIR:-$ROOT/.build}"
mkdir -p "$WORKDIR" "$ROOT/licenses"
cd "$WORKDIR"

case "$(uname -s)" in
  Darwin)                       PLATFORM=macos ;;
  Linux)                        PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*)         PLATFORM=windows ;;
  *)                            PLATFORM=unknown ;;
esac

# ---------- 0) 预检：能做的判断都放在**下载源码之前** ----------
# 为什么前置：下面第 1~4 步要下几十 MB、编 10~25 分钟。而"这台机器到底能不能按你要的方式编"
# 是**几十毫秒就能答**的问题 —— 让它在最贵的步骤**之前**失败，而不是在 25 分钟之后。
#
# 顺带的好处（也是加它的直接原因）：预检**不碰网络、不碰源码树**，于是
# `PREFLIGHT_ONLY=1` 能在**任何平台**上跑 —— Windows 那几条硬闸门（缺 oneVPL、平台不支持 QSV）
# 因此有了**可执行的测试**（见 `AssetsHelper/scripts/test-ffmpeg-package.mjs`），
# 而不是只能靠"在 CI 上跑一次看看"。
have_pc() { pkg-config --exists "$1" 2>/dev/null; }
have_hdr() { [ -d "/mingw64/include/$1" ] || [ -d "/usr/include/$1" ] || [ -d "/usr/local/include/$1" ]; }

QSV_ON=0
qsv_preflight() {
  [ "${ENABLE_QSV:-0}" = "1" ] || return 0
  if [ "$PLATFORM" != "windows" ]; then
    echo "✗ ENABLE_QSV=1 目前只支持 Windows（MSYS2）。" >&2
    echo "  Linux 的 QSV 要收集 libvpl.so 并核对 ELF 的 NEEDED，那一段还没写；" >&2
    echo "  在没有「随包运行库」机制的情况下打开它，等于发一份装不起来的包 —— 所以这里直接失败。" >&2
    echo "  要么不设 ENABLE_QSV，要么先把 build-lgpl-ffmpeg.sh 里 4c 那段补上。" >&2
    return 1
  fi
  if have_pc vpl || have_pc libvpl; then
    QSV_ON=1
    echo "  ℹ️ ENABLE_QSV=1：oneVPL 可见（pkg-config: vpl/libvpl）→ 会加 --enable-libvpl"
    echo "     编完会核对产物里**真的有** h264_qsv，并把依赖的 DLL 与许可证原文一并收好"
    return 0
  fi
  echo "✗ ENABLE_QSV=1，但找不到 oneVPL（pkg-config: vpl / libvpl）—— 这里**不再降级跳过**。" >&2
  echo "  以前这里是「打印一句警告然后照样编」，于是 CI 里装包失败时会静默产出一份" >&2
  echo "  「其实没有 QSV 的 QSV 版」（文件名一模一样，用户端只是悄悄变慢，没有任何报错）。" >&2
  echo "  装好再编（MSYS2）：pacman -S --needed --noconfirm mingw-w64-x86_64-onevpl" >&2
  echo "  装完确认可见：pkg-config --modversion vpl" >&2
  return 1
}

echo "[0/4] 预检"
qsv_preflight || exit 1
if [ "${PREFLIGHT_ONLY:-0}" = "1" ]; then
  echo "✓ 预检通过（PREFLIGHT_ONLY=1：到此为止，不下载、不编译）"
  exit 0
fi

# ---------- 1) 官方源码：可断点续传的下载 + 完整性校验 + 自愈 ----------
# 注意：网络中断会留下"半截 tar.xz"，若只用"文件存在"判断复用，下一次会解压失败。
# 所以这里：① 下到 .part 再改名；② 复用前先做完整性校验；③ 校验不过就删掉重下。
TARBALL="ffmpeg-${FFMPEG_VERSION}.tar.xz"
SRC_URL="${FFMPEG_SRC_URL:-https://ffmpeg.org/releases/${TARBALL}}"
ASC_URL="${FFMPEG_SRC_URL:+}${FFMPEG_SRC_URL:-https://ffmpeg.org/releases/${TARBALL}}.asc"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

# 用 tar 读一遍归档来校验完整性（macOS 自带 bsdtar 支持 xz，无需额外装 xz）
verify_tarball() {
  [ -f "$1" ] && tar -tf "$1" >/dev/null 2>&1
}

# curl 的续传/重试参数（--retry-all-errors 在旧版 curl 上不存在，探测后再加）
CURL_ARGS=(-fL --retry 5 --retry-delay 3 --retry-connrefused -C -)
if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then CURL_ARGS+=(--retry-all-errors); fi
# 空数组安全展开（见下方 configure 处的说明）

MARKER="$WORKDIR/.unpacked-${FFMPEG_VERSION}"   # 解压完整性标记

if [ -f "$TARBALL" ] && ! verify_tarball "$TARBALL"; then
  echo "⚠️ 已存在的源码包不完整/损坏（很可能是上次下载中断留下的半截文件）→ 删除后重下"
  rm -f "$TARBALL" "$TARBALL.asc" "$WORKDIR/SOURCE-SHA256.txt" "$MARKER"   # 源码换了 → 解压缓存一并失效
fi

if [ ! -f "$TARBALL" ]; then
  echo "[1/4] 下载官方源码：$SRC_URL"
  echo "      （支持断点续传：网络中断后**重跑本脚本**会从断点继续）"
  if ! curl "${CURL_ARGS[@]}" -o "${TARBALL}.part" "$SRC_URL"; then
    echo "✗ 下载失败（已保留 ${TARBALL}.part，重跑本脚本会继续下载）" >&2
    echo "  若 ffmpeg.org 在你所在网络很慢/不稳，可用镜像或 GitHub 归档覆盖源地址：" >&2
    echo "    FFMPEG_SRC_URL=https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n${FFMPEG_VERSION}.tar.gz \\" >&2
    echo "      bash scripts/build-lgpl-ffmpeg.sh ${FFMPEG_VERSION}" >&2
    exit 1
  fi
  mv -f "${TARBALL}.part" "$TARBALL"
  rm -f "$MARKER"   # 新下载的源码 → 旧解压结果作废
else
  echo "[1/4] 复用已下载的源码包（已通过完整性校验）"
fi

if ! verify_tarball "$TARBALL"; then
  echo "✗ 源码包校验失败（tar 无法读取）：$TARBALL" >&2
  echo "  删掉后重跑：rm -f $WORKDIR/$TARBALL && bash scripts/build-lgpl-ffmpeg.sh ${FFMPEG_VERSION}" >&2
  exit 1
fi

# 只有校验通过的包才记录哈希（避免把半截文件的哈希写进合规记录）
SHA="$(sha256_of "$TARBALL")"
echo "$SHA  $TARBALL  (ffmpeg ${FFMPEG_VERSION})  $SRC_URL" | tee "$WORKDIR/SOURCE-SHA256.txt"

if [ -n "${FFMPEG_SRC_SHA256:-}" ] && [ "$SHA" != "$FFMPEG_SRC_SHA256" ]; then
  echo "✗ 源码校验和不匹配：期望 ${FFMPEG_SRC_SHA256} ，实际 ${SHA}" >&2
  exit 1
fi

# PGP 校验（仅官方源有 .asc；能校验就校验）
if [ -z "${FFMPEG_SRC_URL:-}" ] && command -v gpg >/dev/null 2>&1; then
  curl -fsSL --retry 3 -o "${TARBALL}.asc" "${ASC_URL}" || true
  if [ -f "${TARBALL}.asc" ]; then
    gpg --list-keys FFmpeg >/dev/null 2>&1 || curl -fsSL https://ffmpeg.org/ffmpeg-devel.asc | gpg --import >/dev/null 2>&1 || true
    if gpg --verify "${TARBALL}.asc" "$TARBALL" 2>/dev/null; then
      echo "  ✓ PGP 签名校验通过（FFmpeg release signing key）"
    else
      echo "  ⚠️ PGP 校验不可用/未通过 —— 建议用 FFMPEG_SRC_SHA256 固定校验和"
    fi
  fi
fi

# ---------- 2) 解压：原子化 + 完整性判断 + 取许可证原文 ----------
# 为什么不能只看 configure 是否存在：上一次"解压中断"留下的半个目录里**通常已经有 configure**，
# 于是会被误判为完整 → make 阶段才报 `ffbuild/common.mak: No such file or directory`。
# 这里做三件事：① 逐个检查关键文件；② 解压到临时目录再原子改名；③ 成功后打完整性标记。
REQUIRED_TREE="configure ffbuild/common.mak fftools/Makefile libavcodec/Makefile libavformat/Makefile"
tree_ok() {
  local d="ffmpeg-${FFMPEG_VERSION}"
  [ -d "$d" ] || return 1
  for f in $REQUIRED_TREE; do [ -f "$d/$f" ] || return 1; done
  return 0
}

if [ -f "$MARKER" ] && tree_ok; then
  echo "[2/4] 复用已解压的源码（完整性标记存在）"
else
  if [ -d "ffmpeg-${FFMPEG_VERSION}" ]; then
    echo "⚠️ 上一次解压不完整（或源码包已更新）→ 清理后重新解压"
  fi
  echo "[2/4] 解压源码（先解到临时目录，成功后再原子改名）"
  rm -rf "ffmpeg-${FFMPEG_VERSION}" "$MARKER"
  UNPACK_TMP="$WORKDIR/.unpack-$$"
  rm -rf "$UNPACK_TMP"; mkdir -p "$UNPACK_TMP"
  if ! tar xf "$TARBALL" -C "$UNPACK_TMP"; then
    rm -rf "$UNPACK_TMP"
    echo "✗ 解压失败（源码包很可能损坏：先 rm -f $WORKDIR/$TARBALL 再重跑）" >&2
    exit 1
  fi
  if [ ! -d "$UNPACK_TMP/ffmpeg-${FFMPEG_VERSION}" ]; then
    rm -rf "$UNPACK_TMP"
    echo "✗ 解压结果里没有 ffmpeg-${FFMPEG_VERSION} 目录，源码包异常" >&2
    exit 1
  fi
  mv "$UNPACK_TMP/ffmpeg-${FFMPEG_VERSION}" "ffmpeg-${FFMPEG_VERSION}"
  rmdir "$UNPACK_TMP" 2>/dev/null || true
  tree_ok || { echo "✗ 解压后仍缺关键文件（${REQUIRED_TREE} ），源码包异常" >&2; exit 1; }
  touch "$MARKER"
fi

cd "ffmpeg-${FFMPEG_VERSION}"
for f in COPYING.LGPLv2.1 COPYING.LGPLv3 COPYING.GPLv3 LICENSE.md; do
  [ -f "$f" ] && cp "$f" "$ROOT/licenses/$f"
done
[ -f "$ROOT/licenses/COPYING.LGPLv2.1" ] && echo "  ✓ 许可证原文已复制到 licenses/" || echo "  ⚠️ 源码树里没有 COPYING.LGPLv2.1，请手动放一份到 licenses/"

# ---------- 3) configure ----------
# 关键：--disable-gpl --disable-nonfree ⇒ 产物是 LGPL；绝不启用 libx264/libx265/fdk-aac 等。
#
# 硬件编码开关速查（依据 FFmpeg 7.x 自己的 configure 声明，别凭 pkg-config 名字猜！）：
#   nvenc          开关 --enable-nvenc      依赖 pkg-config `ffnvcodec`（**只要头文件**，
#                                            运行期 dlopen NVIDIA 驱动）→ 产物仍单文件
#   amf            开关 --enable-amf        依赖 `amf_deps_any="libdl LoadLibrary"`（**无 pkg-config**，
#                                            只要头文件，运行期 dlopen amfrt64.dll）→ 仍单文件
#   videotoolbox   开关 --enable-videotoolbox  依赖 macOS 系统框架 → 仍单文件
#   qsv            ❗**没有 `--enable-qsv`**：用 --enable-libvpl（oneVPL）或 --enable-libmfx（旧 MediaSDK）
#                  → 需要**链接** libvpl/libmfx，产物会依赖运行库（DLL/SO）→ 默认关闭
#   vaapi          开关 --enable-vaapi      需要链接 libva → 同上，默认关闭
#
# 因此默认只启用"仅头文件 + 运行期动态加载"的编码器，保证产物是**单个可执行文件**（组件包只发 bin/ffmpeg）。
# 需要 QSV/VAAPI 时用 ENABLE_QSV=1 / ENABLE_VAAPI=1 显式开启（会带来运行库依赖，脚本会警告）。
HW=()
add_hw() {
  for x in ${HW[@]+"${HW[@]}"}; do [ "$x" = "$1" ] && return; done   # 去重（此前 --enable-nvenc 会被加两次）
  HW+=("$1")
}
# 注：`have_pc` / `have_hdr` 定义在开头的「0) 预检」里（QSV 的硬闸门要用它们，
# 而预检必须早于下载）。这里不再重复定义。

EXTRA=()
if [ "$PLATFORM" = "macos" ]; then
  add_hw --enable-videotoolbox
  add_hw --enable-audiotoolbox
fi
if [ "$PLATFORM" = "windows" ]; then
  # 便携性：静态链接 exe，避免用户机器缺 DLL（对"仅头文件"的 nvenc/amf 无副作用）
  EXTRA+=(--pkg-config-flags=--static --extra-ldexeflags=-static)
fi
if [ "$PLATFORM" = "windows" ] || [ "$PLATFORM" = "linux" ]; then
  if have_pc ffnvcodec || have_hdr ffnvcodec; then add_hw --enable-nvenc; fi
fi
if [ "$PLATFORM" = "windows" ]; then
  if have_hdr AMF || have_hdr amf; then add_hw --enable-amf; fi
fi
# QSV 的三个硬闸门（平台 / oneVPL 是否存在 / 编完有没有 h264_qsv）都在预检与 4b 里，
# 这里只负责把开关加上 —— 到了这一步它一定是已经验证过的。
if [ "$QSV_ON" = "1" ]; then
  add_hw --enable-libvpl
fi
if [ "${ENABLE_VAAPI:-0}" = "1" ] && [ "$PLATFORM" = "linux" ]; then
  if have_pc libva; then
    add_hw --enable-vaapi
    echo "  ⚠️ ENABLE_VAAPI=1：产物会依赖 libva → 不再是单文件"
  else
    echo "  ⚠️ ENABLE_VAAPI=1 但找不到 libva → 跳过 VAAPI"
  fi
fi

FULL_LIBS=()
FULL_LABEL=""
if [ "${FULL:-0}" = "1" ]; then
  FULL_LIBS=(--enable-libmp3lame --enable-libopus --enable-libass --enable-libfreetype)
  FULL_LABEL=" / FULL"
  echo "  ℹ️ FULL=1：额外链接 libmp3lame / libopus / libass / freetype（需对应开发包）"
fi

echo "[3/4] configure（LGPL${FULL_LABEL}）"
echo "  平台开关：${EXTRA[*]:-（无）}"
echo "  硬件编码：${HW[*]:-（无——将只能 -c copy 直通）}"
if [ ${#HW[@]} -eq 0 ]; then
  echo "  ⚠️ 没有可用的硬件编码器：本构建无法转码（LGPL 构建没有 libx264）。"
  echo "     常见原因：缺 ffnvcodec 头文件（NVENC）/ AMF 头文件（AMD）/ 非 macOS 平台。"
fi
# 说明：数组用 ${arr[@]+"${arr[@]}"} 展开 —— macOS 自带 bash 3.2 下，
# `set -u` + 空数组的 "${arr[@]}" 会报 unbound variable（bash 4.4 才修）。
# shellcheck disable=SC2086
./configure \
  --prefix="$WORKDIR/out" \
  --disable-gpl --disable-nonfree \
  --disable-doc --disable-debug --disable-ffplay --disable-sdl2 \
  --enable-static --disable-shared \
  ${EXTRA_CONFIGURE:-} ${EXTRA[@]+"${EXTRA[@]}"} ${HW[@]+"${HW[@]}"} ${FULL_LIBS[@]+"${FULL_LIBS[@]}"}

# ---------- 4) 编译 ----------
JOBS="$( (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4) )"
echo "[4/4] 编译（-j${JOBS} ；首次在 CI 上约 10~25 分钟）"
make -j"$JOBS"
make install

EXE="$WORKDIR/out/bin/ffmpeg"
[ -f "$EXE.exe" ] && EXE="$EXE.exe"
echo
echo "✅ 产物：$EXE"
"$EXE" -hide_banner -version | sed -n '1,3p'
echo
if "$EXE" -hide_banner -version | grep -qE -- '--enable-(gpl|nonfree)'; then
  echo "✗✗ configuration 行里出现了 --enable-gpl/--enable-nonfree：这不是 LGPL 构建，禁止分发！" >&2
  exit 1
fi
echo "✓ 已确认 configuration 行不含 --enable-gpl / --enable-nonfree（LGPL 构建）"
echo "  源码校验和：${SHA} （记录在 SOURCE-SHA256.txt）"

# ---------- 4b) QSV：以**产物里真的有没有**为准，不看 configure 行 ----------
# configure 里有 `--enable-libvpl` 只说明"加了这个开关"；编出来的 exe 里有没有 h264_qsv
# 是另一回事（版本不匹配、被别的开关裁掉都可能）。声明与事实不一致时以事实为准。
if [ "$QSV_ON" = "1" ]; then
  echo
  # FFmpeg 的 -encoders 是固定宽度表格：6 个字符的能力列 + 编码器名
  if ! "$EXE" -hide_banner -encoders 2>/dev/null | grep -qE '^[[:space:]]*[A-Z.]{6}[[:space:]]+h264_qsv([[:space:]]|$)'; then
    echo "✗ ENABLE_QSV=1，但产物里**没有** h264_qsv —— 不能当成 QSV 版发出去。" >&2
    echo "  产物：$EXE" >&2
    echo "  这份产物里 H.264 相关的编码器（原样贴出，便于定位）：" >&2
    "$EXE" -hide_banner -encoders 2>/dev/null | grep -i h264 | sed 's/^/    /' >&2 || true
    echo "  常见原因：oneVPL 开发包版本与 FFmpeg 要求不符；configure 日志里会有 libvpl 相关的检查结果。" >&2
    exit 1
  fi
  echo "✓ ENABLE_QSV=1：产物里确实有 h264_qsv（探测得到，非 configure 声明）"
fi

# ---------- 4c) QSV 运行库：**产物真的动态依赖它**才随包发 ----------
# `--enable-libvpl` 让 ffmpeg 依赖 oneVPL 的运行库。产物是"静态链接了它"还是"运行期加载 DLL"，
# 只能读二进制才知道 —— 所以这里用 objdump 看导入表，而不是猜。
#
# 判据与决策：
#   · 导入表里**有** libvpl  → 必须随包发（否则用户端 ffmpeg 起不来，0xc0000135）
#   · 导入表里**没有**、且 objdump 确实跑成功 → 静态链接了 → 不发（发了是白占体积）
#   · objdump 不可用 → **读不到就不敢说"不需要"** → 保守按"需要"处理（多带一个 DLL，
#     最坏是多几 MB；不带的后果是用户端直接起不来，两者不是一个量级）
RUNTIME_LIST="$WORKDIR/RUNTIME-FILES.txt"
rm -f "$RUNTIME_LIST"

# 把运行库放到 ffmpeg **同目录**（Windows 的 DLL 搜索顺序里，exe 所在目录优先于系统目录，
# 用户端才不用配 PATH），并把文件名记进 RUNTIME-FILES.txt 供打包步骤取用。
copy_runtime() {
  local want="$1"
  local src
  src="$(find "$VPL_PREFIX/bin" /mingw64/bin -maxdepth 1 -iname "$want" 2>/dev/null | head -1)"
  if [ -z "$src" ]; then
    echo "✗ 产物动态依赖 ${want}，但在一个能想到的地方都找不到它：" >&2
    echo "    $VPL_PREFIX/bin 、/mingw64/bin" >&2
    echo "  发一份缺运行库的包 = 用户端 ffmpeg 启动失败，所以这里失败。" >&2
    echo "  确认 oneVPL 装完整：pacman -Ql mingw-w64-x86_64-onevpl | grep -i '\.dll$'" >&2
    return 1
  fi
  cp -f "$src" "$WORKDIR/out/bin/$(basename "$src")"
  basename "$src" >> "$RUNTIME_LIST"
  echo "  + 随包运行库：$(basename "$src")  ← ${src}"
}

if [ "$QSV_ON" = "1" ]; then
  VPL_PREFIX="$(pkg-config --variable=prefix vpl 2>/dev/null || pkg-config --variable=prefix libvpl 2>/dev/null || true)"
  [ -n "$VPL_PREFIX" ] || VPL_PREFIX=/mingw64

  IMPORTS=""
  if command -v objdump >/dev/null 2>&1; then
    IMPORTS="$(objdump -p "$EXE" 2>/dev/null | sed -n 's/^[[:space:]]*DLL Name:[[:space:]]*//p' | tr 'A-Z' 'a-z')" || true
  fi
  VPL_DLL="$(printf '%s\n' "$IMPORTS" | grep -E '^libvpl' | head -1 || true)"

  if [ -n "$VPL_DLL" ]; then
    echo "  objdump 导入表里看到 ${VPL_DLL} → 动态链接，必须随包发"
    copy_runtime "$VPL_DLL"
  elif [ -n "$IMPORTS" ]; then
    echo "  objdump 导入表里**没有** libvpl → 静态链接进 exe 了，不需要随包 DLL"
  else
    echo "  ⚠️ 读不到导入表（objdump 不可用）：不猜「不需要」，按**需要**处理"
    FOUND="$(find "$VPL_PREFIX/bin" /mingw64/bin -maxdepth 1 -iname 'libvpl*.dll' 2>/dev/null | head -1 || true)"
    if [ -z "$FOUND" ]; then
      echo "✗ 读不到导入表，也在 \$VPL_PREFIX/bin 与 /mingw64/bin 里找不到任何 libvpl*.dll。" >&2
      echo "  没有 objdump 就无法判断产物是不是静态链接：不敢当「不需要」处理（后果是用户端起不来）。" >&2
      echo "  装上 binutils（MSYS2 的 mingw-w64-x86_64-toolchain 里就有 objdump）后重跑。" >&2
      exit 1
    fi
    copy_runtime "$(basename "$FOUND")"
  fi

  # oneVPL 的许可证原文：MIT 类许可要求随分发附上版权与许可声明。
  # MSYS2 把它放在 share/licenses 下，**目录名带包名前缀**，所以用找的而不是写死路径。
  VPL_LIC="$(find /mingw64/share/licenses -maxdepth 3 -iname 'LICENSE*' -ipath '*vpl*' 2>/dev/null | head -1 || true)"
  if [ -z "$VPL_LIC" ]; then
    echo "✗ 找不到 oneVPL 的许可证原文：随包分发必须有它（MIT 类许可要求保留声明）。" >&2
    echo "  找过：/mingw64/share/licenses/**/*vpl*/LICENSE*" >&2
    echo "  用这条看看包里到底带了什么：pacman -Ql mingw-w64-x86_64-onevpl | grep -i license" >&2
    exit 1
  fi
  cp -f "$VPL_LIC" "$ROOT/licenses/oneVPL-LICENSE.txt"
  echo "  ✓ oneVPL 许可证原文：${VPL_LIC}"
  echo "                     → licenses/oneVPL-LICENSE.txt"
fi

if [ -f "$RUNTIME_LIST" ]; then
  echo "  运行库清单（给打包步骤用）：$RUNTIME_LIST"
  sed 's/^/    · /' "$RUNTIME_LIST"
fi
echo
echo "下一步：bash scripts/build-local.sh --skip-build   # 或直接 node scripts/build-ffmpeg-plugin.mjs --bin $EXE --license licenses/COPYING.LGPLv2.1 --version $FFMPEG_VERSION"
if [ "$QSV_ON" = "1" ]; then
  echo "        （QSV 还要加：--require-qsv，以及每个运行库一个 --runtime \"$WORKDIR/out/bin/<名字>\"，"
  echo "          名字见上面的 RUNTIME-FILES.txt；oneVPL 的许可证用 --license licenses/oneVPL-LICENSE.txt 一起带上）"
fi
