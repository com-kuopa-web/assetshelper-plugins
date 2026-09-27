# assets-plugins —— AssetsHelper 官方资产插件（插件）分发仓库

本仓库是 **公开的插件分发源**：App 在「设置 → 播放 → FFmpeg → 插件源」里指向本仓库的
`plugin-catalog.json`（留空即用内置官方源），即可按需下载 / 校验 / 安装插件。

> 仓库只做两件事：
> 1. **放清单** `plugin-catalog.json`（几 KB：有哪些插件、在哪下、sha256、镜像）；
> 2. **放 CI 与构建脚本**（从官方源码自建 FFmpeg → 打包成合规插件包 → 作为 **Release 资源**上传）。
>
> ⚠️ **二进制不进仓库**：40~80MB 的文件会让 clone 变慢、仓库膨胀（GitHub 单仓库建议 ≤2GB）；
> Release 资源有独立 CDN、单文件可到 2GB。**仓库管清单，Release 管大文件。**

---

## 一、构建（本地，一条命令）

### 0. 一次性准备依赖

构建脚本默认是 **最小构建**：只用 FFmpeg 自带编解码器 + 平台硬件编码，**不链接任何外部库**
（截帧/探测靠解码；转码优先硬件编码；音轨走 `-c:a copy`）。依赖因此很少：

| 平台 | 依赖 |
|---|---|
| **macOS** | `xcode-select --install` + `brew install nasm pkg-config` |
| **Ubuntu/Debian** | `sudo apt-get install -y nasm pkg-config` |
| **Windows** | 装 **MSYS2**，在 “MSYS2 MINGW64” 终端里：`pacman -S --needed make nasm pkgconf diffutils curl tar mingw-w64-x86_64-toolchain` |

> **硬件编码默认只开"便携无损"的那些**：macOS 用官方源码自带的 `--enable-videotoolbox`；
> Windows/Linux 有 `ffnvcodec` 头文件时开 `--enable-nvenc`；Windows 有 AMF 头文件时开 `--enable-amf`。
> 这些**只需要头文件、运行期动态加载驱动**，所以产物仍是**单个可执行文件**。
> 需要 QSV / VAAPI 时显式开启（注意：它们要**链接**运行库，产物不再单文件）：
> `ENABLE_QSV=1`（= `--enable-libvpl`，Windows 需带 `libvpl-2.dll`）、`ENABLE_VAAPI=1`（Linux，需 `libva`）。
>
> 需要 `libmp3lame/libopus/libass/freetype`（例如字幕烧录、mp3 编码）时再加 `FULL=1`，
> 并安装对应开发包：macOS `brew install lame opus libass freetype`、
> Ubuntu `libmp3lame-dev libopus-dev libass-dev libfreetype6-dev`、
> MSYS2 `mingw-w64-x86_64-lame mingw-w64-x86_64-opus mingw-w64-x86_64-libass mingw-w64-x86_64-freetype`。

### 1. 构建 + 打包（推荐）

```bash
# macOS / Linux（bash）
bash scripts/build-local.sh              # 默认版本 7.1.5
bash scripts/build-local.sh 8.1.3        # 指定版本
FULL=1 bash scripts/build-local.sh       # 额外链接 lame/opus/ass/freetype

# Windows（MSYS2 MINGW64 终端里，同一套脚本）
bash scripts/build-local.sh
```

它做三件事：**① 下载官方源码 →（PGP 验签 + 记录 sha256）→ 自建 LGPL ffmpeg；
② 打包成插件包；③ 打印"怎么本地验证 / 怎么发布"**。

- 耗时：首次约 **10~25 分钟**（编译为主）；第二次复用 `.build/` 会快很多。
- 产物：
  ```
  .build/out/bin/ffmpeg[.exe]                                  # 二进制
  .build/SOURCE-SHA256.txt                                     # 源码包校验和（合规记录）
  licenses/COPYING.LGPLv2.1                                    # 从官方源码树复制（随插件包分发）
  dist-plugins/official.ffmpeg-<ver>-<platform>-<arch>.zip     # ★ 插件包
  dist-plugins/official.ffmpeg-<ver>/                          #   解压形态（含 manifest/licenses/NOTICES/build-info）
  ```

### 2. 分步（想看清每一步 / 只重打包）

```bash
# ① 只建 ffmpeg
bash scripts/build-lgpl-ffmpeg.sh 7.1.5

# ② 只打包（二进制已存在）
bash scripts/build-local.sh --skip-build 7.1.5
#   等价于：
node scripts/build-ffmpeg-plugin.mjs \
  --bin .build/out/bin/ffmpeg \
  --license licenses/COPYING.LGPLv2.1 \
  --version 7.1.5 --out dist-plugins --require-lgpl

# ③ 只更新清单（不发布）
node scripts/update-catalog.mjs --dir dist-plugins --catalog plugin-catalog.json \
  --repo <owner>/assets-plugins --tag ffmpeg-7.1.5
```

要点：
- `--require-lgpl` 是**硬门槛**：检测到 GPL / `--enable-nonfree` 构建直接失败，防止把不合规二进制发出去；
- 构建脚本结尾还会再查一次 `ffmpeg -version` 的 configure 行，确认没有 `--enable-gpl/--enable-nonfree`；
- 想锁定源码校验和：`FFMPEG_SRC_SHA256=<官方 tar.xz 的 sha256> bash scripts/build-lgpl-ffmpeg.sh 7.1.5`。

### 3. 本地验证（不用发布）

| 方式 | 做法 |
|---|---|
| **装进 App** | 打开 AssetsHelper → 设置 → 播放 → FFmpeg → 「导入插件包…」→ 选中**解压后的目录** `dist-plugins/official.ffmpeg-<ver>`（也可以选二进制文件本身） |
| 手动放 | 把 `official.ffmpeg-<ver>/` 拷到 `{userData}/plugins/official.ffmpeg/<ver>/`（macOS: `~/Library/Application Support/AssetsHelper/plugins/`；Windows: `%APPDATA%\AssetsHelper\plugins\`） |
| 只验二进制 | `.build/out/bin/ffmpeg -hide_banner -version` / `-encoders | grep -E "libx264|h264_videotoolbox|h264_nvenc"` |

装好后：设置里的 FFmpeg 行应显示「来源：插件包 · 版本 · 许可证 · 编码器」；视频转码/截帧即可用。

### 3.5 核对"清单里写的"与"真的那份产物"（`verify-release.mjs`）

`update-catalog.mjs` 是拿**本地那份 zip** 算 sha256 写进清单的 —— 它信任本地文件。
而"上传到 Release 之后，用户下到的到底是不是同一份字节"**没人回读**，所以补了一个核对脚本：

```bash
# ① 离线：清单 vs 本地 zip（发布**前**跑；CI 里已经自动跑了这一步，在提交清单之前）
node scripts/verify-release.mjs --dir dist-plugins

# ② 在线：逐个下载清单里的 downloadUrl 再核对（发布**后**手动跑）
node scripts/verify-release.mjs --url --repo com-kuopa-web/assets-plugins --tag ffmpeg-7.1.5

# ③ 自检（负向对照）：造一份**故意篡改**的夹具，断言"必须被抓到"（零网络）
node scripts/verify-release.mjs --self-test
```

口径（否则会天天误报）：

| 情况 | 默认 | `--strict` |
|---|---|---|
| 清单条目在本地/线上找不到对应产物 | **跳过**并说原因（清单里可能留着历史版本） | 失败 |
| 目录里有 zip **不在**清单里 | 警告 | 失败 |
| sha256 或 size 不一致 | **失败**（退出码 1） | 失败 |

> ⚠️ `--dir` 比的是**本地目录里的那份**。若清单来自 CI 发布、而本地是**另一次构建**，
> 两者本来就不该相同 —— 这个模式用在"刚构建完、还没上传"那一步。

### 4. 发布（CI 出全平台包）

```bash
git add -A && git commit -m "feat: ffmpeg 插件构建" && git push
git tag ffmpeg-7.1.5 && git push origin ffmpeg-7.1.5
```

CI（`.github/workflows/release-ffmpeg.yml`）会在 4 个 runner 上各自**自建**（macOS arm64/x64、Linux x64、Windows x64/MSYS2），
打包后上传 Release，并自动更新并提交 `plugin-catalog.json`。

也可以**手动触发**：Actions → Release FFmpeg component → Run workflow（填版本号，可选 FULL）。

### 5. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| **`line N: VERSION?: unbound variable`**（变量名后面跟了个乱码字符） | **`$VAR` 紧跟中文/全角字符**的 bash 解析坑：在 UTF-8 locale 下 bash 会把后面的全角字符吃进变量名（`LC_ALL=C` 下却正常，所以"我这儿能跑、别人一跑就挂"）。修法：写成 `${VAR}` + 空格。仓库已提供体检脚本：`node scripts/check-shell-expansions.mjs`（`build-local.sh` 开头与 CI 都会先跑它） |
| `set: -\r: invalid option` / `bash: $'\r': command not found` | **CRLF 检出**（Windows 常见）：仓库已加 `.gitattributes`（`*.sh text eol=lf`）；历史文件可 `git add --renormalize .` 或手动 `sed -i 's/\r$//' scripts/*.sh` |
| **下载中断（`curl: (56) Recv failure: Connection reset by peer`）** | 官方源在国内可能不稳。脚本已支持**断点续传**：**原样重跑同一命令**即可从断点继续；留下的 `*.tar.xz.part` 会自动接上。若长期不通，换源：`FFMPEG_SRC_URL=https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n7.1.5.tar.gz bash scripts/build-lgpl-ffmpeg.sh 7.1.5` |
| **上次下载留下半截包** → 解压报 `Lzma library error` / `tar: Error exit delayed` | 脚本现在会**自动识别**（用 `tar -tf` 校验）→ 删除坏包并重下；解压中断留下的半个源码目录也会被识别（以 `configure` 是否存在为准）并清理重解压。想彻底重来：`bash scripts/build-local.sh --clean 7.1.5` |
| **CI 一直「Waiting for a runner to pick up this job...」** | **runner 标签被 GitHub 退役了**（`macos-13` 于 2025 年下线）。排队阶段没有可配置超时，只能取消重跑，且**必须换标签**。当前可用：`macos-15`/`macos-14` = arm64、`macos-15-intel` = Intel x64、`ubuntu-*`、`windows-latest`。详见 `web/notes/ci/GitHub-Actions-runner标签与排队.md` |
| **`ENOENT: no such file or directory, mkdir 'D:\D:\a\…'`** | **Windows 路径被拼成双盘符**：脚本里用了 `new URL(import.meta.url).pathname` —— 它返回**URL 语义**路径（`/D:/a/…`），再 `path.resolve` 会补上当前盘符 → `D:\D:\a\…`。macOS/Linux 上恰好正常，所以只在 Windows CI 暴露。改为 `path.dirname(fileURLToPath(import.meta.url))`；仓库已加体检 `node scripts/check-node-paths.mjs`（CI 与 `build-local.sh` 都会跑） |
| **`Unknown option "--enable-qsv"`** | FFmpeg **没有** `--enable-qsv` 这个开关：QSV 走 `--enable-libvpl`（oneVPL）或 `--enable-libmfx`（旧 MediaSDK）。**pkg-config 包名 ≠ configure 开关名**，权威依据是 `./configure --help` 或源码里的 `xxx_deps=` 声明：<br>· NVENC → `--enable-nvenc`（探测 `ffnvcodec`）<br>· AMF → `--enable-amf`（**无 pkg-config**，只看 AMF 头文件）<br>· QSV → `--enable-libvpl` / `--enable-libmfx`（探测 `vpl`/`libvpl`）<br>· VAAPI → `--enable-vaapi`（探测 `libva`） |
| **`node: command not found`（Windows job，exit 127）** | MSYS2 的 shell **默认不继承 Windows PATH**（`msys2/setup-msys2` 的 `path-type` 默认 `minimal`），所以 `actions/setup-node` 装的 `node` 在 MSYS2 里不可见。处理：**需要 node 的步骤显式写 `shell: bash` 或 `shell: pwsh`**（本仓库的"脚本体检"与"打包（Windows）"就是这么写的）；也可给 setup-msys2 加 `path-type: inherit`（会引入 Windows 的 tar/curl 与 MSYS2 的混用风险，不推荐） |
| **`make: ffbuild/common.mak: No such file or directory`**（或 `fftools/Makefile`、`tests/*.mak` 一族） | 上一次**解压中断**留下的"半个源码目录"，而里面恰好已有 `configure` —— 旧版脚本只看这一个文件就误判为完整。现在改为：**逐个检查关键文件 + 解压到临时目录再原子改名 + 写完整性标记 `.unpacked-<版本>`**，检测到不完整会自动清理重解压（无需手动干预；想彻底重来用 `--clean`） |
| `WARNING: pkg-config not found, library detection may fail.` | **最小构建下可忽略**：我们不链接任何外部库（只用自带的解码器 + 平台硬件编码）。装了 `pkg-config` 只是让检测更完整 |
| `nasm not found` | 缺汇编器：macOS `brew install nasm`；MSYS2 `pacman -S nasm` |
| `configure: error: pkg-config not found` | 装 `pkg-config` / MSYS2 里是 `pkgconf` |
| 构建完发现 configure 行里有 `--enable-gpl` | 说明用了外部库的 GPL 版本（如 full 模式链了 x264）—— **不要分发**，检查 `FULL` 依赖 |
| Windows 产物报缺 DLL | 脚本已加 `--extra-ldexeflags=-static --pkg-config-flags=--static`；若仍缺，确认用的是 MINGW64 终端（不是 MSYS 终端） |
| macOS 上没有硬件编码器 | 确认 configure 行含 `--enable-videotoolbox`（脚本在 macOS 自动加） |
| 没有软件 H.264 编码（提示无法转码） | LGPL 构建**本来就没有 libx264**：靠 VideoToolbox/NVENC/QSV/AMF 硬件编码，或 `-c copy` 直通；无硬件时只能不转码 |
| CI 里 `zip`/`Compress-Archive` 失败 | 打包脚本会自动尝试 `zip` → PowerShell，两者都没有时只产出目录（手动压缩即可） |

---

## 二、目录

```
assets-plugins/
├── plugin-catalog.json                     # ★ App 拉取的清单（CI 自动更新）
├── .github/workflows/release-ffmpeg.yml    # 打 tag / 手动触发即发布（三平台自建）
├── .github/workflows/publish-plugins.yml   # ★ 发布**官方界面插件**（按 id / 组 / 全部，见 §二·2）
├── scripts/
│   ├── build-lgpl-ffmpeg.sh                # 官方源码 → 验签/记 sha256 → 自建 LGPL（macOS/Linux/MSYS2 通用）
│   ├── build-local.sh                      # ★ 本机一条命令：构建 + 打包 + 打印验证/发布方式
│   ├── build-ffmpeg-plugin.mjs             # 插件打包器（vendor：以 AssetsHelper/scripts/ 为主副本，改那边再复制过来）
│   ├── publish-plugins.mjs                 # ★ 发布官方界面插件：传 Release 附件 + 幂等合并清单（不依赖 gh）
│   ├── check-shell-expansions.mjs          # shell 体检：禁止 "$VAR 紧跟中文"（UTF-8 locale 坑）
│   ├── check-node-paths.mjs                # Node 体检：禁止 new URL(import.meta.url).pathname（Windows 双盘符）
│   └── update-catalog.mjs                  # 用产物自动更新清单（sha256/size/downloadUrl）
└── licenses/                               # 许可证原文（构建时从官方源码树复制，随插件包分发）
```

### 官方界面插件的发布（`publish-plugins`）

> ⚠️ **状态：备用（2026-09-26 起）**。官方 4 个界面插件（图片/音频/视频/模型）已拍板改为
> **全部随本体打包、首启只问启用位**（不下载、不依赖网络），见
> [`AssetsHelper/docs/prd/插件化架构/插件外置与预置分发方案.md`](../AssetsHelper/docs/prd/插件化架构/插件外置与预置分发方案.md) §7.12。
> 本节的通道**保留可用**，但**当前没有消费者** —— 真正在用的只有 **FFmpeg 二进制插件**那条线（§一）。
> 只有要"增量更新/灰度"或"某插件体积大到必须拆出去"时才启用它。

界面插件（图片/音频/视频/模型）与 ffmpeg 那种二进制插件**走同一条分发通道**：
zip 作为 **Release 附件**、清单条目写进 `plugin-catalog.json`。区别只在"内容物"——
界面插件包里是**明文 JS 产物** + `manifest.json` + `build.json`（不是二进制、也不是混淆脚本）。

**在 Actions 里发**（推荐）：`Publish official plugins` → 选 `plugins`（`all` / `core` / `optional` / `<id>[,<id>]`）
与 `tag`，**先留 `dry_run=true` 跑一次**看清单会怎么变，再关掉它真发。

**在本地发**（等价，便于排查）：

```bash
# 1) 先在本体构建产物
cd ../AssetsHelper && yarn plugin:build

# 2) 看计划（不联网、不写文件）
cd ../assets-plugins
node scripts/publish-plugins.mjs --dir ../AssetsHelper/dist-plugins --only official.model --tag plugins-1.0.0 --dry-run

# 3) 真发（上传需要 GITHUB_TOKEN/GH_TOKEN，contents: write）
GITHUB_TOKEN=… node scripts/publish-plugins.mjs --dir ../AssetsHelper/dist-plugins --group core --tag plugins-1.0.0
#    只想更新清单、附件已手动传过：加 --no-upload
#    清单改完自己提交：脚本会打印 git 命令（加 --commit 让它直接提交）
```

| 选择器 | 含义 |
|---|---|
| `--only official.model` / `--only a,b` | 一个 / 指定多个 |
| `--group core` | 图片 + 音频 + 视频（**多数人够用**那三件套） |
| `--group optional` | 模型（体积大，按需下载） |
| `--all` | 构建产物里发现到的**可发布**插件（**排除宿主自有的 `official.filelist`** —— 它随包预置、不可卸载，进清单只会造成"为什么装不了"的困惑；真要发它用 `--only official.filelist`） |

规则（防手滑）：**必须显式给一个选择器**；未知 id / 未知组 / **组里有成员没构建出来** → 直接报错；
清单合并是**幂等**的（同 `id@version` 替换、其它条目原样保留，比如 ffmpeg 那 4 条）；
`--dry-run` 不联网不写文件；不带 `--tag` 不允许真发（清单里的 `downloadUrl` 必须真实可下载）；
`--all` 会**排除宿主自有插件**（`official.filelist`，见 AssetsHelper 的 `src/shared/plugin-policy.ts`）并在输出里说明。

> ⚠️ **发布需要一个 secret**：workflow 要读两个**私有**源码仓（`AssetsHelper`、`assets-plugins-official`）
> → 在**本仓库**的 Actions secrets 里加 `CI_SSH_KEY`（一把只读、能读这两个仓的 key）。
> 建 Release 与提交清单用默认 `GITHUB_TOKEN` 即可（`permissions: contents: write`），不需要额外 PAT。

## 三、为什么"从源码自建"

ffmpeg.org 官方下载页写明：**“FFmpeg only provides source code.”**
页面给出的预编译链接（gyan.dev / BtbN / evermeet.cx / Homebrew）都是**第三方**，且大多是 `--enable-gpl`，
个别甚至是 `--enable-nonfree`（按官方说明**不可再分发**）—— 这正是本项目要避开的风险。

自建的好处：

- 只依赖官方源码 + 我们自己的 configure 行 → **"对应源码"义务最清晰**（版本 + 源码 sha256 + PGP 签名都可存档）；
- 明确 `--disable-gpl --disable-nonfree` → 产物是 **LGPL**，义务最轻；
- macOS 上本来也几乎没有现成的 LGPL 预编译产物。

代价：LGPL 构建没有 `libx264`，只能硬件编码或 `-c copy`。

## 四、许可证

- 本仓库的**脚本与清单**：随主项目授权；
- Release 中的 **FFmpeg 二进制**：由 FFmpeg 项目提供，按对应构建的许可证（默认 **LGPL-2.1-or-later**）分发；
  每个插件包内含 `licenses/`（来自官方源码树）与 `THIRD-PARTY-NOTICES.md`
  （版本、configure 行、源码获取方式、如何替换）。
- 源码获取：`https://ffmpeg.org/releases/ffmpeg-<version>.tar.xz`。
