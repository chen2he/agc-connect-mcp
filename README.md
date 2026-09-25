# agc-connect-mcp

[English](README.en.md) | 中文

面向华为鸿蒙开发者的 MCP（Model Context Protocol）服务。装这一个，就能在 Claude Code、Cursor、VS Code、Codex、Gemini CLI、Trae、DevEco Studio 等 AI 工具里：

- **操作 AppGallery Connect**：查询应用和审核状态、上传软件包、提交发布、查看并回复评论、查评分、导出报表，以及调用其余全部 [Connect API](https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-Guides/agcapi-overview-0000001158245083)（PMS 商品、证书 / Profile / 设备、测试版本、域名、资质审核、协议管理等）。
- **查询鸿蒙官方文档**：内置华为官方「[鸿蒙开发者知识 MCP](https://developer.huawei.com/consumer/cn/doc/start/hosknowledgemcp-0000002664603963)」，可检索 API 参考、开发指南、最佳实践、FAQ、上架规范等（与官网准实时同步），无需再单独配置。

> 本项目为社区开源项目，与华为公司无关，也未获其背书。AppGallery Connect、HarmonyOS 为华为技术有限公司的商标。

## 功能

| 工具 | 作用 | 需要 AGC 凭据 |
|---|---|---|
| `harmonyos_search_docs` / `harmonyos_get_docs` | 检索鸿蒙官方文档、获取全文 | 否 |
| `agc_search_api` / `agc_get_api_doc` | 搜索内置的 Connect API 目录（约 200 个接口、450 篇文档），在线读取接口参数文档 | 否 |
| `agc_auth_status` | 检查凭据与站点配置 | — |
| `agc_list_apps` / `agc_get_app_id` | 列出所有项目与应用；包名 → appId | 是 |
| `agc_get_app_info` | 应用详情（基本信息、多语言、审核意见、分阶段发布） | 是 |
| `agc_upload_file` | 上传本地文件（软件包、图标、截图、视频、资质材料），返回 objectId | 是 |
| `agc_update_app_package` | 上传并关联软件包（HarmonyOS `.app` / Android `.apk` `.aab`） | 是 |
| `agc_get_package_compile_status` | 查询软件包解析状态 | 是 |
| `agc_submit_app` | 提交审核发布（支持定时上架、分阶段发布） | 是 |
| `agc_list_reviews` / `agc_reply_review` / `agc_get_ratings` | 评论查询与回复、评分统计 | 是 |
| `agc_get_report` | 导出下载安装、安装失败、用户分析、付费等报表，可下载到本地并预览 | 是 |
| `agc_request` | 以当前凭据调用任意 Connect API，覆盖所有没有专用工具的接口 | 是 |
| `intents_share_event` / `intents_revoke_event` | 意图框架（Intents Kit）意图共享、事件撤销：向小艺推送或撤回事件提醒 | 需应用凭据（见下文） |

大多数工具有 `platform` 参数：`harmonyos` 表示 HarmonyOS 5 及以上的应用和元服务，`android` 表示 Android 以及 HarmonyOS 4 及以下。

## 安装

需要 Node.js 20.11 或以上。

各客户端的配置都是同一套「命令 + 参数 + 环境变量」：

```text
command: npx
args:    -y github:chen2he/agc-connect-mcp
env:     AGC_SERVICE_ACCOUNT_FILE=/path/to/service-account.json
         AGC_CLIENT_FILE=/path/to/api-client.json
```

`npx` 会直接从 GitHub 下载本项目并自动编译（仅首次运行需要，之后使用缓存）。两个 `env` 都可以省略：不配置 AGC 凭据时，文档检索类工具照常可用。凭据的获取方法见[配置 AGC 凭据](#配置-agc-凭据)。

<details>
<summary>从源码安装</summary>

```bash
git clone https://github.com/chen2he/agc-connect-mcp.git
cd agc-connect-mcp
npm install   # 会自动编译到 dist/
```

然后把下文各配置中的 `npx -y github:chen2he/agc-connect-mcp` 换成 `node /绝对路径/agc-connect-mcp/dist/index.js`。

</details>

### Claude Code

```bash
claude mcp add agc -s user \
  -e AGC_SERVICE_ACCOUNT_FILE=/path/to/service-account.json \
  -e AGC_CLIENT_FILE=/path/to/api-client.json \
  -- npx -y github:chen2he/agc-connect-mcp
```

### Codex CLI

```bash
codex mcp add agc \
  --env AGC_SERVICE_ACCOUNT_FILE=/path/to/service-account.json \
  --env AGC_CLIENT_FILE=/path/to/api-client.json \
  -- npx -y github:chen2he/agc-connect-mcp
```

也可以直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.agc]
command = "npx"
args = ["-y", "github:chen2he/agc-connect-mcp"]
env = { AGC_SERVICE_ACCOUNT_FILE = "/path/to/service-account.json", AGC_CLIENT_FILE = "/path/to/api-client.json" }
```

### 使用 `mcpServers` JSON 的客户端

Claude Desktop、Cursor、Windsurf、Cline / Roo Code、Gemini CLI、Trae、DevEco Studio（CodeGenie）、Cherry Studio 等都用下面这种格式：

```json
{
  "mcpServers": {
    "agc": {
      "command": "npx",
      "args": ["-y", "github:chen2he/agc-connect-mcp"],
      "env": {
        "AGC_SERVICE_ACCOUNT_FILE": "/path/to/service-account.json",
        "AGC_CLIENT_FILE": "/path/to/api-client.json"
      }
    }
  }
}
```

| 客户端 | 配置文件位置 |
|---|---|
| Claude Desktop | macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；Windows：`%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | 全局 `~/.cursor/mcp.json`，或项目内 `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Cline / Roo Code | 插件面板 → MCP Servers → 编辑配置 |
| Trae / DevEco Studio / Cherry Studio 等 | 在各自的 MCP 设置里添加上面的 JSON |

### VS Code（GitHub Copilot Agent 模式）

`.vscode/mcp.json`，或者用户设置里的 MCP 配置：

```json
{
  "servers": {
    "agc": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:chen2he/agc-connect-mcp"],
      "env": { "AGC_SERVICE_ACCOUNT_FILE": "/path/to/service-account.json" }
    }
  }
}
```

> **Windows 用户**：少数客户端无法直接启动 `npx`，可以把命令改成 `"command": "cmd", "args": ["/c", "npx", "-y", "github:chen2he/agc-connect-mcp"]`。

## 配置 AGC 凭据

在 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html) 打开「用户与访问 → API 密钥 → Connect API」创建凭据。两种凭据可以同时配置，服务会**按每个接口文档所支持的鉴权方式自动选用**，两种都支持时优先用 Service Account。

| 凭据 | 创建方式 | 环境变量 |
|---|---|---|
| Service Account | 「Service Account」页签 → 创建，类型选**开发者级**，会自动下载 `*private.json` | `AGC_SERVICE_ACCOUNT_FILE`：该 JSON 的路径 |
| API 客户端 | 「API 客户端」页签 → 创建，**项目保持 N/A**，下载凭据 JSON | `AGC_CLIENT_FILE`：JSON 路径（需含 `client_id`、`client_secret`）；或者 `AGC_CLIENT_ID` + `AGC_CLIENT_SECRET` |

根据官方文档，两种凭据能调用的接口有差别，建议两种都配上：

| 接口 | Service Account | API 客户端 |
|---|---|---|
| HarmonyOS 发布 / 上传 / 测试 / 证书 Profile / 域名 | ✅ | ✅ |
| 大部分报表、包名查 appId、项目与应用列表 | ✅ | ✅ |
| 评论与评分、PMS 商品、Android 发布（v2 接口） | ❌ | ✅ |
| 团队列表、应用简略信息、证书指纹查询 / 添加 | ❌ | ❌（仅 OAuth 客户端，面向平台类开发者） |

凭据的角色决定能调用哪些接口，例如发布需要「APP 管理员」及以上，报表需要「运营」。配置好后，在 AI 工具里让它调用 `agc_auth_status` 就能验证。

### 意图框架（Intents Kit）的应用凭据

`intents_*` 工具调用的是 `hag.cloud.huawei.com` 上的意图框架服务端接口，用的是**每个应用自己的** Client ID / Client Secret（AGC「项目设置 → 应用」里查看），不是上面的 Connect API 凭据。可以用一个 JSON 文件配置多个应用：

```json
{
  "my-app": { "client_id": "应用的 Client ID", "client_secret": "应用的 Client Secret" }
}
```

然后设置 `AGC_APP_CLIENTS_FILE=/path/to/app-clients.json`，调用时用 `app` 参数指定别名（只配了一个应用时可以省略）。只有一个应用时，也可以直接用 `AGC_APP_CLIENT_ID` + `AGC_APP_CLIENT_SECRET`。

> 意图注册、特性配置、配置检查与提交审核都在**小艺开放平台**的网页端完成，华为没有开放这部分的管理接口。小艺开放平台对开发者开放的服务端接口只有意图共享 / 事件撤销（已支持）和账号绑定 / 解绑通知。

### 其他环境变量

| 变量 | 说明 |
|---|---|
| `AGC_SITE` | `cn`（默认）/ `de` / `sg` / `ru`，分别对应中国、德国、新加坡、俄罗斯站点 |
| `AGC_READ_ONLY` | 设为 `true` 后禁止一切写操作（上传、提交、回复、非查询类请求） |
| `AGC_KNOWLEDGE_MCP` | 设为 `off` 可关闭鸿蒙知识库工具 |
| `AGC_KNOWLEDGE_MCP_URL` | 自定义知识库 MCP 地址（默认为华为官方地址） |
| `AGC_DOCS_CACHE_DIR` | Connect API 文档缓存目录，默认 `~/.cache/agc-connect-mcp/docs`（缓存 7 天） |
| `AGC_TIMEOUT_MS` | 单次请求超时，默认 120000 |

## 使用示例

- 「ArkUI 的 Navigation 怎么跨包路由？给我官方示例。」
- 「列出我在 AGC 上的所有应用和它们的审核状态。」
- 「把 `build/outputs/default/entry-default-signed.app` 上传到 com.example.app，解析完成后提交发布，备注写‘修复若干问题’。」
- 「导出过去 30 天按国家分组的下载安装报表，告诉我哪几个国家增长最快。」
- 「看看最近一个月的 1～2 星差评，帮我起草回复。」（提交回复前会先请你确认）
- 「用 PMS API 创建一个 6 元的消耗型商品。」（会先查接口文档，再通过 `agc_request` 调用）

## 注意事项

- **评论与评分**只对已正式上架的应用有数据。审核中或未发布的应用会返回 `50010028`（“应用不属于该开发者”）。
- **PMS 接口**要把 `appId` 放在**请求头**里（`agc_request` 的 `headers` 参数）。`agc_get_api_doc` 会列出这类需要自行传入的请求头。
- **报表**返回的下载地址约 5 分钟后失效，需要报表内容时直接用 `downloadTo` 参数下载。
- **意图共享**的 `intentEntityInfo` 字段因意图而异，可以先用 `harmonyos_search_docs` 查「<意图名> 意图 Schema」；推送的是面向真实用户的提醒，务必确认 `openId` / `sid` 正确。
- 提交发布、回复评论、推送意图事件、下架、删除等**会对外生效**的操作，工具说明里要求 AI 先向你确认；也可以设置 `AGC_READ_ONLY=true`，从根本上禁止写操作。

## 安全

- Service Account 的 JWT 在本地用 PS256 签名，私钥不会发送到任何地方；带凭据的请求只会发往 `*.huawei.com`。
- 建议通过文件路径（`AGC_SERVICE_ACCOUNT_FILE` / `AGC_CLIENT_FILE`）提供凭据，不要把密钥直接写进客户端的配置 JSON，凭据文件的权限建议设为 `600`。
- 本仓库不包含任何华为文档正文，只有接口元数据（方法、路径、标题、鉴权方式）；文档正文在运行时从华为开发者文档中心拉取。

## 开发

```bash
npm install
npm test                 # 编译并运行端到端测试（本地模拟服务器，不需要网络和真实凭据）
npm run update-catalog   # 从华为文档中心重新生成 data/ 下的接口目录；加 -- --refresh 忽略本地缓存
```

目录结构：

```text
src/
  index.ts           MCP 服务入口
  tools.ts           全部工具定义
  client.ts          Connect API 请求、上传、下载
  auth.ts            Service Account JWT / API 客户端 token
  catalog.ts         接口目录检索、按接口选择鉴权方式
  portal.ts          华为文档中心接口与文档缓存
  html2md.ts         文档 HTML → Markdown
  knowledge.ts       鸿蒙开发者知识 MCP 代理
  hag.ts             意图框架（Intents Kit）服务端接口与应用级 token
  update-catalog.ts  维护脚本：生成 data/
data/                接口目录（元数据）
test/                端到端测试
```

## 许可证

[MIT](LICENSE)
