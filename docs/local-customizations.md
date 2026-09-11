# 本地定制差异

## 基线与维护约定

- 本项目仓库：[asd260531078/cc-switch-custom](https://github.com/asd260531078/cc-switch-custom)。`origin` 用于本项目上传，`upstream` 指向官方仓库；默认推送目标为 `origin`。
- 仓库初始化时仅有 Apache 2.0 许可证，其[原始记录](https://github.com/asd260531078/cc-switch-custom/blob/186fdb999d30a77aa95106bd05f7e5758004299c/LICENSE)保留在 Git 历史中；合入官方源码后，根目录 `LICENSE` 沿用官方 MIT 及原版权声明。
- 上游唯一基线：[farion1231/cc-switch](https://github.com/farion1231/cc-switch)。本地起点为官方 `v3.20.2` / `f3b18df12007d0fd79fd8ad8d310880664015197`，分支 `codex/fix-claude-desktop-deeplink`。
- 官方优先、定制最小化：保留目录、接口、配置与业务行为；优先复用官方能力，不做无关重构、格式化或依赖升级。按功能维护可独立撤销的差异。
- 每次修复或同步前重新检查最新稳定版、相关提交和 PR 状态，区分已发布、已合并、未合并。先验证需求、配置和数据兼容，再让官方接管；部分覆盖时只保留未覆盖部分。不能因名称相同或发生冲突就删掉必要行为。
- 冲突逐项按功能解决，不整文件覆盖。涉及实际用户数据时先备份并明确迁移、回滚。同步后更新本表、删除失效兼容代码，再执行对应回归；不保证未经验证的未来版本兼容。
- 源码上传已获授权，目标为本项目仓库。发布安装包、更新已安装应用及修改真实用户配置仍需另行授权；上传源码不推送版本标签。

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

## REPO-DOC-1：移除仓库赞助宣传

按本项目展示要求，删除四种语言 README 的完整赞助区（横幅、广告表、优惠及招募链接），并删除 `.github/FUNDING.yml` 中的 GitHub Sponsor 入口。此项仅调整仓库展示，应用供应商预设、共用素材及官方 MIT 版权声明保留。

没有对应上游缺陷，这是本项目的展示偏好。同步官方时检查 README 和 FUNDING，避免重新引入赞助入口；用户恢复展示，或官方已移除相同内容时，可撤销对应定制差异。验证四种语言的相邻章节和链接结构、赞助入口残留以及代码目录无改动，无需运行应用测试。

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
