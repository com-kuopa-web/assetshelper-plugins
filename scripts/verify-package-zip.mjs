#!/usr/bin/env node
// ⚠️ 本文件是从主仓库 `AssetsHelper/scripts/verify-package-zip.mjs` 复制来的（vendor）。
//    要改就改主副本再复制回来，避免两边漂移。
/**
 * **包内容断言**：这个 zip 里，到底有没有"该有的那些文件"？
 *
 * ## 为什么需要它
 *
 * `build-ffmpeg-plugin.mjs` 会先组装一个目录、再压成 zip，然后写下 `sha256` 与清单片段。
 * 这条链上有个**无人核对**的缝：校验和算的是 `zip` 这个文件本身，**它里面装了什么没人看**。
 * 于是下面这些事都能"绿着"发生：
 *
 *   · `ENABLE_QSV=1` 的 Windows 包**漏了 oneVPL 的 DLL** → 用户端 ffmpeg 起不来
 *     （`0xc0000135`），而宿主只会说"FFmpeg 无法执行"，报错点离真因极远；
 *   · 许可证原文没进包 → 分发出去的包**不合规**；
 *   · `manifest.json` / `build-info.json` 没进包 → 插件装了也不显示合规材料。
 *
 * 所以：**压完必须回读一遍 zip，逐条核对**。
 *
 * ## 为什么自己解 zip 而不调 `unzip`
 *
 * 打包脚本跑在三种环境里（macOS / Linux / Windows 的 pwsh）——Windows 那个步骤**看不到
 * MSYS2 的 PATH**，`unzip` 不一定在，`powershell Expand-Archive` 又要解到临时目录。
 * 中央目录的格式很稳定，直接读就够了：**没有外部依赖，三平台同一份逻辑**。
 *
 * ## 口径（宁可失败，不要"没验而成"）
 *
 * · 读不出中央目录（不是 zip / 截断）→ **失败**；
 * · 遇到 zip64（条目数或体积超过 4 GB 的容器）→ **失败**并说明"本脚本没法逐个核对"——
 *   绝不当成"通过"。我们的包是十几 MB、十几个条目，永远不会走到这条；
 *   真走到了（说明打包方式被换了），该停下来看一眼，而不是静默放行。
 *
 * ## 用法
 *
 *   # 命令行：核对某个 zip 里必须有这些条目
 *   node scripts/verify-package-zip.mjs --zip dist-plugins/official.ffmpeg-7.1.5.zip \
 *        --require manifest.json --require bin/ffmpeg --require bin/libvpl-2.dll
 *
 *   # 列表（排查用）
 *   node scripts/verify-package-zip.mjs --zip /path/to.zip --list
 *
 * 也可当模块用（`build-ffmpeg-plugin.mjs` 就是这么用的）：
 *   import { listZipNames, missingEntries } from './verify-package-zip.mjs'
 *
 * 退出码：0 = 该有的都在；1 = 缺条目；2 = 用法错/zip 读不出来（无法判定）。
 */

import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50

/** zip64 相关：这些字段填全 1 表示"真值在 zip64 扩展里"，本脚本不解析扩展 */
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

function zip64(message) {
  const e = new Error(message)
  e.code = 'ZIP64'
  return e
}

/**
 * zip 里的条目名规范化。
 *
 * ⚠️ Windows 的 `Compress-Archive` 历史上会写出**反斜杠**分隔的条目名
 * （`pkg\bin\ffmpeg.exe`），不规范化的话"文件明明在，断言却说不在"——
 * 这正是那种会让人把守卫关掉的假报警。
 */
export function normalizeZipName(name) {
  return String(name).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '')
}

/**
 * 读出 zip **中央目录**里的全部条目名（含目录条目）。
 *
 * 只读中央目录（不碰局部文件头/压缩数据）：条目名在那里是**明文**的，
 * 不需要解压、不需要 zlib，也不会因为条目是压缩的还是存储的而行为不同。
 */
export function listZipNames(zipPath) {
  const st = statSync(zipPath)
  if (!st.isFile()) throw new Error(`不是文件：${zipPath}`)
  const buf = readFileSync(zipPath)
  if (buf.length < 22) throw new Error(`太小，不可能是 zip（${buf.length} 字节）：${zipPath}`)

  // 从尾部往回找 EOCD（它后面最多还跟 65535 字节的注释，注释里也可能出现这个签名，
  // 所以**从后往前**找到的第一个才是真的）
  let eocd = -1
  const stop = Math.max(0, buf.length - 22 - U16_MAX)
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`找不到中央目录结尾记录（不是 zip，或文件被截断）：${zipPath}`)

  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOff = buf.readUInt32LE(eocd + 16)
  if (count === U16_MAX || cdSize === U32_MAX || cdOff === U32_MAX) {
    throw zip64(`这份 zip 用了 zip64（条目数/${cdOff} 超出 32 位字段）：本脚本没法逐个核对，按"验不了"处理`)
  }
  if (cdOff + cdSize > buf.length) {
    throw new Error(`中央目录越界（偏移 ${cdOff} + 长度 ${cdSize} > 文件 ${buf.length} 字节）：文件损坏或被截断`)
  }

  const names = []
  let p = cdOff
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`第 ${i + 1} 条中央目录记录签名不对（偏移 ${p}）：文件损坏`)
    }
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    if (compSize === U32_MAX || rawSize === U32_MAX || nameLen === U16_MAX) {
      throw zip64(`第 ${i + 1} 条条目的体积字段用了 zip64：本脚本没法逐个核对，按"验不了"处理`)
    }
    if (p + 46 + nameLen > buf.length) throw new Error(`第 ${i + 1} 条条目名越界：文件损坏`)
    names.push(normalizeZipName(buf.toString('utf8', p + 46, p + 46 + nameLen)))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/**
 * `required` 里哪些**不在** `names` 里。
 *
 * 匹配规则：**先精确相等，再"以 `/` + 需求名结尾"**。
 * 后者是为了兼容两种传法 —— 传 `bin/ffmpeg`（不带顶层目录）或
 * `official.ffmpeg-7.1.5/bin/ffmpeg`（带），两种都该能对上。
 */
export function missingEntries(names, required) {
  const have = new Set(names.map(normalizeZipName))
  const missing = []
  for (const raw of required) {
    const want = normalizeZipName(raw)
    if (!want) continue
    if (have.has(want)) continue
    let found = false
    for (const h of have) {
      if (h.endsWith('/' + want)) {
        found = true
        break
      }
    }
    if (!found) missing.push(want)
  }
  return missing
}

/* ---------------- 命令行 ---------------- */
function parseArgv(argv) {
  const out = { zip: null, require: [], list: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--zip') out.zip = argv[++i]
    else if (a === '--require') out.require.push(...String(argv[++i]).split(','))
    else if (a === '--list') out.list = true
    else if (a === '--json') out.json = true
    else if (a === '-h' || a === '--help') out.help = true
    else {
      console.error(`未知参数：${a}`)
      process.exit(2)
    }
  }
  return out
}

const USAGE = `用法：verify-package-zip.mjs --zip <path> [--require <条目>]... [--list] [--json]

  --zip <path>      要核对的 zip
  --require <条目>  必须有这个条目（可重复、可逗号分隔）。可写 \`bin/ffmpeg\`
                    或带顶层目录的 \`official.ffmpeg-7.1.5/bin/ffmpeg\`，两种都认。
  --list            只列出 zip 里的条目（排查用，不判定）
  --json            只输出一行 JSON
  -h, --help        显示本帮助

退出码：0 = 该有的都在；1 = 缺条目；2 = 用法错 / zip 读不出来（无法判定）`

// 只有**直接执行**时才走命令行；被 `import` 时（build-ffmpeg-plugin.mjs 就是这么用的）不执行。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = parseArgv(process.argv.slice(2))
  if (args.help || !args.zip) {
    console.log(USAGE)
    process.exit(args.help ? 0 : 2)
  }
  let names
  try {
    names = listZipNames(args.zip)
  } catch (e) {
    if (args.json) console.log(JSON.stringify({ ok: false, undecidable: true, zip: args.zip, error: String(e.message) }))
    else console.error(`✗ 无法核对 ${args.zip}：${e.message}`)
    process.exit(2)
  }
  if (args.list) {
    if (args.json) console.log(JSON.stringify({ ok: true, zip: args.zip, names }))
    else for (const n of names) console.log(n)
    process.exit(0)
  }
  const missing = missingEntries(names, args.require)
  if (args.json) {
    console.log(JSON.stringify({ ok: missing.length === 0, zip: args.zip, entries: names.length, missing }))
  } else if (missing.length === 0) {
    console.log(`✅ ${args.zip}：共 ${names.length} 个条目，要求的 ${args.require.length} 条都在`)
  } else {
    console.error(`✗ ${args.zip}：少了 ${missing.length} 个该有的条目`)
    for (const m of missing) console.error(`    · ${m}`)
    console.error(`  包内实际条目（${names.length}）：`)
    for (const n of names) console.error(`    - ${n}`)
  }
  process.exit(missing.length === 0 ? 0 : 1)
}
