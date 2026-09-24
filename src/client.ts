import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AuthProvider } from "./auth.js";
import { findEndpoint } from "./catalog.js";
import { SITES, type AuthMode, type Config, type Site } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  site?: Site;
  /** 强制使用某种凭据；默认按接口文档支持的鉴权方式自动选择 */
  auth?: AuthMode;
}

export interface AgcResponse {
  status: number;
  url: string;
  data: unknown;
  /** 本次请求实际使用的凭据类型 */
  authMode: AuthMode;
  /** 接口文档列出的鉴权方式（目录中找不到该接口时为空） */
  endpointAuth?: Array<AuthMode | "oauth">;
}

export class AgcError extends Error {
  constructor(
    message: string,
    readonly response?: AgcResponse,
  ) {
    super(message);
  }
}

/** 从各种返回格式中提取 AGC 业务返回码：ret.code / ret 为 JSON 字符串 / rtnCode。 */
export function businessCode(data: unknown): { code: number; msg?: string } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  let ret = d.ret ?? d.et;
  if (typeof ret === "string") {
    try {
      ret = JSON.parse(ret);
    } catch {
      return undefined;
    }
  }
  if (ret && typeof ret === "object" && "code" in ret) {
    const r = ret as { code: unknown; msg?: unknown };
    return { code: Number(r.code), msg: r.msg as string | undefined };
  }
  if ("rtnCode" in d) return { code: Number(d.rtnCode), msg: d.rtnDesc as string | undefined };
  // PMS 接口：{"error":{"errorCode":0,"errorMsg":"success"}}
  const e = d.error;
  if (e && typeof e === "object" && "errorCode" in e) {
    const r = e as { errorCode: unknown; errorMsg?: unknown };
    return { code: Number(r.errorCode), msg: r.errorMsg as string | undefined };
  }
  return undefined;
}

export function authHint(res: AgcResponse): string {
  if (res.authMode === "service_account" && res.endpointAuth && !res.endpointAuth.includes("service_account")) {
    return "该接口文档只支持 API 客户端鉴权，而当前只配置了 Service Account。请在 AGC“用户与访问 > API密钥 > Connect API > API客户端”创建（项目选 N/A），并通过 AGC_CLIENT_FILE 或 AGC_CLIENT_ID/AGC_CLIENT_SECRET 配置";
  }
  return `鉴权失败（使用 ${res.authMode === "service_account" ? "Service Account" : "API 客户端"}）：请检查凭据是否正确、是否已启用，角色是否有该接口权限；API 客户端的“项目”须为 N/A`;
}

export class AgcClient {
  constructor(
    readonly config: Config,
    readonly auth: AuthProvider,
  ) {}

  baseUrlFor(site?: Site): string {
    return site ? `https://${SITES[site]}` : this.config.baseUrl;
  }

  buildUrl(pathOrUrl: string, query?: Record<string, QueryValue>, site?: Site): URL {
    let url: URL;
    if (/^https?:\/\//.test(pathOrUrl)) {
      url = new URL(pathOrUrl);
      if (!/\.huawei\.com$/.test(url.hostname) && url.origin !== this.config.baseUrl) {
        throw new AgcError(`拒绝向非华为域名发送带鉴权的请求：${url.hostname}`);
      }
    } else {
      let path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
      if (!path.startsWith("/api/")) path = `/api${path}`;
      url = new URL(`${this.baseUrlFor(site)}${path}`);
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
      else url.searchParams.set(key, String(value));
    }
    return url;
  }

  async request(method: HttpMethod, pathOrUrl: string, opts: RequestOptions = {}): Promise<AgcResponse> {
    const url = this.buildUrl(pathOrUrl, opts.query, opts.site);
    const endpointAuth = findEndpoint(method, url.pathname)?.auth;
    const usable = endpointAuth?.filter((m): m is AuthMode => m !== "oauth");
    if (!opts.auth && endpointAuth && !usable?.length) {
      throw new AgcError(
        `该接口（${method} ${url.pathname}）按官方文档只支持 OAuth 客户端方式（仅面向平台类开发者开放），Service Account 与 API 客户端都无法调用。`,
      );
    }
    const preferred: AuthMode[] | undefined = opts.auth ? [opts.auth] : usable;
    let authMode: AuthMode = "service_account";
    const send = async (forceRefresh: boolean) => {
      const auth = await this.auth.headers(url.origin, { preferred, forceRefresh });
      authMode = auth.mode;
      const headers: Record<string, string> = { Accept: "application/json", ...auth.headers, ...opts.headers };
      let body: string | undefined;
      if (opts.body !== undefined && method !== "GET") {
        headers["Content-Type"] ??= "application/json";
        body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      }
      return fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.config.timeoutMs) });
    };

    let res = await send(false);
    if (res.status === 401) res = await send(true);
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* 保留原始文本 */
    }
    return { status: res.status, url: url.toString(), data, authMode, endpointAuth };
  }

  /** 调用接口，HTTP 非 2xx 或业务返回码非 0 时抛出 AgcError。 */
  async call(method: HttpMethod, pathOrUrl: string, opts: RequestOptions = {}): Promise<AgcResponse> {
    const res = await this.request(method, pathOrUrl, opts);
    const biz = businessCode(res.data);
    if (res.status >= 400 || (biz && biz.code !== 0)) {
      let detail = biz ? `code=${biz.code} msg=${biz.msg ?? ""}` : JSON.stringify(res.data).slice(0, 500);
      if (res.status === 401 || res.status === 403) detail += `（${authHint(res)}）`;
      throw new AgcError(`AGC 接口返回错误（HTTP ${res.status}，${method} ${res.url}）：${detail}`, res);
    }
    return res;
  }

  /** 上传本地文件：获取 OBS 上传地址 → PUT 文件内容，返回 objectId。 */
  async uploadFile(params: {
    appId: string;
    filePath: string;
    fileName?: string;
    releaseType?: number;
    chineseMainlandFlag?: number;
  }): Promise<{ objectId: string; fileName: string; size: number; sha256: string }> {
    const { size } = await stat(params.filePath);
    const fileName = params.fileName ?? basename(params.filePath);
    const hash = createHash("sha256");
    await pipeline(createReadStream(params.filePath), hash);
    const sha256 = hash.digest("hex");

    const res = await this.call("GET", "/api/publish/v2/upload-url/for-obs", {
      query: {
        appId: params.appId,
        fileName,
        contentLength: size,
        sha256,
        releaseType: params.releaseType,
        chineseMainlandFlag: params.chineseMainlandFlag,
      },
    });
    const urlInfo = (res.data as { urlInfo?: { objectId: string; url: string; method?: string; headers?: Record<string, string> } })
      .urlInfo;
    if (!urlInfo?.url) throw new AgcError(`获取上传地址失败：${JSON.stringify(res.data).slice(0, 500)}`, res);

    await new Promise<void>((resolve, reject) => {
      const target = new URL(urlInfo.url);
      const headers: Record<string, string | number> = { ...(urlInfo.headers ?? {}), "Content-Length": size };
      const send = target.protocol === "http:" ? httpRequest : httpsRequest;
      const req = send(target, { method: urlInfo.method ?? "PUT", headers, timeout: 30 * 60 * 1000 }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c: Buffer) => chunks.push(c));
        resp.on("end", () => {
          if (resp.statusCode && resp.statusCode >= 200 && resp.statusCode < 300) resolve();
          else reject(new AgcError(`文件上传失败（HTTP ${resp.statusCode}）：${Buffer.concat(chunks).toString().slice(0, 500)}`));
        });
      });
      req.on("timeout", () => req.destroy(new Error("文件上传超时")));
      req.on("error", reject);
      createReadStream(params.filePath).on("error", reject).pipe(req);
    });
    return { objectId: urlInfo.objectId, fileName, size, sha256 };
  }

  /** 下载报表等文件（fileURL 通常是带签名的地址，不需要鉴权头）。 */
  async download(fileUrl: string, dest: string): Promise<number> {
    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(this.config.timeoutMs) });
    if (!res.ok || !res.body) throw new AgcError(`下载失败（HTTP ${res.status}）：${fileUrl}`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
    return (await stat(dest)).size;
  }
}
