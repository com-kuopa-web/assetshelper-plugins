#!/usr/bin/env node
/**
 * **把官方插件发布到 `assetshelper-plugins` 的分发通道**（Release 附件 + 更新清单）。
 *
 * ## 为什么是"显式选择器"
 *
 * 发布是不可逆的对外动作（用户的应用会照着清单去下载）。所以本脚本**不接受"什么都不给"** ——
 * 必须显式说清楚发什么：`--only` / `--group` / `--all` 三选一。少给一个参数就报错，
 * 而不是默默发全部。
 *
 * ## 用法
 *
 * ```bash
 * # 只发一个
 * node scripts/publish-plugins.mjs --dir ../../AssetsHelper/dist-plugins --only official.model \
 *   --tag plugins-1.0.0 --dry-run
 * # 发多个（逗号分隔，或重复给 --only）
 * node scripts/publish-plugins.mjs --dir … --only official.image,official.audio
 * # 按组：core = 图片/音频/视频（多数人够用）；optional = 模型（按需下载）
 * node scripts/publish-plugins.mjs --dir … --group core
 * # 全部（= dist-plugins 里发现到的所有官方插件）
 * node scripts/publish-plugins.mjs --dir … --all
 * ```
 *
 * | 选项 | 说明 |
 * |---|---|
 * | `--tag <tag>` | Release tag（上传时必填，如 `plugins-1.0.0`）。`--no-upload` 时可省 |
 * | `--repo <owner/name>` | 默认 `com-kuopa-web/assets-plugins` |
 * | `--catalog <file>` | 默认 `plugin-catalog.json`（相对本仓库根） |
 * | `--dry-run` | 只打印：要传哪些文件、清单会怎么变。**不联网、不写文件** |
 * | `--no-upload` | 不建/不传 Release，只更新清单（适合"附件已手传"或网络受限） |
 * | `--clobber` | 允许覆盖 Release 上已存在的同名附件 |
 * | `--commit` | 更新清单后顺带 `git add/commit`（默认只改文件并打印命令） |
 * | `--self-test` | 造临时夹具自证"这套检查能红"（未知 id / 组缺员 / 幂等 / 不误删 ffmpeg 条目…） |
 *
 * ## 它怎么算清单条目
 *
 * 条目**从包内 `manifest.json` 生成**，而不是从 `build-plugins.mjs` 的 `catalog-entry.*.json` 片段 ——
 * 后者缺 `kind` / `official`（AC4 判断"是不是界面插件""是不是官方"要用），且 `downloadUrl` 是
 * `example.invalid` 占位。包内清单是**随包发布的那一份**，字段齐全，是真正的权威。
 *
 * ## 上传走 REST API 而不是 `gh`
 *
 * 本机不一定装了 `gh`（实测就没有）→ 用 Node 自带的 `fetch` 打 GitHub API：
 * 建/查 Release →（必要时覆盖）上传附件。CI 里用默认的 `GITHUB_TOKEN`（`contents: write`）即可，
 * 不需要额外 PAT —— 因为 Release 建在**本仓库**里。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_REPO = 'com-kuopa-web/assets-plugins'

/**
 * **预设组**（产品语义，改这里即可）：
 *   · `core`     —— 多数人够用的基础三件套（图片 / 音频 / 视频）
 *   · `optional` —— 按需下载（3D 模型体积大，不是所有人都要）
 * 清单里的 `official.filelist` 是**本体内置的兜底视图**（不属于本仓库/不发布）。
 */
const GROUPS = {
  core: ['official.image', 'official.audio', 'official.video'],
  optional: ['official.model'],
}

/**
 * **宿主自有**的插件 id：随包预置、不可停用/不可卸载（见 AssetsHelper 的 `src/shared/plugin-policy.ts`）。
 * 它们**不需要发布** —— 用户的安装包里一定有；`--all` 会把它们排除（真要发用 `--only official.filelist`）。
 * 放在清单里反而会造成困惑："这个条目为什么永远装不了/装了也没用"。
 */
const HOST_OWNED = ['official.filelist']

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { only: [], group: null, all: false, dir: null, tag: null, repo: DEFAULT_REPO, catalog: 'plugin-catalog.json', dryRun: false, noUpload: false, clobber: false, commit: false, selfTest: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--only': out.only.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)); break
      case '--group': out.group = argv[++i]; break
      case '--all': out.all = true; break
      case '--dir': out.dir = argv[++i]; break
      case '--tag': out.tag = argv[++i]; break
      case '--repo': out.repo = argv[++i]; break
      case '--catalog': out.catalog = argv[++i]; break
      case '--dry-run': out.dryRun = true; break
      case '--no-upload': out.noUpload = true; break
      case '--clobber': out.clobber = true; break
      case '--commit': out.commit = true; break
      case '--self-test': out.selfTest = true; break
      case '-h':
      case '--help': out.help = true; break
      default:
        console.error(`未知参数：${a}（--help 看用法）`)
        process.exit(2)
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 发现可用包（dist-plugins/<id>/<version>/ + <id>-<version>.zip）        */
/* ------------------------------------------------------------------ */

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 扫描构建产物目录，返回 `{ id → { id, version, dir, manifest, zip, size, sha256 } }`。
 * 每个 id 取**版本最高的那个**（字符串比较足够：semver 同段位时字典序一致）。
 */
export function discoverPackages(dir) {
  const found = new Map()
  if (!existsSync(dir)) return found
  for (const id of readdirSync(dir, { withFileTypes: true })) {
    if (!id.isDirectory() || !id.name.startsWith('official.')) continue
    const idDir = join(dir, id.name)
    for (const v of readdirSync(idDir, { withFileTypes: true })) {
      if (!v.isDirectory() || v.name.endsWith('.tmp')) continue
      const manifestFile = join(idDir, v.name, 'manifest.json')
      if (!existsSync(manifestFile)) continue
      const zip = join(dir, `${id.name}-${v.name}.zip`)
      if (!existsSync(zip)) continue // 没有 zip 就没法发布（附件就是 zip）
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
      const prev = found.get(id.name)
      if (prev && prev.version >= v.name) continue
      // sha256 优先用构建时算好的 `.sha256`（就是 zip 的哈希），没有才现算
      const shaFile = `${zip}.sha256`
      const sha256 = existsSync(shaFile)
        ? readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0]
        : sha256File(zip)
      found.set(id.name, { id: id.name, version: v.name, dir: join(idDir, v.name), manifest, zip, size: statSync(zip).size, sha256 })
    }
  }
  return found
}

/** 由包内 manifest + zip 生成一条清单条目（renderer 插件无 platform/arch；有则带上） */
export function buildEntry(pkg, { repo, tag }) {
  const m = pkg.manifest
  const entry = {
    id: pkg.id,
    ...(m.name ? { name: m.name } : {}),
    version: pkg.version,
    ...(m.description ? { description: m.description } : {}),
    ...(m.license ? { license: m.license } : {}),
    // 界面插件用 kind/assetKind；capability-provider（如 ffmpeg）用 platform/arch
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.assetKind ? { assetKind: m.assetKind } : {}),
    ...(m.platform ? { platform: m.platform } : {}),
    ...(m.arch ? { arch: m.arch } : {}),
    ...(m.official === true ? { official: true } : {}),
    size: pkg.size,
    sha256: pkg.sha256,
    downloadUrl: `https://github.com/${repo}/releases/download/${tag}/${pkg.zip.split('/').pop()}`,
    mirrors: [],
  }
  return entry
}

/** 幂等合并：同 `(id, version)` 的旧条目被替换，其它条目（如 ffmpeg 的 4 条）原样保留 */
export function mergeCatalog(catalog, entries) {
  const key = (e) => `${e.id}@${e.version}`
  const incoming = new Map(entries.map((e) => [key(e), e]))
  const kept = (catalog.plugins ?? []).filter((e) => !incoming.has(key(e)))
  const replaced = (catalog.plugins ?? []).filter((e) => incoming.has(key(e))).length
  return {
    next: { ...catalog, schema: catalog.schema ?? 1, updatedAt: new Date().toISOString(), plugins: [...kept, ...entries].sort((a, b) => (a.id === b.id ? (a.version < b.version ? 1 : -1) : a.id < b.id ? -1 : 1)) },
    replaced,
    added: entries.length - replaced,
  }
}

/* ------------------------------------------------------------------ */
/* 选择器解析（--only / --group / --all 三选一）                         */
/* ------------------------------------------------------------------ */

export function resolveSelection(args, available) {
  const selectors = [args.all ? '--all' : null, args.group ? '--group' : null, args.only.length ? '--only' : null].filter(Boolean)
  if (selectors.length === 0) throw new Error('必须显式指定要发什么：--only <id[,id]> / --group <core|optional> / --all（不接受"什么都不给"）')
  if (selectors.length > 1) throw new Error(`选择器只能给一个，收到：${selectors.join(' + ')}`)

  let ids
  let excluded = []
  if (args.all) {
    const all = [...available.keys()].sort()
    ids = all.filter((id) => !HOST_OWNED.includes(id))
    excluded = all.filter((id) => HOST_OWNED.includes(id))
    if (ids.length === 0) throw new Error(`--all 排除宿主自有插件（${excluded.join(', ')}）后没有可发布的了；要发它们请显式写 --only <id>`)
  } else if (args.group) {
    const members = GROUPS[args.group]
    if (!members) throw new Error(`未知的组：${args.group}（可用：${Object.keys(GROUPS).join(' / ')}）`)
    const missing = members.filter((id) => !available.has(id))
    // 组是"产品承诺"：core 缺员说明构建产物不全，必须报错而不是静默少发
    if (missing.length) throw new Error(`组 ${args.group} 里有插件没有构建产物：${missing.join(', ')}（先跑 yarn plugin:build）`)
    ids = members.filter((id) => available.has(id))
  } else {
    const unknown = args.only.filter((id) => !available.has(id))
    if (unknown.length) throw new Error(`没有这些插件的构建产物：${unknown.join(', ')}（可用：${[...available.keys()].sort().join(', ')}）`)
    ids = args.only
  }
  if (ids.length === 0) throw new Error('选择结果为空')
  return { ids, excluded }
}

/* ------------------------------------------------------------------ */
/* 上传（GitHub REST API，不依赖 gh）                                    */
/* ------------------------------------------------------------------ */

async function ghApi(method, path, { token, body, extraHeaders = {} } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'assetshelper-plugins-publish',
      ...extraHeaders,
    },
    ...(body ? { body } : {}),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON（如 204） */ }
  return { ok: res.ok, status: res.status, json, text }
}

async function ensureRelease({ repo, tag, token }) {
  const existing = await ghApi('GET', `/repos/${repo}/releases/tags/${tag}`, { token })
  if (existing.ok) return existing.json
  if (existing.status !== 404) throw new Error(`查询 Release 失败（HTTP ${existing.status}）：${existing.text.slice(0, 200)}`)
  const created = await ghApi('POST', `/repos/${repo}/releases`, {
    token,
    body: JSON.stringify({ tag_name: tag, name: tag, body: `官方插件包（${tag}）。由 assetshelper-plugins 的 publish-plugins 脚本上传。`, draft: false, prerelease: false }),
    extraHeaders: { 'Content-Type': 'application/json' },
  })
  if (!created.ok) throw new Error(`创建 Release 失败（HTTP ${created.status}）：${created.text.slice(0, 200)}`)
  return created.json
}

async function uploadAsset({ repo, releaseId, file, token, clobber }) {
  const name = file.split('/').pop()
  const listed = await ghApi('GET', `/repos/${repo}/releases/${releaseId}/assets?per_page=100`, { token })
  const dup = listed.ok ? (listed.json ?? []).find((a) => a.name === name) : null
  if (dup && !clobber) throw new Error(`Release 上已存在同名附件 ${name}（要覆盖请加 --clobber）`)
  if (dup && clobber) {
    const del = await ghApi('DELETE', `/repos/${repo}/releases/assets/${dup.id}`, { token })
    if (!del.ok) throw new Error(`删除旧附件失败（HTTP ${del.status}）`)
  }
  const res = await fetch(`https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'User-Agent': 'assetshelper-plugins-publish',
    },
    body: readFileSync(file),
  })
  if (!res.ok) throw new Error(`上传 ${name} 失败（HTTP ${res.status}）：${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/* ------------------------------------------------------------------ */
/* 自检：证明"这套检查能红"                                             */
/* ------------------------------------------------------------------ */

function selfTest() {
  const work = mkdtempSync(join(tmpdir(), 'publish-selftest-'))
  const dist = join(work, 'dist-plugins')
  const makePkg = (id, version, manifestExtra = {}) => {
    mkdirSync(join(dist, id, version), { recursive: true })
    writeFileSync(join(dist, id, version, 'index.js'), '// built\n')
    writeFileSync(join(dist, id, version, 'manifest.json'), JSON.stringify({
      id, name: id, version, description: 'd', kind: 'renderer-plugin', assetKind: 'image', official: true, ...manifestExtra,
    }))
    const zip = join(dist, `${id}-${version}.zip`)
    writeFileSync(zip, `zip-bytes-${id}`)
    writeFileSync(`${zip}.sha256`, `${sha256File(zip)}  ${id}-${version}.zip\n`)
  }
  makePkg('official.image', '1.0.0')
  makePkg('official.audio', '1.0.0')
  makePkg('official.model', '1.0.0')
  makePkg('official.filelist', '1.0.0') // 宿主自有：--all 应排除它、但 --only 仍可显式发
  const catalogFile = join(work, 'plugin-catalog.json')
  writeFileSync(catalogFile, JSON.stringify({ schema: 1, updatedAt: 'x', plugins: [{ id: 'official.ffmpeg', version: '7.1.5', platform: 'darwin', arch: 'arm64' }] }, null, 2))

  const available = discoverPackages(dist)
  const cases = []
  const expect = (label, fn, wantThrow) => {
    try { fn(); cases.push({ label, ok: !wantThrow, detail: wantThrow ? '期望报错但通过了' : '' }) }
    catch (e) { cases.push({ label, ok: wantThrow, detail: e.message }) }
  }

  expect('无选择器 → 报错', () => resolveSelection(parseArgs([]), available), true)
  expect('选择器给两个 → 报错', () => resolveSelection(parseArgs(['--all', '--only', 'official.image']), available), true)
  expect('未知 id → 报错', () => resolveSelection(parseArgs(['--only', 'official.nope']), available), true)
  expect('未知组 → 报错', () => resolveSelection(parseArgs(['--group', 'nope']), available), true)
  expect('core 组缺员（本地没有 official.video）→ 报错', () => resolveSelection(parseArgs(['--group', 'core']), available), true)
  expect('--only 一个 → 通过', () => resolveSelection(parseArgs(['--only', 'official.model']), available), false)
  expect('--only 多个 → 通过', () => resolveSelection(parseArgs(['--only', 'official.image,official.audio']), available), false)
  expect('--group optional → 通过', () => resolveSelection(parseArgs(['--group', 'optional']), available), false)
  expect('--all → 通过', () => resolveSelection(parseArgs(['--all']), available), false)

  // 宿主自有的插件（filelist）：--all 排除它，但仍可显式发
  const allSel = resolveSelection(parseArgs(['--all']), available)
  cases.push({
    label: '--all 排除宿主自有的 official.filelist',
    ok: !allSel.ids.includes('official.filelist') && allSel.excluded.includes('official.filelist'),
    detail: JSON.stringify(allSel),
  })
  cases.push({
    label: '--only official.filelist 仍可显式发',
    ok: resolveSelection(parseArgs(['--only', 'official.filelist']), available).ids.join() === 'official.filelist',
  })
  expect(
    '只有宿主自有插件时 --all → 报错（别发空清单）',
    () => resolveSelection(parseArgs(['--all']), new Map([['official.filelist', available.get('official.filelist')]])),
    true,
  )

  // 条目字段 + 幂等 + 不误删既有条目
  const ids = resolveSelection(parseArgs(['--only', 'official.image']), available).ids
  const entry = buildEntry(available.get(ids[0]), { repo: 'o/r', tag: 'plugins-1.0.0' })
  cases.push({ label: '条目带 kind/assetKind/official', ok: entry.kind === 'renderer-plugin' && entry.assetKind === 'image' && entry.official === true, detail: JSON.stringify(entry) })
  cases.push({ label: '条目 downloadUrl 指向 Release 附件', ok: entry.downloadUrl === 'https://github.com/o/r/releases/download/plugins-1.0.0/official.image-1.0.0.zip', detail: entry.downloadUrl })
  cases.push({ label: '条目 sha256/size 来自构建产物', ok: /^[0-9a-f]{64}$/.test(entry.sha256) && entry.size > 0, detail: `${entry.sha256} ${entry.size}` })

  const base = JSON.parse(readFileSync(catalogFile, 'utf8'))
  const m1 = mergeCatalog(base, [entry])
  cases.push({ label: '合并保留既有 ffmpeg 条目', ok: m1.next.plugins.some((e) => e.id === 'official.ffmpeg'), detail: JSON.stringify(m1.next.plugins.map((e) => e.id)) })
  cases.push({ label: '首次合并算作新增', ok: m1.added === 1 && m1.replaced === 0, detail: JSON.stringify(m1) })
  const m2 = mergeCatalog(m1.next, [buildEntry(available.get('official.image'), { repo: 'o/r', tag: 'plugins-1.0.1' })])
  cases.push({ label: '同 id+version 再发 → 替换而非重复', ok: m2.replaced === 1 && m2.next.plugins.filter((e) => e.id === 'official.image').length === 1, detail: JSON.stringify(m2.next.plugins.map((e) => `${e.id}@${e.version}`)) })
  cases.push({ label: '替换后 downloadUrl 用新 tag', ok: m2.next.plugins.find((e) => e.id === 'official.image').downloadUrl.includes('plugins-1.0.1') })
  const pkg2 = { ...available.get('official.image'), version: '2.0.0' }
  const m3 = mergeCatalog(m1.next, [buildEntry(pkg2, { repo: 'o/r', tag: 't' })])
  cases.push({
    label: '同名不同版本 → 两条并存（不误删旧版本条目）',
    ok: m3.next.plugins.filter((e) => e.id === 'official.image').map((e) => e.version).sort().join(',') === '1.0.0,2.0.0',
    detail: JSON.stringify(m3.next.plugins.map((e) => `${e.id}@${e.version}`)),
  })

  rmSync(work, { recursive: true, force: true })
  return cases
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''))
  process.exit(0)
}

if (args.selfTest) {
  const cases = selfTest()
  let failed = 0
  console.log('发布脚本自检（这套检查必须能红）\n')
  for (const c of cases) {
    if (c.ok) console.log(`  ✅ ${c.label}`)
    else { failed++; console.log(`  ❌ ${c.label}${c.detail ? `\n        ${c.detail}` : ''}`) }
  }
  console.log(`\n结果：${cases.length - failed} 通过 / ${failed} 失败`)
  process.exit(failed ? 1 : 0)
}

if (!args.dir) {
  console.error('缺少 --dir <构建产物目录>（通常是 ../../AssetsHelper/dist-plugins）')
  process.exit(2)
}

try {
  const dist = resolve(args.dir)
  const available = discoverPackages(dist)
  if (available.size === 0) {
    console.error(`✗ 在 ${dist} 里没发现任何可发布的官方插件（需要 <id>/<version>/manifest.json + <id>-<version>.zip）`)
    process.exit(1)
  }
  const { ids, excluded } = resolveSelection(args, available)
  // 清单里的 downloadUrl 必须是**真实可下载的地址** → 只要不是 dry-run，就必须给 tag
  if (!args.dryRun && !args.tag) {
    console.error('✗ 需要 --tag <tag>（如 plugins-1.0.0）：清单里的 downloadUrl 指向它；只想看计划请加 --dry-run')
    process.exit(2)
  }
  const tag = args.tag ?? 'plugins-<tag>'
  const entries = ids.map((id) => buildEntry(available.get(id), { repo: args.repo, tag }))

  console.log(`\n发布官方插件 → ${args.repo}`)
  console.log(`  产物目录  ${dist}`)
  console.log(`  选择      ${ids.join(', ')}（共 ${ids.length} 个）`)
  if (excluded.length) {
    console.log(`  已排除    ${excluded.join(', ')}（宿主自有 / 随包预置，不需要发布；真要发请用 --only）`)
  }
  console.log(`  Release   ${args.tag ?? '(未指定，仅更新清单)'}`)
  console.log(`  模式      ${args.dryRun ? 'dry-run（不联网、不写文件）' : args.noUpload ? '仅更新清单' : '上传附件 + 更新清单'}\n`)
  for (const e of entries) {
    console.log(`  · ${e.id}@${e.version}  ${(e.size / 1024).toFixed(1)} KB  sha256=${e.sha256.slice(0, 12)}…`)
    console.log(`      ${e.downloadUrl}`)
  }

  const catalogPath = resolve(ROOT, args.catalog)
  const catalog = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : { schema: 1, plugins: [] }
  const { next, added, replaced } = mergeCatalog(catalog, entries)
  console.log(`\n  清单 ${args.catalog}：新增 ${added} 条、替换 ${replaced} 条、保留 ${(catalog.plugins ?? []).length - replaced} 条`)

  if (args.dryRun) {
    console.log('\n[dry-run] 不会：创建 Release / 上传附件 / 写清单')
    console.log('[dry-run] 上传时需要的 token：环境变量 GITHUB_TOKEN 或 GH_TOKEN（contents: write）')
    process.exit(0)
  }

  if (!args.noUpload) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (!token) {
      console.error('\n✗ 没有 token：请设 GITHUB_TOKEN（或 GH_TOKEN），或用 --no-upload 只更新清单')
      process.exit(2)
    }
    const release = await ensureRelease({ repo: args.repo, tag: args.tag, token })
    console.log(`\n  Release ${args.tag} → id=${release.id}`)
    for (const e of entries) {
      const pkg = available.get(e.id)
      const asset = await uploadAsset({ repo: args.repo, releaseId: release.id, file: pkg.zip, token, clobber: args.clobber })
      console.log(`  ✓ 已上传 ${asset.name}（${asset.size} 字节，state=${asset.state}）`)
    }
  }

  writeFileSync(catalogPath, JSON.stringify(next, null, 2) + '\n')
  console.log(`\n  ✓ 清单已更新：${catalogPath}`)

  const rel = args.catalog
  if (args.commit) {
    execFileSync('git', ['add', rel], { cwd: ROOT, stdio: 'inherit' })
    execFileSync('git', ['commit', '-m', `chore(catalog): 发布 ${ids.join(', ')}（${args.tag}）`], { cwd: ROOT, stdio: 'inherit' })
  } else {
    console.log('\n  下一步（提交清单）：')
    console.log(`    git add ${rel} && git commit -m "chore(catalog): 发布 ${ids.join(', ')}（${args.tag}）"`)
    console.log('    git push')
  }
} catch (e) {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
