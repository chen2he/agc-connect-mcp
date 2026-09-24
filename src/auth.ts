import { constants, createPrivateKey, sign } from "node:crypto";
import type { AuthMode, Config, ServiceAccount } from "./config.js";

const JWT_AUD = "https://oauth-login.cloud.huawei.com/oauth2/v3/token";
const JWT_TTL_SECONDS = 3600;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** 按文档用 PS256（SHA256withRSA/PSS）签名生成 Service Account 鉴权 JWT。 */
export function createServiceAccountJwt(account: ServiceAccount, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { kid: account.key_id, typ: "JWT", alg: "PS256" };
  const payload = { aud: JWT_AUD, iss: account.sub_account, exp: nowSeconds + JWT_TTL_SECONDS, iat: nowSeconds };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const pem = account.private_key.includes("BEGIN")
    ? account.private_key
    : `-----BEGIN PRIVATE KEY-----\n${account.private_key}\n-----END PRIVATE KEY-----\n`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(pem),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return `${signingInput}.${b64url(signature)}`;
}

export class AuthProvider {
  private cache = new Map<string, CachedToken>();

  constructor(private readonly config: Config) {}

  /** 已配置可用的鉴权方式。 */
  modes(): AuthMode[] {
    const c = this.config.credentials;
    return [c.serviceAccount && "service_account", c.apiClient && "api_client"].filter(Boolean) as AuthMode[];
  }

  describe(): string {
    const c = this.config.credentials;
    const parts: string[] = [];
    if (c.serviceAccount) {
      const a = c.serviceAccount.account;
      parts.push(`Service Account（sub_account=${a.sub_account}, key_id=${a.key_id}, 来源=${c.serviceAccount.source}）`);
    }
    if (c.apiClient) parts.push(`API 客户端（client_id=${c.apiClient.clientId}, 来源=${c.apiClient.source}）`);
    return parts.length ? parts.join(" + ") : "未配置";
  }

  /**
   * 返回调用 Connect API 所需的鉴权请求头。
   * preferred 为接口支持的鉴权方式（按优先级），会在已配置的凭据中选第一个可用的；都不可用时退回任一已配置凭据。
   */
  async headers(
    baseUrl: string,
    opts: { preferred?: AuthMode[]; forceRefresh?: boolean } = {},
  ): Promise<{ mode: AuthMode; headers: Record<string, string> }> {
    const available = this.modes();
    if (!available.length) {
      const problems = this.config.credentials.problems;
      throw new Error(
        (problems.length ? `${problems.join("；")}。` : "未配置 AGC 凭据。") +
          "请设置 AGC_SERVICE_ACCOUNT_FILE（推荐，Service Account 私钥 JSON 路径），" +
          "和/或 AGC_CLIENT_FILE（含 client_id、client_secret 的 JSON）或 AGC_CLIENT_ID + AGC_CLIENT_SECRET（API 客户端）。",
      );
    }
    const mode = (opts.preferred ?? available).find((m) => available.includes(m)) ?? available[0];
    const key = mode === "service_account" ? "sa" : `client@${baseUrl}`;
    let cached = this.cache.get(key);
    if (opts.forceRefresh || !cached || cached.expiresAt - REFRESH_MARGIN_MS < Date.now()) {
      const c = this.config.credentials;
      cached =
        mode === "service_account"
          ? this.issueJwt(c.serviceAccount!.account)
          : await this.fetchClientToken(baseUrl, c.apiClient!.clientId, c.apiClient!.clientSecret);
      this.cache.set(key, cached);
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${cached.value}` };
    if (mode === "api_client") headers.client_id = this.config.credentials.apiClient!.clientId;
    return { mode, headers };
  }

  private issueJwt(account: ServiceAccount): CachedToken {
    return { value: createServiceAccountJwt(account), expiresAt: Date.now() + JWT_TTL_SECONDS * 1000 };
  }

  private async fetchClientToken(baseUrl: string, clientId: string, clientSecret: string): Promise<CachedToken> {
    const res = await fetch(`${baseUrl}/api/oauth2/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const text = await res.text();
    let json: { access_token?: string; expires_in?: number; ret?: unknown; et?: unknown } = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 响应，下面统一报错 */
    }
    if (!res.ok || !json.access_token) {
      throw new Error(`获取 AGC access_token 失败（HTTP ${res.status}）：${text.slice(0, 500)}`);
    }
    return { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 172800) * 1000 };
  }
}
