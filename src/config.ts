import { existsSync, readFileSync } from "node:fs";

export const SITES = {
  cn: "connect-api.cloud.huawei.com",
  de: "connect-api-dre.cloud.huawei.com",
  sg: "connect-api-dra.cloud.huawei.com",
  ru: "connect-api-drru.cloud.huawei.com",
} as const;
export type Site = keyof typeof SITES;

export interface ServiceAccount {
  key_id: string;
  private_key: string;
  sub_account: string;
  token_uri?: string;
}

export type AuthMode = "service_account" | "api_client";

export interface Credentials {
  serviceAccount?: { account: ServiceAccount; source: string };
  apiClient?: { clientId: string; clientSecret: string; source: string };
  /** 配置了但不可用的凭据说明（如文件不存在） */
  problems: string[];
}

export interface Config {
  credentials: Credentials;
  site: Site;
  /** API 源地址，如 https://connect-api.cloud.huawei.com */
  baseUrl: string;
  readOnly: boolean;
  timeoutMs: number;
}

const expandHome = (p: string, env: NodeJS.ProcessEnv) => p.replace(/^~(?=\/)/, env.HOME ?? "~");

function readJsonFile(file: string, what: string, problems: string[]): Record<string, unknown> | undefined {
  if (!existsSync(file)) {
    problems.push(`${what} 文件不存在：${file}`);
    return undefined;
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function asServiceAccount(json: Record<string, unknown>, source: string): ServiceAccount {
  if (!json.key_id || !json.private_key || !json.sub_account) {
    throw new Error(`Service Account 凭据（${source}）缺少 key_id / private_key / sub_account 字段`);
  }
  return json as unknown as ServiceAccount;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const credentials: Credentials = { problems: [] };

  if (env.AGC_SERVICE_ACCOUNT_FILE) {
    const file = expandHome(env.AGC_SERVICE_ACCOUNT_FILE, env);
    const json = readJsonFile(file, "AGC_SERVICE_ACCOUNT_FILE", credentials.problems);
    if (json) credentials.serviceAccount = { account: asServiceAccount(json, file), source: file };
  } else if (env.AGC_SERVICE_ACCOUNT_JSON) {
    const source = "AGC_SERVICE_ACCOUNT_JSON";
    credentials.serviceAccount = { account: asServiceAccount(JSON.parse(env.AGC_SERVICE_ACCOUNT_JSON), source), source };
  }

  if (env.AGC_CLIENT_FILE) {
    const file = expandHome(env.AGC_CLIENT_FILE, env);
    const json = readJsonFile(file, "AGC_CLIENT_FILE", credentials.problems);
    if (json) {
      const clientId = json.client_id ?? json.clientId;
      const clientSecret = json.client_secret ?? json.clientSecret ?? json.secret;
      if (!clientId || !clientSecret) throw new Error(`API 客户端凭据（${file}）需包含 client_id 与 client_secret 字段`);
      credentials.apiClient = { clientId: String(clientId), clientSecret: String(clientSecret), source: file };
    }
  } else if (env.AGC_CLIENT_ID && env.AGC_CLIENT_SECRET) {
    credentials.apiClient = { clientId: env.AGC_CLIENT_ID, clientSecret: env.AGC_CLIENT_SECRET, source: "AGC_CLIENT_ID" };
  }

  const site = (env.AGC_SITE ?? "cn").toLowerCase() as Site;
  if (!(site in SITES)) {
    throw new Error(`AGC_SITE 取值无效：${env.AGC_SITE}，可选 ${Object.keys(SITES).join(" / ")}`);
  }
  return {
    credentials,
    site,
    baseUrl: (env.AGC_API_BASE_URL ?? `https://${SITES[site]}`).replace(/\/+$/, ""),
    readOnly: /^(1|true|yes)$/i.test(env.AGC_READ_ONLY ?? ""),
    timeoutMs: Number(env.AGC_TIMEOUT_MS ?? 120_000),
  };
}
