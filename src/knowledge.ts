import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** 华为官方“鸿蒙开发者知识 MCP”（公开、无需鉴权）。 */
export const DEFAULT_KNOWLEDGE_URL = "https://connect-api.cloud.huawei.com/api/developerknowledge/mcp";

/** 懒连接的远程 MCP 客户端；连接断开时自动重连一次。 */
export class KnowledgeClient {
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(readonly url: string) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({ name: "agc-connect-mcp", version: "0.1.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.connect();
        const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
        const content = res.content as Array<{ type: string; text?: string }> | undefined;
        const textPart = content?.find((c) => c.type === "text")?.text;
        if (res.isError) throw new Error(textPart ?? "远程知识库返回错误");
        if (res.structuredContent) return res.structuredContent;
        try {
          return textPart ? JSON.parse(textPart) : null;
        } catch {
          return textPart;
        }
      } catch (err) {
        await this.client?.close().catch(() => undefined);
        this.client = undefined;
        if (attempt >= 1) throw new Error(`调用鸿蒙开发者知识 MCP 失败（${this.url}）：${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async search(query: string): Promise<unknown> {
    return this.call("searchDocuments", { SearchDocumentsReq: { query } });
  }

  async getDocuments(names: string[]): Promise<unknown> {
    return this.call("getDocumentsById", { GetDocumentsByIdRequest: { names } });
  }
}
