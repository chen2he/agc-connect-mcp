#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuthProvider } from "./auth.js";
import { AgcClient } from "./client.js";
import { loadConfig } from "./config.js";
import { HagClient, loadHagConfig } from "./hag.js";
import { DEFAULT_KNOWLEDGE_URL, KnowledgeClient } from "./knowledge.js";
import { registerIntentsTools, registerKnowledgeTools, registerTools } from "./tools.js";

const INSTRUCTIONS = `华为鸿蒙开发者工具集：AppGallery Connect（AGC）Connect API + 鸿蒙开发者知识库。
- 鸿蒙开发问题（ArkTS/ArkUI、Kit、API、DevEco Studio、上架规范等）：harmonyos_search_docs → harmonyos_get_docs 查官方文档。
- AGC 常用操作有专用工具：项目与应用列表、应用详情、上传文件、更新软件包、查询编译状态、提交发布、评论与评分、报表导出。
- 其他接口（PMS 商品、Provisioning 证书/Profile/设备、Testing 测试版本、域名、资质审核、协议管理、应用信息更新等）：
  先 agc_search_api 找端点 → agc_get_api_doc 看参数 → agc_request 调用。
- platform=harmonyos 对应 HarmonyOS 5 及以上应用/元服务（多为 v3 接口）；platform=android 对应 Android 与 HarmonyOS 4 及以下（v2 接口）。
- 意图框架（Intents Kit）服务端推送：intents_share_event / intents_revoke_event（需应用自己的 Client ID/Secret）。意图注册、特性配置与审核只能在小艺开放平台网页端完成，没有开放接口。
- 提交发布、回复评论、下架、删除、推送意图事件等对外生效的操作，执行前先向用户确认。`;

async function main() {
  const config = loadConfig();
  const client = new AgcClient(config, new AuthProvider(config));
  const server = new McpServer({ name: "agc-connect-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const hag = new HagClient(loadHagConfig(process.env, config.timeoutMs));
  registerTools(server, client, hag);
  registerIntentsTools(server, hag, config.readOnly);
  const knowledgeUrl = process.env.AGC_KNOWLEDGE_MCP_URL ?? DEFAULT_KNOWLEDGE_URL;
  const knowledgeEnabled = !/^(0|false|no|off)$/i.test(process.env.AGC_KNOWLEDGE_MCP ?? "");
  if (knowledgeEnabled) registerKnowledgeTools(server, new KnowledgeClient(knowledgeUrl));
  await server.connect(new StdioServerTransport());
  console.error(`[agc-mcp] 已启动：凭据=${client.auth.describe()}，地址=${config.baseUrl}${config.readOnly ? "，只读模式" : ""}${knowledgeEnabled ? "，已启用鸿蒙知识库" : ""}${hag.appNames().length ? `，意图框架应用=${hag.appNames().join("/")}` : ""}`);
}

main().catch((err) => {
  console.error("[agc-mcp] 启动失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
