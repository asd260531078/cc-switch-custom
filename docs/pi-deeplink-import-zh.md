# Pi 供应商一键导入

本页描述 CC Switch Custom v3.20.204 的 Pi 导入契约；安装包与验证边界见[发布说明](release-notes/v3.20.204-zh.md)。

入口：`ccswitch://v1/import?resource=provider&app=pi`。

| 参数                     | 要求                   | 行为                                                                       |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------- |
| `name`                   | 必填、非空白           | CC Switch 和 Pi 原生供应商显示名                                           |
| `endpoint`               | 必填、单个 HTTP(S) URL | OpenAI API 基础地址；NewAPI 通常为 `https://站点域名/v1`，保留实际部署前缀 |
| `apiKey`                 | 必填、非空白           | 明确传入的 API Key；拒绝 Pi 的命令、变量及转义表达式                       |
| `model`                  | 必填、非空白           | 添加一个模型，ID 原样保留；不写 Pi 的 `defaultModel`                       |
| `homepage`               | 可选、HTTP(S) URL      | 官网；省略时由 API 地址推导                                                |
| `enabled`                | 可选，`true` / `false` | 后端省略或 `false` 时仅存入 CC Switch；`true` 时同时添加到 Pi              |
| `icon`、`notes`          | 可选                   | 沿用供应商图标和备注                                                       |
| `usageScript` 等用量参数 | 可选                   | 沿用现有导入确认、凭据继承和查询配置校验                                   |

确认弹窗始终提供“仅导入”和“导入并在 Pi 中启用”。最终操作由用户点击的按钮决定，URL 中的 `enabled=true` 不会代替用户选择。启用只新增 `models.json.providers` 成员，保留其他供应商、顶层未知配置及全局默认供应商/模型。重复导入生成不同的供应商 ID。

本入口创建 `api: "openai-completions"`，即 **OpenAI Chat Completions**，由 Pi 追加 `/chat/completions`。NewAPI 网站应传 `/v1` 基础地址，不能传 `/v1/chat/completions`、`/v1/responses` 或 `/v1/messages`；仅支持 Responses 或 Anthropic Messages 的渠道不能直接使用这个导入契约。不会自动追加 `/v1`、猜测协议或改写站点部署前缀。

Pi 导入不接受逗号分隔多地址，也不接受 `config` / `configUrl` 配置载荷。其他协议、更多模型和高级原生字段继续通过 Pi 供应商页面配置。原生最小模型配置只需 `id`，其他模型属性由 Pi 自身处理；参见 [Pi 官方模型配置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。

网站生成示例（示例值均为占位符）：

```js
const link = new URL("ccswitch://v1/import");
link.search = new URLSearchParams({
  resource: "provider",
  app: "pi",
  name: "我的站点 Pi",
  endpoint: "https://api.example.com/v1",
  apiKey: "sk-example-only",
  model: "your-model-id",
  homepage: "https://example.com",
  enabled: "true",
}).toString();
const importUrl = link.toString();
```

向 `URLSearchParams` 传原始名称、密钥、模型和 URL，勿先调用 `encodeURIComponent`。外层仅编码一次，中文、`+`、`&`、`%`、`#` 等字符通过 URL 解析还原一次；端点内部已有的 `%2F` 等转义不会被再次解码。只有写入 HTML 源码属性时才将分隔符 `&` 转成 `&amp;`。

余额查询沿用 `usageScript`（UTF-8 内容的 Base64）、`usageEnabled`、`usageApiKey`、`usageBaseUrl`、`usageAccessToken`、`usageUserId`、`usageAutoInterval`。不显式传 `usageEnabled=true` 时不启用脚本；与供应商相同的用量密钥/地址转为继承，专用凭据单独保留。自动查询间隔保持既有 `0–1440` 分钟校验。导入不执行余额脚本，用量元数据只在 CC Switch 数据库中保存。

Logo 接入继续沿用独立 Logo 工作的 `iconUrl` 参数及下载/缓存校验。本版已合入该参数的完整实现；Pi 元数据清理会清除不支持的路由、认证绑定和计费控制，保留 `iconUrl` 等展示字段。不要把 `iconUrl` 放入 Pi 的 `models.json`。

验证使用隔离临时目录与内存 SQLite，包括原生文件错误、数据库保存失败及回滚期间外部修改。默认模型、其他应用配置和凭据文件均用虚拟数据检查。macOS 自动化验证不等于 Windows 10/11 真机、操作系统协议唤起、已安装 Pi CLI 或真实 NewAPI 请求验收。

## 本次修改与本地验收

| 文件                                                                         | 修改                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src-tauri/src/deeplink/parser.rs`                                           | 开放 Pi，解析阶段检查必填字段与输入约束                      |
| `src-tauri/src/deeplink/provider.rs`                                         | 生成 Pi 配置与唯一 ID，按 enabled 调用既有原子保存流程       |
| `src-tauri/src/services/provider/pi.rs`                                      | 保留展示元数据，继续清理 Pi 不支持的路由、认证绑定和计费控制 |
| `src/components/DeepLinkImportDialog.tsx`                                    | 明确保存/启用动作，刷新 Pi 列表与原生状态，处理长模型名      |
| `src/i18n/locales/{zh,zh-TW,en,ja}.json`                                     | 四种语言的按钮及行为说明                                     |
| `src-tauri/src/deeplink/pi_tests.rs`、`src-tauri/src/deeplink/tests.rs`      | URL 到保存、编码、校验、原有数据保护及失败回滚回归           |
| `tests/components/DeepLinkImportDialog.test.tsx`                             | 确认、取消、提交中、错误重试和缓存刷新回归                   |
| `docs/pi-deeplink-import-zh.md`、`docs/user-manual/zh/5-faq/5.3-deeplink.md` | 网站接入契约和手册入口                                       |

已在 Apple Silicon macOS 本地通过：

- 前端完整回归：135 个测试文件、1097 个测试；TypeScript、Prettier、Vite 构建通过。构建仍有包体积提示。
- 后端完整回归一轮：2969 个测试通过，5 个既有忽略项。最终调整后重新通过 2832 个库测试和 12 个深链接集成测试；`cargo fmt --check`、Clippy `-D warnings` 通过。
- 新增 Pi 后端用例 12 个，覆盖 URL 与直接 IPC、特殊字符、首次仅保存、重复导入、默认模型/其他应用保护、用量元数据、文件错误、数据库失败及外部修改下的回滚冲突。
- 只读补丁兼容检查通过。临时加入保存目录实际 `iconUrl` 字段后，Pi 展示元数据的保存、编辑和刷新测试通过；验证后已恢复该临时字段。
- 使用虚拟 IPC 数据检查 1280×720、390×844 中文浅色和 1366×768 英文深色弹窗，确认长模型名无横向溢出、键盘可执行仅导入、提交中禁用按钮、失败后保留重试入口。复用已有弹窗和按钮动效，未增加动效依赖。

以上为 Pi 独立实现阶段的本地验证记录，原基线为 `9f46e8b`。v3.20.204 已整合网站 Logo，并补充 Pi 链接解析到保存/启用的 Logo 保留断言；发布检查以该版本对应的 GitHub Actions 和发布说明为准。Windows 10/11 真机、系统协议唤起及真实 Pi/NewAPI 请求仍未验收。
