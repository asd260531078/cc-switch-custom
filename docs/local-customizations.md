# 本地定制差异

## 基线与维护约定

- 本项目仓库：[asd260531078/cc-switch-custom](https://github.com/asd260531078/cc-switch-custom)。`origin` 用于本项目上传，`upstream` 指向官方仓库；默认推送目标为 `origin`。
- 仓库初始化时仅有 Apache 2.0 许可证，其[原始记录](https://github.com/asd260531078/cc-switch-custom/blob/186fdb999d30a77aa95106bd05f7e5758004299c/LICENSE)保留在 Git 历史中；合入官方源码后，根目录 `LICENSE` 沿用官方 MIT 及原版权声明。
- 上游唯一基线：[farion1231/cc-switch](https://github.com/farion1231/cc-switch)。本地起点为官方 `v3.20.2` / `f3b18df12007d0fd79fd8ad8d310880664015197`，分支 `codex/fix-claude-desktop-deeplink`。
- 官方优先、定制最小化：保留目录、接口、配置与业务行为；优先复用官方能力，不做无关重构、格式化或依赖升级。按功能维护可独立撤销的差异。
- 每次修复或同步前重新检查最新稳定版、相关提交和 PR 状态，区分已发布、已合并、未合并。先验证需求、配置和数据兼容，再让官方接管；部分覆盖时只保留未覆盖部分。不能因名称相同或发生冲突就删掉必要行为。
- 冲突逐项按功能解决，不整文件覆盖。涉及实际用户数据时先备份并明确迁移、回滚。同步后更新本表、删除失效兼容代码，再执行对应回归；不保证未经验证的未来版本兼容。
- 源码上传及本次 macOS / Windows 安装包构建发布已获授权，目标为本项目仓库。更新本机已安装应用及修改真实用户配置不在本次范围内。

## CD-DL-1：Claude Desktop 一键导入

**目的**：让 `ccswitch://v1/import?resource=provider&app=claude-desktop` 完成解析、预览、保存和显式切换。

| 范围 | 最小定制 | 官方接管后可移除的条件 |
| --- | --- | --- |
| `src-tauri/src/deeplink/{parser,provider}.rs` | 规范化三个 Desktop 别名；复用 Claude env 合并、URL 参数优先；补齐 Desktop JSON/TOML 和凭据转换，合并后继续验证 URL | 官方通过普通/内嵌配置、别名、优先级和校验回归 |
| `src-tauri/src/commands/provider.rs`、deeplink builder | 复用官方模型建议逻辑及 `[1m]` 转换；直连保存实际 Claude 模型 ID；本地路由保留多个档位映射到同一模型的独立入口 | 官方覆盖直连模型清单、非 Claude 模型路由、重复档位和现有元数据兼容 |
| `src-tauri/src/services/provider/mod.rs`、deeplink importer | Desktop `add_to_live=false` 仅保存；显式 `enabled=true` 再调用官方 switch | 首次及已有供应商的“只导入”均不改变当前项/设备设置/live 文件，切换沿用官方备份与回滚 |
| `src/lib/api/deeplink.ts`、`src/utils/deepLinkConfigPreview.ts`、`src/components/DeepLinkImportDialog.tsx`、四种语言文件 | 类型、模型展示、脱敏预览、Desktop 状态刷新，以及明确的两个导入动作 | 官方覆盖完整前端交互与失败状态 |

协议不增加参数、数据库不改表、不迁移：配置仍为官方 `settingsConfig.env` 与 `meta.claudeDesktopMode/claudeDesktopModelRoutes`。`config=` 使用 Base64 JSON/TOML 的 `env` 对象，不是完整 Desktop profile 或任意供应商导出格式；保留自定义 env。`ANTHROPIC_API_KEY` 可作为未提供 token 时的后备，最终转换为 Desktop 所需的 `ANTHROPIC_AUTH_TOKEN`。显式 URL 值优先，空值沿用现有合并规则。

模型沿用官方规则：配置三档时按各档生成；只有各档均为空才用 `model` 生成 Sonnet 兜底。安全 Claude 模型走直连，其他模型走本地路由。路由模式运行时仍需官方本地路由服务；“切换供应商”不代表已验证上游可用或自动启动服务。`configUrl` 继续保留官方的“不支持远程配置”错误。

Desktop 弹窗的“只导入”总是提交 `enabled=false`，即使链接写了 `enabled=true`；“导入并立即切换”提交 `enabled=true`。其他应用的导入语义保持官方行为。后端调用也可显式传入 `enabled`；Desktop 缺省为只导入。

**上游核查（2026-09-11）**：最新稳定 [v3.20.2](https://github.com/farion1231/cc-switch/releases/tag/v3.20.2) 发布于 2026-09-07。当前 [main `7726c834`](https://github.com/farion1231/cc-switch/commit/7726c83476f9ae1f8a5b812aa844cd166339aa55) 领先 12 个提交，相关 parser/provider/Desktop 配置文件与 tag 相同。问题 [#6368](https://github.com/farion1231/cc-switch/issues/6368)、[#3112](https://github.com/farion1231/cc-switch/issues/3112) 开放；PR [#6369](https://github.com/farion1231/cc-switch/pull/6369)、[#6489](https://github.com/farion1231/cc-switch/pull/6489)、[#3249](https://github.com/farion1231/cc-switch/pull/3249) 均未合并，不能视作稳定版已支持。已合并 [#2928](https://github.com/farion1231/cc-switch/pull/2928) 的自定义 env 保留能力继续复用。

## CX-DL-1：Codex 深链导入认证

从定制版 `3.20.202` 起，`src-tauri/src/deeplink/provider.rs` 生成的 API Key 供应商配置默认使用 `requires_openai_auth=false`，省去导入后手动编辑。API Key 继续保存在内部 `auth.OPENAI_API_KEY`；启用时复用官方逻辑注入供应商自己的 `experimental_bearer_token`，并按“保留官方登录”设置调整运行配置。开启保留时运行标志仍可为 `true`，请求凭据仍是第三方 Key，不覆盖这一兼容行为。

不增加协议参数、不迁移数据库、不自动修改已导入记录，也不改变链接的 `enabled` 语义。仅保存到已有供应商列表时不会切换；首个 Codex 供应商自动启用仍沿用官方行为。

本地验证（2026-09-11）：旧模板被新增断言复现为失败，修改后 12 项深链集成、45 项深链单元及 117 项 Codex 配置单元测试通过，格式和 Clippy 检查通过。集成测试覆盖 URL/内嵌配置、启用/保存、保留登录开/关共 8 个组合及切换回填；使用隔离目录与虚拟凭据。Windows 实机安装及真实上游调用不属于这些测试。

上游 `v3.20.2` 已包含运行时凭据注入与官方登录保留逻辑，但深链模板仍为 `true`。上游修正导入模板并通过上述回归后可撤销本项；撤销只恢复模板，不删除供应商或用户配置。对应测试位于 `src-tauri/tests/deeplink_import.rs`。

## REPO-DOC-1：移除仓库赞助宣传

按本项目展示要求，删除四种语言 README 的完整赞助区（横幅、广告表、优惠及招募链接），并删除 `.github/FUNDING.yml` 中的 GitHub Sponsor 入口。此项仅调整仓库展示，应用供应商预设、共用素材及官方 MIT 版权声明保留。

没有对应上游缺陷，这是本项目的展示偏好。同步官方时检查 README 和 FUNDING，避免重新引入赞助入口；用户恢复展示，或官方已移除相同内容时，可撤销对应定制差异。验证四种语言的相邻章节和链接结构、赞助入口残留以及代码目录无改动，无需运行应用测试。

## DIST-1：本仓库安装包与更新通道

复用 `.github/workflows/release.yml` 的官方构建、打包及 updater 元数据流程，首批发布 Windows x86_64 MSI/绿色版与 macOS 12+ Universal DMG/ZIP。缺少 Apple 证书时使用 ad-hoc 签名并验证两种架构，不能宣称已公证；Windows 无 Authenticode 证书。发布先保留草稿，检查 CI、安装包及更新元数据后再由维护者公开。

首版应用/安装器版本为 `3.20.201`，对应官方基线 `3.20.2` 的定制第 1 版。版本使用三段数字以满足 macOS / MSI，后续定制必须递增，不能覆盖已发布标签。`package.json`、Cargo 清单/锁文件、Tauri 配置同步版本；依赖版本不变。

Tauri 更新地址、公钥、About 发布说明、手动更新及数据库版本不匹配时的下载入口仅指向本仓库。保留官方 updater 签名校验，使用本项目独立密钥；Actions 仅保存加密 secret，禁止将私钥/密码提交或上传到 Release。本机签名材料位于不随 Git 传输的 `.git/cc-switch-custom-signing/`，迁移仓库时须另行安全备份。丢失私钥不能靠更改源码公钥让已安装版本继续自动更新，必须制定换钥迁移。

应用名、标识、数据目录和 `ccswitch://` 协议沿用官方，属于替换安装，不能承诺与官方版并行隔离。安装前退出旧版、使用官方设置备份/导出；回滚时退出定制版、重新安装明确版本的官方包（Windows 若拒绝降级，先卸载定制程序并保留数据），只有配置不兼容时才按官方恢复流程使用安装前备份。此次未安装或改写真实用户数据。

此项是发行渠道差异，无对应上游缺陷；以后同步保留本仓库来源、签名和数字版本策略。仅当用户决定恢复官方发行渠道并验证安装/数据/更新迁移后才能移除，不能仅因官方发布新版本而删掉。

**发行验证（2026-09-11）**：[v3.20.201](https://github.com/asd260531078/cc-switch-custom/releases/tag/v3.20.201) 已发布 10 个文件。源码标签固定为 `7fda070f`，后续仅修正发布脚本。macOS 包本机构建，Windows 包来自成功的 Actions 子任务；CI 全部通过。已核对包内版本/架构、DMG 挂载后的签名、Tauri 更新签名、元数据及 GitHub SHA-256。未做实机安装/协议唤起验收。重复构建已取消。工作流支持指定已有 tag 重建，失败产物仅留在 Actions，发布仍需检查草稿。

## Claude Desktop 导入验证与撤销

行为回归位于 `src-tauri/src/deeplink/tests.rs`、`src-tauri/tests/deeplink_import.rs`、`tests/components/DeepLinkImportDialog.test.tsx`、`tests/utils/deepLinkConfigPreview.test.ts`。复用原有 Desktop 配置与模型建议测试；测试只使用内存数据库、隔离 home 和虚拟凭据。

2026-09-11 本地验证结果：

- `pnpm typecheck`、`pnpm format:check`、前端全量测试通过（135 个文件、1093 项）；`pnpm build:renderer` 成功，有 Vite 包体超过 500 kB 的提示，未扩大到无关构建重构。
- `cargo test --locked --lib deeplink:: -- --test-threads=1`：45 项通过；`cargo test --locked --lib claude_desktop -- --test-threads=1`：43 项通过；`cargo test --locked --test deeplink_import -- --test-threads=1`：11 项通过。以上 Cargo 命令在 `src-tauri` 下执行。
- `cargo fmt --check`、`cargo clippy --locked --all-targets`、`git diff --check` 通过；依赖清单及锁文件未变。
- macOS 隔离测试验证 DB 保存、现有/空/官方 current 保留、设备设置与 Desktop 文件不变，以及显式 direct/proxy 切换的 profile 写入。未写真实用户配置。
- 使用实际 React 弹窗和模拟 Tauri IPC，在本地浏览器检查 320/390/1280 px、明暗主题、密钥脱敏和键盘操作；两个动作实际分别发送 `enabled=false/true`。复用现有 Dialog/Button 与状态反馈，不增动效依赖。

Windows 10/11 尚未实机测试，Windows 字体/缩放/WebView 与系统 `ccswitch://` 唤起未验收；macOS 未运行安装包或改动已安装应用，也未向真实上游发模型请求。浏览器 IPC 模拟与隔离配置测试不等于安装后端到端验收。后续准备本地安装包时补齐这一步，届时重新核查上游状态。

撤销此功能时按上述文件中的 CD-DL-1 差异反向应用，保留后来无关变更；不要重置整个文件或分支。源码撤销不会删除已导入记录。实际启用后的 Desktop 配置恢复使用官方“恢复官方”流程及其备份，不通过删除用户目录回滚。
