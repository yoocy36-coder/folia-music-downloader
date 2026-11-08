# 音乐下载 · Music Downloader

给 [Folia](https://github.com/chthollyphile/folia-major) 首页加一个「下载」页：直接复用 Folia 已经适配好的在线音源后端，解析当前歌曲 / 整个播放队列的音频地址并保存到音乐文件夹，同时为当前歌曲写出 `.lrc` 歌词。

不打断播放、不用等缓存、不针对每个平台写接口：Folia 的 Omni 音源本来就负责为每个平台解析音频地址，模组直接调用它的内部解析器（`folium.internals.omni.getAudioSource`），再交给主进程下载。

## 功能

- 首页左侧导航新增「下载」页
- **下载当前歌曲**：解析当前音源地址，保存到系统「音乐」文件夹，文件名 `歌名 - 歌手.m4a/mp3/flac…`，同时写同名 `.lrc`
- **下载整个队列**：对当前播放队列逐首解析并下载，3 个并发；可随时停止、逐首显示结果
- **不切歌、不打断播放**：解析地址不需要播放这首歌，你正在听的歌不会被打断
- 自动从最高可用音质往下试（母带 → 无损 → 高品 → 标准），实际能拿到多高取决于你的账号权益和平台本身
- 支持 Folia 支持的所有在线音源（网易云 / QQ / 酷狗 / 汽水 / 波点 / YouTube Music / Spotify…）

## 安装

需要 **Folia 桌面版 0.7.20 及以上**，并在「设置 → 模组」里打开「模组系统」。

1. 下载仓库 zip（或 Release 里的 zip）
2. 打开 Folia「设置 → 模组」，把 zip 拖进模组面板；也可以解压后把 `music-downloader` 文件夹放进 `%APPDATA%\Folia\mods`
3. 在模组面板启用「音乐下载」，确认弹窗后生效
4. 播放一个歌单或专辑，首页左侧导航会出现「下载」

## 音质说明

- 模组会向 Folia 的解析器依次请求 `hires → lossless → high → standard`，取第一个真实可用的完整音频（拒绝试听片段）。
- 实际码率取决于平台后端与账号：例如网易云可以拿到 hires/lossless；**汽水音乐目前 Folia 后端只暴露 standard**，所以汽水歌下载下来就是标准音质，这是音源后端限制，不是模组能绕过的。
- 失败时会逐首显示原因（例如「仅试听」「provider gave no play link」）。

## 工作原理

1. 通过 `folium.internals.omni`（Folia 的「自由度出口」，直接给出宿主内部 Omni 实例）调用 `getAudioQualityLevels(provider)` 和 `getAudioSource(song, quality)`；
2. Folia 的 Omni provider 负责各平台的签名 / 会话 / 音质协商；
3. 模组把解析出的地址交给主进程，用 Electron 的 `net` 流式下载到系统音乐文件夹，按 Content-Type 决定扩展名；QQ/网易云等 CDN 需要的 Referer 会按来源补上，失败会自动去掉 Referer 重试一次；
4. 当前歌曲用 Folia 正在显示的歌词写出 `.lrc`。

没有按平台分别适配：Folia 支持什么，页面就支持什么。

## 已知限制

- `folium.internals` 是宿主内部接口，Folia 小版本更新后可能变化；出问题会显示「解析失败」而不是崩溃。
- 部分歌曲平台不提供播放链接 / 仅试听 / 需要更高会员权益，会下载失败并显示原因。
- 下载地址带签名、绑定账号权益，可能会过期；模组在解析后立即下载。
- 音质以平台后端实际返回为准；汽水音乐当前只有 standard。
- 下载的文件仅供个人离线使用。

## 权限

`mod.json` 没有声明任何需要授权的权限：

- 不联网下载第三方 API：音频地址由 Folia 自己的 Omni 后端解析，模组不登录、不读 cookie、不内置平台 API。
- 不使用 `omni.hooks`：不再需要播放歌曲来触发解析。
- 写文件只发生在系统「音乐」文件夹（用户点击下载时），按规范在提交 issue 中申报。

## 作者与反馈

Dev by **Fy**（[@yoocy36-coder](https://github.com/yoocy36-coder)）。

问题或需求请到 [本仓库的 issue](https://github.com/yoocy36-coder/folia-music-downloader/issues) 提。

## 更新日志

### 0.4.0

- 不再通过播放歌曲 + `omni.audioSourceResolved` 钩子拿地址，改为直接调用 `folium.internals.omni.getAudioSource`
- 下载不再切歌、不跳播放页、不打断正在播放的音乐
- 队列下载改为 3 并发，逐首显示成功/失败原因
- 按来源补 Referer 并支持无 Referer 重试，减少 CDN 403
- 自动从最高音质往下试，拒绝试听片段

### 0.3.0

- 通过 `omni.audioSourceResolved` 钩子解析地址（已废弃）

### 0.2.0 / 0.1.0

- 读缓存方案（已废弃）

## 许可证

MIT，见 [LICENSE](LICENSE)。
