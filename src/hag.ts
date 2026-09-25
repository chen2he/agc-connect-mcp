import { existsSync, readFileSync } from "node:fs";

/**
 * Intents Kit（意图框架）服务端接口，部署在 hag.cloud.huawei.com。
 * 与 Connect API 不同，这些接口使用“应用自己的” Client ID / Client Secret 换取应用级 AccessToken，
 * 请求头 x-appid 填该应用的 Client ID。
 */
export const DEFAULT_HAG_BASE_URL = "https://hag.cloud.huawei.com";
export const DEFAULT_APP_TOKEN_URL = "https://oauth-login.cloud.huawei.com/oauth2/v3/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface AppClient {
  clientId: string;
  clientSecret: string;
}

export interface HagConfig {
  apps: Map<string, AppClient>;
  problems: string[];
  baseUrl: string;
  tokenUrl: string;
  timeoutMs: number;
}

/**
 * 应用凭据来源：
 * - AGC_APP_CLIENTS_FILE：JSON 文件，{"<应用别名或 appId>": {"client_id": "...", "client_secret": "..."}}
 * - AGC_APP_CLIENT_ID + AGC_APP_CLIENT_SECRET：单个应用（别名为 default）
 */
export function loadHagConfig(env: NodeJS.ProcessEnv = process.env, timeoutMs = 120_000): HagConfig {
  const apps = new Map<string, AppClient>();
  const problems: string[] = [];
  const file = env.AGC_APP_CLIENTS_FILE?.replace(/^~(?=\/)/, env.HOME ?? "~");
  if (file) {
    if (!existsSync(file)) {
      problems.push(`AGC_APP_CLIENTS_FILE 文件不存在：${file}`);
    } else {
      const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
      for (const [name, v] of Object.entries(json)) {
        const clientId = v?.client_id ?? v?.clientId;
        const clientSecret = v?.client_secret ?? v?.clientSecret;
        if (!clientId || !clientSecret) throw new Error(`AGC_APP_CLIENTS_FILE 中“${name}”缺少 client_id / client_secret`);
        apps.set(name, { clientId: String(clientId), clientSecret: String(clientSecret) });
      }
    }
  }
  if (env.AGC_APP_CLIENT_ID && env.AGC_APP_CLIENT_SECRET) {
    apps.set("default", { clientId: env.AGC_APP_CLIENT_ID, clientSecret: env.AGC_APP_CLIENT_SECRET });
  }
  return {
    apps,
    problems,
    baseUrl: (env.AGC_HAG_BASE_URL ?? DEFAULT_HAG_BASE_URL).replace(/\/+$/, ""),
    tokenUrl: env.AGC_APP_TOKEN_URL ?? DEFAULT_APP_TOKEN_URL,
    timeoutMs,
  };
}

export interface HagResponse {
  status: number;
  data: unknown;
}

export class HagClient {
  private tokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(readonly config: HagConfig) {}

  appNames(): string[] {
    return [...this.config.apps.keys()];
  }

  /** 按别名选应用；只配置了一个应用时可省略。 */
  resolve(app?: string): { name: string; client: AppClient } {
    const names = this.appNames();
    if (!names.length) {
      throw new Error(
        (this.config.problems.length ? `${this.config.problems.join("；")}。` : "") +
          "未配置应用凭据。意图框架接口需要应用自己的 Client ID / Client Secret（AGC“项目设置 > 应用”中查看），" +
          "请设置 AGC_APP_CLIENTS_FILE（JSON：{\"别名\": {\"client_id\": \"…\", \"client_secret\": \"…\"}}）或 AGC_APP_CLIENT_ID + AGC_APP_CLIENT_SECRET。",
      );
    }
    const name = app ?? (names.length === 1 ? names[0] : undefined);
    if (!name) throw new Error(`配置了多个应用，请用 app 参数指定：${names.join(" / ")}`);
    const client = this.config.apps.get(name) ?? [...this.config.apps.values()].find((c) => c.clientId === name);
    if (!client) throw new Error(`未找到应用凭据“${name}”，可选：${names.join(" / ")}`);
    return { name, client };
  }

  async token(client: AppClient, forceRefresh = false): Promise<string> {
    const cached = this.tokens.get(client.clientId);
    if (!forceRefresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.value;
    const res = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.clientId, client_secret: client.clientSecret }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const text = await res.text();
    let json: { access_token?: string; expires_in?: number } = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* 下面统一报错 */
    }
    if (!res.ok || !json.access_token) {
      throw new Error(`获取应用级 AccessToken 失败（HTTP ${res.status}，client_id=${client.clientId}）：${text.slice(0, 300)}`);
    }
    const value = json.access_token;
    this.tokens.set(client.clientId, { value, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
    return value;
  }

  async post(path: string, body: unknown, opts: { app?: string; headers?: Record<string, string> } = {}): Promise<HagResponse> {
    const { client } = this.resolve(opts.app);
    const send = async (forceRefresh: boolean) =>
      fetch(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${await this.token(client, forceRefresh)}`,
          "x-appid": client.clientId,
          ...opts.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    const text = await res.text();
    let data: unknown = text || null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* 保留原始文本 */
    }
    return { status: res.status, data };
  }
}

/** 请求时间：UTC，yyyyMMddHHmmssSSS（17 位数字）。 */
export function hagRequestTime(d = new Date()): string {
  return d.toISOString().replace(/\D/g, "").slice(0, 17);
}
