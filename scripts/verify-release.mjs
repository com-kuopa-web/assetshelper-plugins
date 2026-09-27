#!/usr/bin/env node
/**
 * **发布核对**：清单里写的 sha256/size，与**真的那份产物**是否一致。
 *
 * ## 为什么需要它
 *
 * `update-catalog.mjs` 是拿**本地那份 zip** 算 sha256 写进清单的 —— 它信任本地文件；
 * 而"上传到 Release 之后，用户下到的到底是不是同一份字节"**从来没人回读**。
 * 这类错误的后果很重：用户装到坏包/旧包，报错却指向别处（宿主只会说"校验不通过"）。
 *
 * ## 三种用法
 *
 * ```bash
 * # ① 离线：清单 vs 本地 zip（发布前在 CI 里跑；不联网、确定性）
 * node scripts/verify-release.mjs --dir dist-plugins
 *
 * # ② 在线：清单 vs Release 上**真的能下到的那份**（发布后手动跑，或接进 workflow 收尾）
 * node scripts/verify-release.mjs --url
 * node scripts/verify-release.mjs --url --repo com-kuopa-web/assets-plugins --tag ffmpeg-7.1.5
 *
 * # ③ 自检：用**故意篡改**的夹具证明"它真的抓得到"（负向对照；零网络）
 * node scripts/verify-release.mjs --self-test
 * ```
 *
 * ## 判据与"跳过"的口径（重要，否则会天天误报）
 *
 * | 情况 | 默认 | `--strict` |
 * |---|---|---|
 * | 清单条目在**本地/线上**找不到对应产物 | **跳过**并打印原因（清单里可能留着历史版本的条目） | 失败 |
 * | 目录里有 zip **不在**清单里 | 警告（列出来） | 失败 |
 * | sha256 或 size 不一致 | **失败** | 失败 |
 *
 * 退出码：`0` 通过（允许跳过/警告）｜`1` 有不一致或 --strict 下的违规｜`2` 用法错误。
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { get } from 'node:https'

const USAGE = `用法：verify-release.mjs [选项]

  --dir <path>    ① 离线核对：清单 vs 该目录里的 zip（发布前用）
  --url           ② 在线核对：逐个下载清单里的 downloadUrl 再核对（发布后用）
  --self-test     ③ 自检：造一份被篡改的夹具，断言**必须被抓到**（负向对照，零网络）
  --catalog <p>   清单路径（默认 plugin-catalog.json）
  --repo <owner/name>  仅用于报告（默认 com-kuopa-web/assets-plugins）
  --tag <tag>     仅用于报告：这次核对对应哪个 Release
  --only <id>     只核对某个 id（可重复、可逗号分隔）
  --strict        把"跳过/目录里有清单外的 zip"也当失败
  --json          只输出一行 JSON（CI 用）
  -h, --help      显示本帮助
`

function parseArgs(argv) {
  const o = { catalog: 'plugin-catalog.json', repo: 'com-kuopa-web/assets-plugins', only: [], strict: false, json: false, mode: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') { o.mode = 'dir'; o.dir = argv[++i] }
    else if (a === '--url') o.mode = 'url'
    else if (a === '--self-test') o.mode = 'self-test'
    else if (a === '--catalog') o.catalog = argv[++i]
    else if (a === '--repo') o.repo = argv[++i]
    else if (a === '--tag') o.tag = argv[++i]
    else if (a === '--only') o.only.push(...String(argv[++i]).split(',').filter(Boolean))
    else if (a === '--strict') o.strict = true
    else if (a === '--json') o.json = true
    else if (a === '-h' || a === '--help') o.help = true
    else throw new UsageError(`未知参数：${a}`)
  }
  if (!o.mode && !o.help) throw new UsageError('必须给一种模式：--dir / --url / --self-test')
  return o
}

class UsageError extends Error {}

/* ------------------------------------------------------------------ */
/* 核心判据（纯函数：便于自检直接断言它）                                */
/* ------------------------------------------------------------------ */

/**
 * 比对一条清单条目与"真的那份字节"的摘要。
 *
 * @returns 问题列表（空 = 一致）。**大小也判**：它比 sha256 更早、更便宜地暴露"发错文件了"。
 */
export function compareEntry(entry, actual) {
  const problems = []
  /*
   * ⚠️ 摘要要**同时给头与尾**：只截前 12 位时，"只改了最后一位"的篡改会显示成两个一模一样的串
   * （实测：`清单 43b95f2c29fb… / 实际 43b95f2c29fb…` —— 看着像误报，其实是真的不一致）。
   */
  const short = (s) => (typeof s === 'string' && s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-4)}` : String(s))
  if (actual.sha256 !== entry.sha256) {
    problems.push(`sha256 不一致：清单 ${short(entry.sha256)} / 实际 ${short(actual.sha256)}`)
  }
  if (typeof entry.size === 'number' && actual.size !== entry.size) {
    problems.push(`体积不一致：清单 ${entry.size} 字节 / 实际 ${actual.size} 字节`)
  }
  return problems
}

/** 清单条目的文件名（从 downloadUrl 取 basename —— 与下载到的资产名一致） */
export function fileNameOf(entry) {
  try {
    return basename(new URL(entry.downloadUrl).pathname)
  } catch {
    return basename(String(entry.downloadUrl))
  }
}

/* ------------------------------------------------------------------ */
/* 取字节 → 摘要                                                        */
/* ------------------------------------------------------------------ */

function sha256Stream(stream) {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    let size = 0
    stream.on('data', (c) => {
      h.update(c)
      size += c.length
    })
    stream.on('end', () => res({ sha256: h.digest('hex'), size }))
    stream.on('error', rej)
  })
}

async function digestOfFile(p) {
  return sha256Stream(createReadStream(p))
}

/** 下载并摘要（跟随重定向；GitHub Release 会 302 到 objects.githubusercontent.com） */
function digestOfUrl(url, redirectsLeft = 5) {
  return new Promise((res, rej) => {
    get(url, { headers: { 'user-agent': 'assets-plugins-verify-release' } }, (r) => {
      const code = r.statusCode ?? 0
      if (code >= 300 && code < 400 && r.headers.location) {
        r.resume()
        if (redirectsLeft <= 0) return rej(new Error('重定向次数过多'))
        const next = new URL(r.headers.location, url).href
        return digestOfUrl(next, redirectsLeft - 1).then(res, rej)
      }
      if (code !== 200) {
        r.resume()
        return rej(new Error(`HTTP ${code}`))
      }
      sha256Stream(r).then(res, rej)
    }).on('error', rej)
  })
}

/* ------------------------------------------------------------------ */
/* 两种模式                                                             */
/* ------------------------------------------------------------------ */

function loadCatalog(catalogPath) {
  const p = resolve(catalogPath)
  if (!existsSync(p)) throw new Error(`找不到清单：${p}`)
  const raw = JSON.parse(readFileSync(p, 'utf8'))
  const entries = Array.isArray(raw.plugins) ? raw.plugins : Array.isArray(raw.entries) ? raw.entries : []
  if (entries.length === 0) throw new Error(`清单里没有条目：${p}`)
  return { path: p, updatedAt: raw.updatedAt, entries }
}

const pick = (entries, only) => (only.length === 0 ? entries : entries.filter((e) => only.includes(e.id)))

async function runDir(catalogPath, dir, only, log) {
  const { entries } = loadCatalog(catalogPath)
  const targets = pick(entries, only)
  const rows = []
  const dirFiles = new Set(readdirSync(dir).filter((f) => f.endsWith('.zip')))

  for (const e of targets) {
    const name = fileNameOf(e)
    const p = join(dir, name)
    if (!dirFiles.has(name)) {
      rows.push({ id: e.id, version: e.version, platform: e.platform, arch: e.arch, file: name, status: 'skipped', note: '本地没有这份产物（清单里可能是历史版本的条目）' })
      continue
    }
    const actual = await digestOfFile(p)
    const problems = compareEntry(e, actual)
    rows.push({ id: e.id, version: e.version, platform: e.platform, arch: e.arch, file: name, status: problems.length ? 'mismatch' : 'ok', problems, sha256: actual.sha256, size: actual.size })
  }

  // 目录里有、清单里没有 → 警告（可能是没发布的产物）
  const known = new Set(entries.map(fileNameOf))
  const extras = [...dirFiles].filter((f) => !known.has(f))
  return { rows, extras, catalogPath }
}

async function runUrl(catalogPath, only, log) {
  const { entries } = loadCatalog(catalogPath)
  const targets = pick(entries, only)
  const rows = []
  for (const e of targets) {
    const url = e.downloadUrl
    log(`  下载 ${e.id}@${e.version} (${e.platform}/${e.arch}) …`)
    try {
      const actual = await digestOfUrl(url)
      const problems = compareEntry(e, actual)
      rows.push({ id: e.id, version: e.version, platform: e.platform, arch: e.arch, file: fileNameOf(e), url, status: problems.length ? 'mismatch' : 'ok', problems, sha256: actual.sha256, size: actual.size })
    } catch (err) {
      rows.push({ id: e.id, version: e.version, platform: e.platform, arch: e.arch, file: fileNameOf(e), url, status: 'skipped', note: `取不到：${err instanceof Error ? err.message : String(err)}` })
    }
  }
  return { rows, extras: [], catalogPath }
}

/* ------------------------------------------------------------------ */
/* 自检（负向对照）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 造一份**故意篡改**的夹具，断言"必须被抓到"。
 *
 * 为什么自检里必须包含"篡改的那条"：否则这个脚本自己也可能是个**永远绿的假断言**
 * （见 `notes/术语与编号/测试与验证术语.md` §2）。零网络，CI 里可以随便跑。
 */
async function selfTest() {
  const work = mkdtempSync(join(tmpdir(), 'verify-release-selftest-'))
  const problems = []
  try {
    const dir = join(work, 'dist')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })

    const good = Buffer.from('PK\x03\x04 这是一份"好"的产物（内容无所谓，判据是摘要）')
    const tampered = Buffer.from('PK\x03\x04 这份被篡改过 —— 与清单里的 sha256 对不上')
    writeFileSync(join(dir, 'demo.good-1.0.0.zip'), good)
    writeFileSync(join(dir, 'demo.bad-1.0.0.zip'), tampered)

    const sha = (b) => createHash('sha256').update(b).digest('hex')
    const catalog = {
      schema: 1,
      updatedAt: new Date().toISOString(),
      plugins: [
        { id: 'demo.good', version: '1.0.0', platform: 'darwin', arch: 'arm64', size: good.length, sha256: sha(good), downloadUrl: 'https://example.invalid/demo.good-1.0.0.zip' },
        // ⚠️ 故意写错 sha256（改一位）—— 这一条**必须**被报出来
        { id: 'demo.bad', version: '1.0.0', platform: 'linux', arch: 'x64', size: tampered.length, sha256: `${sha(tampered).slice(0, -1)}${sha(tampered).endsWith('0') ? '1' : '0'}`, downloadUrl: 'https://example.invalid/demo.bad-1.0.0.zip' },
      ],
    }
    const catalogPath = join(work, 'plugin-catalog.json')
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))

    const { rows } = await runDir(catalogPath, dir, [], () => {})
    const goodRow = rows.find((r) => r.id === 'demo.good')
    const badRow = rows.find((r) => r.id === 'demo.bad')

    if (goodRow?.status !== 'ok') problems.push(`未篡改的那条本应通过，实际 ${goodRow?.status}：${(goodRow?.problems ?? []).join('；')}`)
    if (badRow?.status !== 'mismatch') problems.push(`★ 被篡改的那条**没有被抓到**（status=${badRow?.status}）—— 说明这个脚本是个假断言`)
    if (badRow?.status === 'mismatch' && !(badRow.problems ?? []).some((p) => p.includes('sha256'))) problems.push('抓到了，但没有指出是 sha256 不一致')

    // 再验"体积不一致也判"（只改 size）
    const catalog2 = JSON.parse(JSON.stringify(catalog))
    catalog2.plugins[0].size = good.length + 1
    writeFileSync(catalogPath, JSON.stringify(catalog2, null, 2))
    const r2 = await runDir(catalogPath, dir, [], () => {})
    if (r2.rows.find((r) => r.id === 'demo.good')?.status !== 'mismatch') problems.push('体积不一致没有被判出来')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return problems
}

/* ------------------------------------------------------------------ */

async function main() {
  let o
  try {
    o = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    console.error(USAGE)
    process.exit(2)
  }
  if (o.help) return console.log(USAGE)

  const log = o.json ? () => {} : (m) => console.log(m)

  if (o.mode === 'self-test') {
    const problems = await selfTest()
    if (o.json) console.log(JSON.stringify({ mode: 'self-test', ok: problems.length === 0, problems }))
    else {
      console.log('自检（负向对照）：夹具里有一条被篡改的产物，必须被抓到\n')
      for (const p of problems) console.log(`  ❌ ${p}`)
      console.log(problems.length === 0 ? '  ✅ 篡改被抓到、正常的那条通过、体积不一致也判得出' : '')
    }
    process.exit(problems.length === 0 ? 0 : 1)
  }

  const result = o.mode === 'dir' ? await runDir(o.catalog, resolve(o.dir), o.only, log) : await runUrl(o.catalog, o.only, log)
  const { rows, extras } = result
  const mismatched = rows.filter((r) => r.status === 'mismatch')
  const skipped = rows.filter((r) => r.status === 'skipped')

  if (o.json) {
    console.log(JSON.stringify({ mode: o.mode, catalog: result.catalogPath, repo: o.repo, tag: o.tag ?? null, rows, extras, mismatched: mismatched.length, skipped: skipped.length }))
    process.exit(mismatched.length > 0 || (o.strict && (skipped.length > 0 || extras.length > 0)) ? 1 : 0)
  }

  console.log(`发布核对（模式：${o.mode === 'dir' ? `离线目录 ${resolve(o.dir)}` : '在线下载'}）`)
  console.log(`清单：${result.catalogPath}${result.updatedAt ? `（updatedAt ${result.updatedAt}）` : ''}${o.tag ? ` ｜ Release：${o.repo}@${o.tag}` : ''}\n`)
  for (const r of rows) {
    const tag = r.status === 'ok' ? '✅' : r.status === 'mismatch' ? '❌' : '⏭'
    console.log(`  ${tag} ${r.id}@${r.version} (${r.platform}/${r.arch}) ${r.file}`)
    for (const p of r.problems ?? []) console.log(`       · ${p}`)
    if (r.note) console.log(`       · ${r.note}`)
  }
  if (extras.length > 0) {
    console.log(`\n  ⚠️ 目录里有 ${extras.length} 个 zip 不在清单里（没有发布？）：${extras.join('、')}`)
  }
  console.log(`\n结果：一致 ${rows.length - mismatched.length - skipped.length} ｜ 不一致 ${mismatched.length} ｜ 跳过 ${skipped.length}`)
  if (mismatched.length > 0) {
    console.log('  ❌ 清单与产物的字节对不上 —— 修清单或重发资产，别就这么发出去。')
    if (o.mode === 'dir') {
      console.log(
        '  ℹ️ 注意：`--dir` 比的是**本地目录里的那份**。若清单来自 CI 发布、而本地是另一次构建，\n' +
          '     两者本来就不该相同 —— 这个模式用在"刚构建完、还没上传"那一步（CI 里就是如此）。',
      )
    }
    process.exit(1)
  }
  if (o.strict && (skipped.length > 0 || extras.length > 0)) {
    console.log('  ❌ --strict：跳过/清单外的 zip 也算失败。')
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-release.mjs')) {
  main().catch((e) => {
    console.error(`\n✗ 核对失败：${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
