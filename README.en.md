# agc-connect-mcp

English | [中文](README.md)

An MCP (Model Context Protocol) server for Huawei HarmonyOS developers. One install gives your AI agent (Claude Code, Cursor, VS Code, Codex, Gemini CLI, Trae, DevEco Studio, …) two capabilities:

- **AppGallery Connect operations**: list apps and review status, upload packages, submit releases, read and reply to reviews, get ratings, export reports. It can also call any other [Connect API](https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-Guides/agcapi-overview-0000001158245083) endpoint (IAP products, certificates, profiles and devices, test versions, domains, qualification reviews, agreements, …).
- **HarmonyOS documentation search**: proxies Huawei's official [HarmonyOS Developer Knowledge MCP](https://developer.huawei.com/consumer/cn/doc/start/hosknowledgemcp-0000002664603963). It searches API references, guides, best practices, FAQs and store policies, kept in near-real-time sync with the official site. No separate setup needed.

> This is a community project. It is not affiliated with or endorsed by Huawei. AppGallery Connect and HarmonyOS are trademarks of Huawei Technologies Co., Ltd.

## Tools

| Tool | Purpose | Needs AGC credentials |
|---|---|---|
| `harmonyos_search_docs` / `harmonyos_get_docs` | Search official HarmonyOS docs, fetch full text | No |
| `agc_search_api` / `agc_get_api_doc` | Search the built-in Connect API catalog (~200 endpoints, 450 docs); read an endpoint's parameter docs (fetched live) | No |
| `agc_auth_status` | Check credentials and site | — |
| `agc_list_apps` / `agc_get_app_id` | All projects and apps; package name → appId | Yes |
| `agc_get_app_info` | App details (metadata, languages, review feedback, phased release) | Yes |
| `agc_upload_file` | Upload a local file (package, icon, screenshot, video, documents) and get an objectId | Yes |
| `agc_update_app_package` | Upload and attach a package (HarmonyOS `.app`, Android `.apk` / `.aab`) | Yes |
| `agc_get_package_compile_status` | Package processing status | Yes |
| `agc_submit_app` | Submit for review and release (scheduled or phased) | Yes |
| `agc_list_reviews` / `agc_reply_review` / `agc_get_ratings` | Reviews, replies, rating stats | Yes |
| `agc_get_report` | Export download, install-failure, user-analysis and payment reports; optionally download and preview | Yes |
| `agc_request` | Call any Connect API endpoint with your credentials | Yes |
| `intents_share_event` / `intents_revoke_event` | Intents Kit event sharing and revocation: push or withdraw event reminders to Celia (小艺) | App credentials (see below) |

Most tools take a `platform` argument. Use `harmonyos` for HarmonyOS 5+ apps and atomic services, and `android` for Android and HarmonyOS 4 or earlier.

## Installation

Requires Node.js 20.11+.

Every client uses the same command, arguments and environment variables:

```text
command: npx
args:    -y github:chen2he/agc-connect-mcp
env:     AGC_SERVICE_ACCOUNT_FILE=/path/to/service-account.json
         AGC_CLIENT_FILE=/path/to/api-client.json
```

`npx` fetches this project straight from GitHub and builds it (first run only; later runs use the cache). Both env vars are optional. Without AGC credentials, the documentation tools still work. See [AGC credentials](#agc-credentials) for how to get them.

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/chen2he/agc-connect-mcp.git
cd agc-connect-mcp
npm install   # builds dist/ automatically
```

Then replace `npx -y github:chen2he/agc-connect-mcp` in the configs below with `node /absolute/path/agc-connect-mcp/dist/index.js`.

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

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.agc]
command = "npx"
args = ["-y", "github:chen2he/agc-connect-mcp"]
env = { AGC_SERVICE_ACCOUNT_FILE = "/path/to/service-account.json", AGC_CLIENT_FILE = "/path/to/api-client.json" }
```

### Clients using the `mcpServers` JSON format

This format works for Claude Desktop, Cursor, Windsurf, Cline / Roo Code, Gemini CLI, Trae, DevEco Studio (CodeGenie), Cherry Studio and others:

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

| Client | Config file |
|---|---|
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Cline / Roo Code | Extension panel → MCP Servers → Edit configuration |
| Trae / DevEco Studio / Cherry Studio | Add the JSON above in the client's MCP settings |

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` or the MCP section of your user settings:

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

> **Windows**: a few clients can't spawn `npx` directly. Use `"command": "cmd", "args": ["/c", "npx", "-y", "github:chen2he/agc-connect-mcp"]`.

## AGC credentials

In [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html), go to **Users and permissions → API key → Connect API**. You can configure both credential types. The server picks one **per endpoint, based on the auth methods that endpoint's documentation lists**, and prefers the Service Account when both are allowed.

| Credential | How to create | Env var |
|---|---|---|
| Service Account | "Service Account" tab → Create, type **Developer**. A `*private.json` key file downloads automatically | `AGC_SERVICE_ACCOUNT_FILE`: path to that JSON |
| API client | "API client" tab → Create, **keep project = N/A**, then download the credential JSON | `AGC_CLIENT_FILE`: path to a JSON with `client_id` and `client_secret`, or `AGC_CLIENT_ID` + `AGC_CLIENT_SECRET` |

The two credential types can reach different endpoints (per the official docs), so configuring both is recommended:

| Endpoints | Service Account | API client |
|---|---|---|
| HarmonyOS publishing, upload, testing, certificates and profiles, domains | ✅ | ✅ |
| Most reports, package → appId, projects and apps | ✅ | ✅ |
| Reviews and ratings, IAP products (PMS), Android publishing (v2) | ❌ | ✅ |
| Team list, app brief info, certificate fingerprints | ❌ | ❌ (OAuth clients only, for platform partners) |

The credential's role determines which APIs it may call. For example, publishing needs *App administrator* or above, and reports need *Operations*. Ask your agent to run `agc_auth_status` to verify the setup.

### App credentials for Intents Kit

The `intents_*` tools call Intents Kit's server APIs on `hag.cloud.huawei.com`. They use **each app's own** Client ID / Client Secret (AGC → Project settings → App), not the Connect API credentials above. One JSON file can hold several apps:

```json
{
  "my-app": { "client_id": "<app Client ID>", "client_secret": "<app Client Secret>" }
}
```

Set `AGC_APP_CLIENTS_FILE=/path/to/app-clients.json` and pick an app with the `app` argument (optional when only one is configured). For a single app you can use `AGC_APP_CLIENT_ID` + `AGC_APP_CLIENT_SECRET` instead.

> Intent registration, feature configuration, checks and review submission happen in the **Xiaoyi (Celia) Open Platform** web console; Huawei offers no management API for them. The platform's only developer-callable server APIs are intent sharing / event revocation (supported here) and account bind / unbind notifications.

### Other environment variables

| Variable | Description |
|---|---|
| `AGC_SITE` | `cn` (default) / `de` / `sg` / `ru`: China, Germany, Singapore or Russia site |
| `AGC_READ_ONLY` | `true` blocks every write operation (uploads, submissions, replies, non-query requests) |
| `AGC_KNOWLEDGE_MCP` | `off` disables the HarmonyOS knowledge tools |
| `AGC_KNOWLEDGE_MCP_URL` | Custom knowledge MCP endpoint (defaults to Huawei's official one) |
| `AGC_DOCS_CACHE_DIR` | Cache for Connect API docs, default `~/.cache/agc-connect-mcp/docs` (7-day TTL) |
| `AGC_TIMEOUT_MS` | Per-request timeout, default 120000 |

## Notes

- **Reviews and ratings** only exist for published apps. Apps that are in review or unreleased return `50010028` ("app does not belong to developer").
- **IAP (PMS) endpoints** expect `appId` as a **request header** (the `headers` argument of `agc_request`). `agc_get_api_doc` lists such non-auth headers.
- **Report** download URLs expire after about 5 minutes. Pass `downloadTo` to save the file right away.
- **Intent sharing**: `intentEntityInfo` fields depend on the intent; look up "<intent name> 意图 Schema" with `harmonyos_search_docs` first. Events reach real users, so double-check `openId` / `sid`.
- Tool descriptions tell the agent to ask you before any **externally visible action**: submitting a release, replying to a review, pushing intent events, taking an app down, deleting. `AGC_READ_ONLY=true` blocks writes entirely.

## Security

- The Service Account JWT is signed locally (PS256), and the private key never leaves your machine. Authenticated requests are only sent to `*.huawei.com`.
- Pass credentials as file paths (`AGC_SERVICE_ACCOUNT_FILE` / `AGC_CLIENT_FILE`) rather than pasting secrets into client configs, and keep those files at `chmod 600`.
- This repository contains no Huawei documentation text, only endpoint metadata (method, path, title, auth modes). Documentation is fetched from Huawei's developer portal at runtime.

## Development

```bash
npm install
npm test                 # build + end-to-end tests against local mocks (no network or real credentials needed)
npm run update-catalog   # regenerate data/ from Huawei's doc portal; add `-- --refresh` to bypass the local cache
```

## License

[MIT](LICENSE)
