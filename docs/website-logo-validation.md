# 网站 Logo 导入验证记录

日期：2026-09-12。范围：当前 CC Switch 二开工作区的 `iconUrl` 实现；未发布安装包或推送代码。

## 实现与兼容边界

- 深链接增加可选 `iconUrl`，只解码外层 URLSearchParams 一次，保留图片路径/查询大小写及内层百分号编码。原 `icon` 继续表示内置图标。
- 通过原有 `ProviderMeta` 的 `iconUrl` JSON 字段持久化；无新表、字段迁移或数据回填。旧配置无此字段仍可读，旧版读取时忽略它。使用旧版编辑/保存后可能丢失该新增元数据，需要重新导入或填写 Logo 地址。
- 预览、供应商卡片与编辑共用 `ProviderIcon`。Logo 加载独立于导入、启用、切换、模型请求、密钥和用量查询；下载器不接受这些业务参数。
- 每个原始 URL 独立取 SHA-256 缓存键；共享 API 地址、同一 CDN 的不同路径/查询、大小写不同的路径不会互相覆盖。
- HTTPS、全部 DNS/IP、公网地址限制、每次重定向、固定解析结果及连接目标校验；独立 HTTP 客户端不使用代理、Cookie、认证头或 Referer，不更改系统 VPN/代理配置。
- 仅 PNG/JPEG/WebP/GIF/ICO；响应 MIME 与实际格式一致才能解码。拒绝 SVG/HTML，限制下载 2 MiB、解码尺寸 2048×2048/分配预算 32 MiB，转为最长边 256 像素、至多 512 KiB 的纯 PNG。
- 3 次重定向；3 秒连接超时、10 秒 HTTP 超时，含排队/DNS/全部跳转/处理的等待总上限 12 秒。解码在后台进行并限制并发，超时后不会阻塞导入或切换。
- 磁盘目录为 Tauri `app.path().app_cache_dir()/provider-logos-v1`，无硬编码平台路径；原子写入，按文件读取时限 7 天、最多 128 个缓存文件。目录不可用、写入失败、缓存损坏或图片加载失败均回退原图标。
- 页面会话按完整 URL 合并并发请求；成功结果短缓存 5 分钟，失败短缓存 60 秒。失败到期后重新打开/重新挂载组件可重试，持续挂载的失败卡片不会自动周期下载。
- 界面保留既有尺寸、颜色、弹窗和按键反馈；图标加载与回退不增加位移动效，避免布局跳动。

## 自动验证

环境：macOS 26.6.2，Apple Silicon arm64；Rust 1.96.0，Node 24.18.0，pnpm 10.12.3。

| 检查 | 结果 |
|---|---|
| `pnpm typecheck`、`pnpm format:check` | 通过 |
| `pnpm test:unit` | 140 个文件、1135 项通过 |
| 最终 Logo 前端定向复验 | 3 个文件、16 项通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 2972 项通过、5 项原有测试忽略 |
| 深链集成测试 | 13 项通过，含 Logo 元数据、保存/启用、Codex 官方登录保留及切换回填 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | 通过 |
| `cargo fmt --check`、`git diff --check` | 通过 |
| `pnpm tauri build --target universal-apple-darwin --no-bundle` | 通过；前端生产构建及 arm64/x86_64 两次 release 编译完成 |
| 现存无关改动 | 本次启动时记录的 23 个文件内容哈希保持一致 |

新增覆盖：主站、两个共享 API 地址的分站、自定义域名、同 CDN 不同图片、大小写及百分号/查询参数、缺失/无效/失败图片、旧链接及内置图标。下载测试使用隔离传输夹具验证完整重定向/DNS/流式大小控制流程，额外覆盖混合公网/内网 DNS、重绑定、IPv4/IPv6 特殊地址、响应类型伪装、损坏/超尺寸光栅图、PNG 重编码、含中文与空格的缓存目录、缓存替换/损坏/过期/写入失败和容量限制。

UI 检查使用项目真实组件、隔离的 IPC 图片数据与表单，不操作实际用户配置：Codex 内置 Chromium 浏览器，1000×650、900×600，明暗主题；确认各分站图片分离、预览图片解码成功、失败与旧链接回退、清除立即回退、无效 URL 可输入、Tab 焦点可见、无横向溢出、无浏览器错误/警告、无远程 `img src`。临时页面、服务及视口覆盖已清理。

## 按系统分别记录

| 系统/架构 | 已验证 | 未验证 |
|---|---|---|
| Windows 10 x64 | 共用源码及自动回归覆盖；跨平台目录/文件替换接口静态核查 | 本轮未在 Windows 构建或运行；未实测安装、系统深链唤起、WebView2、磁盘缓存与错误回退、100%/125%/150% 缩放 |
| Windows 11 x64 | 共用源码及自动回归覆盖；跨平台目录/文件替换接口静态核查 | 本轮未在 Windows 构建或运行；未实测安装、系统深链唤起、WebView2、磁盘缓存与错误回退、100%/125%/150% 缩放 |
| macOS Apple Silicon | arm64 原生 Rust 测试、前端自动测试、上述隔离浏览器 UI 检查、arm64 release 构建 | 未启动打包应用验收系统 `ccswitch://` 唤起、WKWebView、真实应用缓存及联网失败恢复 |
| macOS Intel | x86_64 release 交叉编译、Universal 双架构产物核对；共用源码及自动回归覆盖 | 未在 Intel 实体 Mac 运行、未实测系统深链唤起、WKWebView、实际缓存与错误回退 |

Universal 二进制：`src-tauri/target/universal-apple-darwin/release/cc-switch`；`file`/`lipo -archs` 确认同时包含 `x86_64 arm64`。本次仅构建二进制，没有生成安装包、签名发布、修改版本号或推送代码。产物包含当前工作区的已有改动。Vite 提示主 chunk 超过 500 kB，但生产构建成功，本次未扩大为包体积优化。

二进制 SHA-256：`019feea04f260a273ea216d7df61b92c5bf6f5a9c316d7cf208d1325fdc1dd4f`。

浏览器检查和构建都不能替代 Windows/macOS 的实机验收；本轮没有在真实站点上抓包验收 Logo 下载，也未使用真实用户 API Key 发起模型或用量请求。系统注册/唤起路径仅静态核查：现有 Windows MSI 对 `%1` 加引号，Windows 参数、Tauri `on_open_url` 与 macOS `RunEvent::Opened` 仍复用同一解析器及 `deeplink-import` 事件。

## 实机验收步骤

在上述每个系统分别使用测试供应商和测试 Key：安装本次构建的版本，测试应用关闭/已运行时点击主站、两个分站和自定义域名的 `ccswitch://v1/import`；确认预览、导入后卡片、编辑保存与重启后的 Logo 一致，API 地址/模型/用量查询/启用状态仍与原协议一致。

分别输入不同大小写/查询的 Logo URL，清除 Logo，以及测试 404、超时、损坏文件、SVG/HTML、超限图片、公网跳内网、缓存目录写入失败；确认回退内置图标且导入/切换不被阻断。检查抓包中 Logo 请求没有 API Key、Cookie 或认证头，验证 Windows 10/11 WebView2 与两种 macOS 架构的行为一致。

实现接口参考：[reqwest ClientBuilder](https://docs.rs/reqwest/0.12.28/reqwest/struct.ClientBuilder.html)。安全判断以上述源码与测试为依据。
