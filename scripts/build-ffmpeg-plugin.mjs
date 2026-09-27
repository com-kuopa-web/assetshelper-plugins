#!/usr/bin/env node
// ⚠️ 本文件是从主仓库 `AssetsHelper/scripts/build-ffmpeg-plugin.mjs` 复制来的（vendor）。
//    要改就改主副本，然后把**这两个文件**一起复制过来（本脚本 import 了 verify-package-zip.mjs）：
//      cp AssetsHelper/scripts/build-ffmpeg-plugin.mjs AssetsHelper/scripts/verify-package-zip.mjs assetshelper-plugins/scripts/
/**
 * 构建 `official.ffmpeg` 插件包（F2）
 *
 * 产出：
 *   <out>/official.ffmpeg-<version>/
 *     ├── manifest.json            插件清单（provides: capability=ffmpeg）
 *     ├── bin/ffmpeg               可执行文件
 *     ├── bin/<运行库>            随包运行库（`--runtime`，如 Windows 的 oneVPL DLL）
 *     ├── licenses/…               许可证原文（必须随插件分发）
 *     ├── THIRD-PARTY-NOTICES.md   来源 / 源码获取方式 / 如何替换
 *     └── build-info.json          configure 行 + 版本 + sha256
 *   <out>/official.ffmpeg-<version>.zip        （有 zip 命令时）
 *   <out>/official.ffmpeg-<version>.sha256     分发包校验和（写进清单源用）
 *   <out>/catalog-entry.json                  可直接粘进 plugin-catalog 的片段
 *
 * 用法：
 *   node scripts/build-ffmpeg-plugin.mjs --bin /path/to/lgpl/ffmpeg \
 *        [--license /path/to/COPYING.LGPLv2.1] [--out dist-plugins] [--version 6.1] \
 *        [--require-qsv] [--runtime /path/to/libvpl-2.dll ...]
 *
 * 许可证红线（脚本会强制）：
 *   · 含 `--enable-nonfree` 的构建 **不可再分发** → 直接拒绝；
 *   · GPL 构建允许但要提醒"需提供对应源码"；
 *   · 推荐用 **LGPL 构建**（见 notes/本体/媒体播放/FFmpeg接入与许可证.md）。
 *
 * 两个"别把没做到当成做到了"的闸门（2026-09-26 加，F4 QSV 变体）：
 *   · `--require-qsv`：探测结果里**必须**有 `h264_qsv`，否则直接失败。
 *   · `--runtime <file>`：随包分发运行库（如 oneVPL 的 `libvpl-2.dll`），拷进 `bin/`
 *     （与 ffmpeg 同目录 —— Windows 的 DLL 搜索顺序里，exe 所在目录排在系统目录之前），
 *     并**核对它真的进了 zip**。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listZipNames, missingEntries } from './verify-package-zip.mjs'

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const out = {
    bin: null,
    licenses: [],
    out: 'dist-plugins',
    version: null,
    id: 'official.ffmpeg',
    name: 'FFmpeg 插件（第三方）',
    author: 'FFmpeg project',
    sourceUrl: null,
    sourceSha256: null,
    requireLgpl: false,
    requireQsv: false,
    runtimes: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--bin') out.bin = argv[++i]
    else if (a === '--license') out.licenses.push(argv[++i])
    else if (a === '--runtime') out.runtimes.push(argv[++i])
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--version') out.version = argv[++i]
    else if (a === '--id') out.id = argv[++i]
    else if (a === '--name') out.name = argv[++i]
    else if (a === '--author') out.author = argv[++i]
    else if (a === '--source-url') out.sourceUrl = argv[++i]
    else if (a === '--source-sha256') out.sourceSha256 = argv[++i]
    else if (a === '--require-lgpl') out.requireLgpl = true
    else if (a === '--require-qsv') out.requireQsv = true
    else if (a === '-h' || a === '--help') out.help = true
    else {
      console.error(`未知参数：${a}`)
      process.exit(2)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.bin) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''))
  process.exit(args.help ? 0 : 2)
}

// ⚠️ 必须用 fileURLToPath：`new URL(import.meta.url).pathname` 在 Windows 上得到 `/D:/a/…`，
//    再交给 path.resolve 会变成 `D:\D:\a\…`（ENOENT: mkdir 'D:\D:\a\…'）。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binPath = resolve(args.bin)
if (!existsSync(binPath)) {
  console.error(`✗ 找不到：${binPath}`)
  process.exit(1)
}

/* ---------------- 探测（与宿主同一套判定） ---------------- */
function run(bin, ffArgs) {
  return execFileSync(bin, ['-hide_banner', ...ffArgs], { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024 })
}

console.log(`[build-ffmpeg-plugin] 探测 ${binPath}`)
let versionOut
try {
  versionOut = run(binPath, ['-version'])
} catch (error) {
  console.error(`✗ 这份二进制跑不起来：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
const version = args.version ?? /ffmpeg version (\S+)/.exec(versionOut)?.[1] ?? 'unknown'
const configuration = /configuration:\s*(.*)/.exec(versionOut)?.[1]?.trim() ?? ''
const encoders = Array.from(run(binPath, ['-encoders']).matchAll(/^\s*[A-Z.]{6}\s+(\S+)/gm)).map((m) => m[1])

const license = /--enable-nonfree\b/.test(configuration)
  ? 'nonfree'
  : /--enable-gpl\b/.test(configuration)
    ? 'GPL'
    : configuration
      ? 'LGPL'
      : 'unknown'

console.log(`  版本 ${version} · 许可证 ${license} · 编码器 ${encoders.length} 个`)

/* ---------------- 许可证红线 ---------------- */
if (license === 'nonfree') {
  console.error(
    '\n✗ 这份构建含 `--enable-nonfree`，按 FFmpeg 官方说明**不可再分发**，不能做成分发包。' +
      '\n  请改用 LGPL 构建（或用户在设置里自行指定路径，由用户自担）。' +
      '\n  参考：notes/本体/媒体播放/FFmpeg接入与许可证.md',
  )
  process.exit(1)
}
if (args.requireLgpl && license !== 'LGPL') {
  console.error(
    `\n✗ --require-lgpl：许可证必须能确认为 LGPL，实际判定为 ${license}。` +
      (license === 'GPL'
        ? '\n  这份是 GPL 构建：换用 LGPL 构建（scripts/build-lgpl-ffmpeg.sh），或去掉 --require-lgpl 自行承担 GPL 义务。'
        : license === 'nonfree'
          ? '\n  这份含 --enable-nonfree，**不可再分发** —— 不能用它做分发包。'
          : '\n  无法从 `ffmpeg -version` 的 configuration 行判定许可证（可能是探测失败或构建信息被裁剪）：' +
            '\n  请确认这份二进制能被正常执行，并输出包含 configuration 行的版本信息。'),
  )
  process.exit(1)
}
if (license === 'GPL') {
  console.warn(
    '\n⚠️ 这是 GPL 构建：可以分发，但必须随插件提供许可证原文，并提供/承诺提供**对应源码**。' +
      '\n   想减义务请换 LGPL 构建（代价：没有 libx264 软编，只能硬件编码）。',
  )
}
if (!encoders.some((e) => /h264_(videotoolbox|nvenc|qsv|amf)|libx264/.test(e))) {
  console.warn('⚠️ 这份构建里没找到可用的 H.264 编码器：转码功能会不可用（截帧/探测仍可用）。')
}

/* ---------------- QSV 硬闸门（F4：别把"没启用 QSV"当成"启用了"发出去） ---------------- */
/**
 * 为什么这条断言必须存在，而不是靠"构建脚本打了日志"：
 *
 * Windows 那份产物默认**不开** QSV（`ENABLE_QSV=1` 才开，因为 `--enable-libvpl` 会引入
 * 运行库依赖）。而 `ENABLE_QSV=1` 这条路上有**两个静默降级点**：
 *   ① oneVPL 头文件没装上（CI 里那个 pacman 步骤以前是 `continue-on-error`）→
 *      `build-lgpl-ffmpeg.sh` 打的是一句 `⚠️ 跳过 QSV`，然后**照样**编出一份没 QSV 的 ffmpeg；
 *   ② 就算 `--enable-libvpl` 加上了，也可能因为版本/配置原因最终没编进 `h264_qsv`。
 * 这两条都会让产物**看起来**是 QSV 版（同一个文件名 `official.ffmpeg-<v>-win32-x64.zip`），
 * 而用户那边的转码只是**悄悄变慢**（回落到别的编码器）或直接不可用 —— 没有任何报错。
 *
 * 所以这里不"提醒"，直接失败。判据是**探测到的编码器清单**（事实），不是 configure 行里
 * 有没有 `--enable-libvpl`（声明）。声明与事实不一致时，以事实为准。
 */
if (args.requireQsv) {
  if (!encoders.includes('h264_qsv')) {
    const enableLibvpl = /--enable-libvpl\b/.test(configuration)
    console.error(
      '\n✗ --require-qsv：这份二进制的编码器清单里**没有 `h264_qsv`**，不能当成 QSV 版发包。' +
        `\n  · configure 行里${enableLibvpl ? '**有**' : '**没有**'} \`--enable-libvpl\`` +
        (enableLibvpl
          ? ' —— 即"声明启用了 oneVPL，但实际没编出 qsv 编码器"（版本不匹配 / 配置被裁剪）。'
          : ' —— 即"构建时根本没启用 oneVPL"（多半是 oneVPL 开发包没装上，脚本静默跳过了）。') +
        `\n  · 这份产物共 ${encoders.length} 个编码器，H.264 相关的：` +
        `${encoders.filter((e) => /h264/i.test(e)).join('、') || '（一个都没有）'}` +
        '\n  修法：确认构建机上 oneVPL 装好了（MSYS2：`pacman -S mingw-w64-x86_64-onevpl`），' +
        '\n  再用 `ENABLE_QSV=1` 重新构建；或去掉 `--require-qsv`（那就是明确发一份**不带** QSV 的包）。',
    )
    process.exit(1)
  }
  console.log('  ✅ --require-qsv：编码器清单里有 h264_qsv')
}

/* ---------------- 随包运行库（`--runtime`） ---------------- */
/**
 * 为什么要有这个口子：`ENABLE_QSV=1` 让 ffmpeg 依赖 oneVPL 的运行库（Windows 上是
 * `libvpl-2.dll`）—— 只发 `bin/ffmpeg.exe` 的话，用户机器上没有那个 DLL，
 * ffmpeg **启动就失败**（`0xc0000135` 之类），而报错点离真因极远。
 *
 * ⚠️ 这里**不做静态/动态链接的猜测**：由调用方（`build-lgpl-ffmpeg.sh`，它有 `objdump`
 * 能读 PE 导入表）决定要不要传。脚本只负责：校验文件、放进 `bin/`、记账、**核对它进了 zip**。
 */
const runtimeFiles = []
for (const r of args.runtimes) {
  const p = resolve(r)
  if (!existsSync(p)) {
    console.error(`✗ --runtime 指向的文件不存在：${p}`)
    process.exit(1)
  }
  const st = statSync(p)
  if (!st.isFile()) {
    console.error(`✗ --runtime 必须是文件：${p}`)
    process.exit(1)
  }
  if (st.size === 0) {
    console.error(`✗ --runtime 是个空文件（0 字节）：${p}\n  空 DLL 会让用户端 ffmpeg 启动失败，且这条错很难查。`)
    process.exit(1)
  }
  const name = basename(p)
  if (runtimeFiles.some((f) => f.name === name)) {
    console.error(`✗ --runtime 有重名文件：${name}\n  同一个 basename 会被后一份覆盖，打包结果不可预期。`)
    process.exit(1)
  }
  runtimeFiles.push({ name, path: p, size: st.size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') })
}

/* ---------------- 组装包 ---------------- */
const outDir = resolve(root, args.out)
const pkgDir = join(outDir, `${args.id}-${version}`)
rmSync(pkgDir, { recursive: true, force: true })
mkdirSync(join(pkgDir, 'bin'), { recursive: true })
mkdirSync(join(pkgDir, 'licenses'), { recursive: true })

const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const destBin = join(pkgDir, 'bin', exe)
copyFileSync(binPath, destBin)
if (process.platform !== 'win32') execFileSync('chmod', ['755', destBin])

// 运行库放进 `bin/`：必须与 ffmpeg 同目录 —— Windows 的 DLL 搜索顺序里，
// "可执行文件所在目录"排在系统目录之前，用户端才不用配 PATH。
for (const f of runtimeFiles) {
  copyFileSync(f.path, join(pkgDir, 'bin', f.name))
  console.log(`  + 随包运行库 bin/${f.name}（${(f.size / 1024 / 1024).toFixed(2)} MB，sha256 ${f.sha256.slice(0, 12)}…）`)
}
if (runtimeFiles.length) {
  console.log('    注意：这些是**依赖**，不是可执行文件本身；用户端缺了它们 ffmpeg 起不来。')
}

/**
 * 许可证文件：显式指定（可多个）> 二进制同目录里的 COPYING/LICENSE/NOTICE
 *
 * ⚠️ 显式指定的那些**要先校验**：以前直接把路径丢给 `copyFileSync`，于是路径写错时
 * 是一整段 Node 堆栈（`ENOENT: copyfile`）—— 而这条链上路径写错**很正常**
 * （CI 里 oneVPL 的许可证只有开 QSV 那格才有；本地没有 `.build/out/bin/ffmpeg` 时更常见）。
 * 报错该说"哪个文件没找到、该怎么补"，而不是让打包脚本崩在复制那一行。
 */
const licenseFiles = []
if (args.licenses.length) {
  for (const l of args.licenses) {
    const p = resolve(l)
    if (!existsSync(p)) {
      console.error(
        `\n✗ --license 指向的文件不存在：${p}` +
          '\n  许可证原文必须随包分发（LGPL 要求；oneVPL 这类 MIT 依赖也要求保留声明），' +
          '\n  所以这里**不接受"路径写错了也先出包"**。补齐后再打包，或去掉这个 --license。',
      )
      process.exit(1)
    }
    const st = statSync(p)
    if (!st.isFile() || st.size === 0) {
      console.error(`\n✗ --license 必须是**非空文件**：${p}（${st.isDirectory() ? '这是目录' : `${st.size} 字节`}）`)
      process.exit(1)
    }
    const name = basename(p)
    if (licenseFiles.some((f) => f.name === name)) {
      console.error(`\n✗ --license 有重名文件：${name}\n  同一份会覆盖前一份，合规材料就不完整了。`)
      process.exit(1)
    }
    licenseFiles.push({ name, path: p })
  }
} else {
  for (const f of readdirSync(dirname(binPath))) {
    if (/^(copying|license|notice)/i.test(f) && statSync(join(dirname(binPath), f)).isFile()) {
      licenseFiles.push({ name: f, path: join(dirname(binPath), f) })
    }
  }
}
for (const l of licenseFiles) copyFileSync(l.path, join(pkgDir, 'licenses', l.name))
if (licenseFiles.length === 0) {
  writeFileSync(
    join(pkgDir, 'licenses', 'MISSING.txt'),
    [
      `未随包提供许可证原文（构建时没在 ${dirname(binPath)} 找到 COPYING/LICENSE/NOTICE，也没传 --license）。`,
      '',
      license === 'GPL'
        ? 'GPL 构建必须提供许可证原文（COPYING.GPLv3）+ 对应源码获取方式。'
        : 'LGPL 构建必须提供 COPYING.LGPLv2.1（或 v3）+ 对应源码获取方式。',
      '补齐后重新构建：node scripts/build-ffmpeg-plugin.mjs --bin … --license /path/to/COPYING.LGPLv2.1 [--license …/LICENSE.md]',
      '',
    ].join('\n'),
    'utf8',
  )
  console.warn('⚠️ 没有找到许可证文件：已在 licenses/MISSING.txt 留下提醒（发布前必须补齐）')
}

const sha256 = createHash('sha256').update(readFileSync(destBin)).digest('hex')

writeFileSync(
  join(pkgDir, 'manifest.json'),
  JSON.stringify(
    {
      id: args.id,
      name: args.name,
      version,
      apiVersion: 1,
      description: `FFmpeg ${version}（${license} 构建）—— 为音视频插件提供转码 / 截帧 / 探测能力`,
      author: args.author,
      official: false,
      kind: 'capability-provider',
      provides: [{ capability: 'ffmpeg', version, license, encoders: encoders.filter((e) => /^(h264|hevc|aac|libx264|libx265)/.test(e)) }],
      permissions: [],
      entry: { host: `bin/${exe}` },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

writeFileSync(
  join(pkgDir, 'build-info.json'),
  JSON.stringify(
    {
      id: args.id,
      version,
      license,
      configuration,
      sha256,
      // 硬件编码能力（**探测到的事实**，不是 configure 行的声明）：页面上要能核对
      // "这份包到底带不带 QSV"，而不是只看文件名猜。
      hardware: {
        qsv: encoders.includes('h264_qsv'),
        nvenc: encoders.includes('h264_nvenc'),
        amf: encoders.includes('h264_amf'),
        videotoolbox: encoders.includes('h264_videotoolbox'),
      },
      // 随包运行库（`--runtime`）：用户端排查"ffmpeg 起不来"时要看这里
      ...(runtimeFiles.length
        ? { runtimeFiles: runtimeFiles.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })) }
        : {}),
      ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
      ...(args.sourceSha256 ? { sourceSha256: args.sourceSha256 } : {}),
      builtAt: new Date().toISOString(),
      builtFromBinary: binPath,
      ffmpegVersionOutput: versionOut,
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

/**
 * 硬件编码的**实际**能力清单（来自探测，不是 configure 声明）。
 * 声明与事实不一致时以事实为准 —— 见上面 `--require-qsv` 那段说明。
 */
const hwNames = [
  ['h264_qsv', 'QSV（Intel，需注意下节的随包运行库）'],
  ['h264_nvenc', 'NVENC（NVIDIA）'],
  ['h264_amf', 'AMF（AMD）'],
  ['h264_videotoolbox', 'VideoToolbox（macOS）'],
  ['libx264', 'libx264（软件编码，GPL）'],
]
const hwOn = hwNames.filter(([id]) => encoders.includes(id))
const hwSummary = hwOn.length ? hwOn.map(([, label]) => label).join('、') : '**（无）**'

/** 随包运行库小节：只在真的带了运行库时出现（没带就别写一节空话） */
const runtimeSection = runtimeFiles.length
  ? `
## 随包运行库（不是可执行文件本身，但缺了它 ffmpeg 起不来）

本构建在 FFmpeg 之外**还依赖**下面这些动态库，它们已经放在 \`bin/\` 里（与 \`ffmpeg\` 同目录）：

${runtimeFiles.map((f) => `- \`bin/${f.name}\` —— ${(f.size / 1024 / 1024).toFixed(2)} MB，SHA-256 \`${f.sha256}\``).join('\n')}

**为什么必须随包发**：Windows 加载 DLL 时会先在 **exe 所在目录**找。少了这些库，
用户端的 ffmpeg 会以 \`0xc0000135\`（找不到模块）之类的错误**直接启动失败** ——
而宿主只会报"FFmpeg 无法执行"，离真因很远。

**这些库各自的许可证**：见 \`licenses/\` 目录（构建脚本会把对应原文一并复制进来）。
`
  : ''

writeFileSync(
  join(pkgDir, 'THIRD-PARTY-NOTICES.md'),
  `# 第三方插件声明：FFmpeg ${version}

| 项 | 值 |
|---|---|
| 插件 | FFmpeg（\`ffmpeg\` 可执行文件） |
| 版本 | ${version} |
| 构建许可证 | **${license}** |
| 许可证治理 | ${license === 'LGPL' ? 'LGPL-2.1-or-later' : license} |
| 硬件编码（实测） | ${hwSummary} |${runtimeFiles.length ? `\n| 随包运行库 | ${runtimeFiles.map((f) => `\`${f.name}\``).join('、')} |` : ''}
| 对应源码 | ${args.sourceUrl ?? '见下方"对应源码"'} |${args.sourceSha256 ? `\n| 源码包 SHA-256 | \`${args.sourceSha256}\` |` : ''}
| 构建机器上的二进制路径 | \`${binPath}\` |
| SHA-256 | \`${sha256}\` |

## 许可证原文与适用范围

见 \`licenses/\` 目录（${licenseFiles.map((l) => l.name).join('、') || '⚠️ 缺失，见 licenses/MISSING.txt'}）。

**适用范围**：本插件按 **${license}** 分发，判定依据是 \`build-info.json\` 里记录的 configure 行
（含 \`--disable-gpl --disable-nonfree\`）。FFmpeg 中受 GPL 覆盖的**可选部分**（libpostproc、
部分 x86 汇编优化与滤镜等）在本构建中**未启用**；若 \`licenses/\` 内另含其它许可文本（如 GPLv3），
那是 FFmpeg 源码树随附的原文，**不适用于本二进制**（FFmpeg 官方的许可证分布说明见其 \`LICENSE.md\`）。

## 对应源码

- 源码包：${args.sourceUrl ?? `https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`}
${args.sourceSha256 ? `- 源码包 SHA-256：\`${args.sourceSha256}\`\n` : ''}- 构建配置（configure 行）：

\`\`\`
${configuration || '(未记录)'}
\`\`\`

> 若本插件由第三方预编译产物构建，请一并说明其构建脚本来源。
${runtimeSection}
## 如何替换本插件

本插件是**独立可执行文件**，用户可随时替换：

1. 打开「设置 → 视频 → FFmpeg」；
2. 点「自动扫描本机」选择系统里已有的 FFmpeg，或「手动选择…」指定任意一份；
3. 也可以「导入插件包…」重新导入另一份构建。

替换后立即生效（无需重启）。

## 说明

- 本插件**不随主程序安装包分发**，由用户按需获取；
- 转码优先使用硬件编码（VideoToolbox / NVENC / QSV / AMF）；
  本构建**实测**可用的硬件编码：${hwSummary}。
  ${
    license === 'LGPL'
      ? 'LGPL 构建不含 libx264，因此**没有软件 H.264 编码**。'
      : '当前为 GPL 构建：如无必要，建议改用 LGPL 构建以减义务。'
  }
- 同一平台的产物**只有一个**（文件名 \`official.ffmpeg-<版本>-<平台>-<架构>.zip\`）：
  带不带 QSV 体现在**这一份包的能力**上（见上面的"硬件编码（实测）"），
  而不是发两份包让用户挑 —— 清单按 (id, 平台, 架构) 取一条，同名两个包只会互相覆盖。
`,
  'utf8',
)

console.log(`✅ 插件包目录：${pkgDir}`)

/* ---------------- 打包 zip + 校验和 + 清单片段 ---------------- */
const zipName = `${args.id}-${version}.zip`
const zipPath = join(outDir, zipName)
let zipped = false
try {
  rmSync(zipPath, { force: true })
  // macOS / Linux 自带 zip；Windows 走 PowerShell Compress-Archive（下面 catch 里兜底）
  execFileSync('zip', ['-qr', zipPath, basename(pkgDir)], { cwd: outDir })
  zipped = true
} catch {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${pkgDir}' -DestinationPath '${zipPath}' -Force`], { stdio: 'ignore' })
    zipped = true
  } catch {
    console.warn('⚠️ 没找到 zip / PowerShell：已产出目录，可手动压缩后再分发')
  }
}

if (zipped) {
  /**
   * **压完必须回读**：校验和算的是"这个 zip 文件"，里面装了什么得另说。
   * 少了运行库 DLL / 许可证原文 / manifest，都是"看起来成功了"的事故 ——
   * 见 `verify-package-zip.mjs` 顶上那段说明。
   */
  const required = [
    'manifest.json',
    'build-info.json',
    'THIRD-PARTY-NOTICES.md',
    `bin/${exe}`,
    ...runtimeFiles.map((f) => `bin/${f.name}`),
    ...licenseFiles.map((l) => `licenses/${l.name}`),
  ]
  let names
  try {
    names = listZipNames(zipPath)
  } catch (e) {
    console.error(
      `\n✗ 打出来的 zip 读不出来，无法核对内容：${e.message}` +
        (e.code === 'ZIP64' ? '\n  （zip64 容器本脚本不解析：宁可停下来看一眼，也不当成"验过了"。）' : '') +
        `\n  包内容自检不通过 ⇒ 不产出校验和与清单片段（免得下游照着一份没验过的包发出去）。`,
    )
    process.exit(1)
  }
  const missing = missingEntries(names, required)
  if (missing.length) {
    console.error(
      `\n✗ 包内容自检不通过：zip 里少了 ${missing.length} 个该有的条目 —— ${missing.join('、')}` +
        `\n  zip：${zipPath}（共 ${names.length} 个条目）` +
        `\n  实际条目：\n${names.map((n) => `    - ${n}`).join('\n')}`,
    )
    process.exit(1)
  }
  console.log(`  ✓ 包内容自检：${required.length} 条该有的都在（zip 共 ${names.length} 个条目）`)

  const zipSha = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  const size = statSync(zipPath).size
  writeFileSync(`${zipPath}.sha256`, `${zipSha}  ${zipName}\n`, 'utf8')
  writeFileSync(
    join(outDir, 'catalog-entry.json'),
    JSON.stringify(
      {
        id: args.id,
        name: args.name,
        version,
        description: `FFmpeg ${version}（${license}）`,
        license,
        size,
        sha256: zipSha,
        downloadUrl: `https://example.invalid/plugins/${zipName}`,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  console.log(`✅ 分发包：${zipPath}（${(size / 1024 / 1024).toFixed(1)} MB）`)
  console.log(`   sha256：${zipSha}`)
  console.log(`   清单片段：${join(outDir, 'catalog-entry.json')}（记得把 downloadUrl 换成真实地址）`)
}

console.log('\n下一步：用户在「设置 → 视频 → FFmpeg → 导入插件包…」选中解压后的目录即可启用。')
