import { mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { docUrl, findDoc, getEndpoints, pathMatches, search } from "./catalog.js";
import { AgcError, authHint, businessCode, type AgcClient, type HttpMethod } from "./client.js";
import { SITES, type Site } from "./config.js";
import { hagRequestTime, type HagClient, type HagResponse } from "./hag.js";
import type { KnowledgeClient } from "./knowledge.js";
import { loadDocMarkdown } from "./portal.js";

const MAX_OUTPUT = 60_000;

function text(value: unknown, isError = false): CallToolResult {
  let s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (s.length > MAX_OUTPUT) s = `${s.slice(0, MAX_OUTPUT)}\n…（输出过长，已截断 ${s.length - MAX_OUTPUT} 个字符）`;
  return { content: [{ type: "text", text: s }], isError };
}

/** 已知业务错误码的排查提示（官方错误码说明过于简略的情况）。 */
const ERROR_HINTS: Record<number, string> = {
  50010028:
    "评论接口判定“应用不属于该开发者”。最常见的原因是该应用尚未正式上架（审核中/未发布的应用在评论系统中没有记录）；" +
    "若应用已上架，再检查账号是否登录过应用推广引擎平台、凭据角色是否有“查看评论/管理评论”权限。",
};

function fail(err: unknown): CallToolResult {
  if (err instanceof AgcError && err.response) {
    const code = businessCode(err.response.data)?.code;
    const hint = code !== undefined ? ERROR_HINTS[code] : undefined;
    return text({ error: err.message, ...(hint && { hint }), status: err.response.status, response: err.response.data }, true);
  }
  return text(`错误：${err instanceof Error ? err.message : String(err)}`, true);
}

const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return text(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p);
}

/** 接受 YYYYMMDD / YYYY-MM-DD，统一为 YYYYMMDD。 */
function yyyymmdd(v: string): string {
  const s = v.replace(/-/g, "");
  if (!/^\d{8}$/.test(s)) throw new Error(`日期格式应为 YYYY-MM-DD 或 YYYYMMDD：${v}`);
  return s;
}

/** 接受毫秒时间戳或日期字符串（按北京时间解析），返回毫秒时间戳。 */
function toMillis(v: string | number, endOfDay = false): number {
  if (typeof v === "number" || /^\d{10,13}$/.test(v)) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${endOfDay ? "23:59:59.999" : "00:00:00"}+08:00` : v;
  const t = Date.parse(date);
  if (Number.isNaN(t)) throw new Error(`无法解析时间：${v}`);
  return t;
}

const AUTH_HEADERS = new Set(["Authorization", "client_id", "teamId", "oauth2Token", "Content-Type"]);

const READ_TITLE = /^(查询|获取|按条件查询|批量查询|分页查询|下载|预检查)/;

/** 只读模式下判断一次通用请求是否属于查询类接口。 */
function isReadRequest(method: string, path: string): boolean {
  if (method === "GET") return true;
  const clean = path.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  return getEndpoints().some(
    (e) => e.method === method && e.path && READ_TITLE.test(e.title) && pathMatches(e.path, clean),
  );
}

const platformSchema = z
  .enum(["harmonyos", "android"])
  .describe("应用平台：harmonyos = HarmonyOS 5 及以上应用/元服务（v3 接口）；android = Android 及 HarmonyOS 4 及以下（v2 接口）");
const siteSchema = z
  .enum(Object.keys(SITES) as [Site, ...Site[]])
  .optional()
  .describe("站点：cn 中国 / de 德国 / sg 新加坡 / ru 俄罗斯。默认使用 AGC_SITE 配置");

const REPORTS: Record<string, { platform: "harmonyos" | "android"; path: string; desc: string }> = {
  "harmony-download": { platform: "harmonyos", path: "/api/report/harmony-report/v1/harmony/appDownloadAnalysisExport/{appId}", desc: "HarmonyOS 应用下载安装" },
  "harmony-install-failed": { platform: "harmonyos", path: "/api/report/harmony-report/v1/harmony/installFailedAnalysisExport/{appId}", desc: "HarmonyOS 应用安装失败" },
  "harmony-user-analysis": { platform: "harmonyos", path: "/api/report/harmony-report/v1/harmony/userAnalysisExport/{appId}", desc: "HarmonyOS 应用/元服务用户分析" },
  "harmony-atomic-distribute": { platform: "harmonyos", path: "/api/report/harmony-report/v1/fa/distributeAnalysisExport/{appId}", desc: "HarmonyOS 元服务分发分析" },
  download: { platform: "android", path: "/api/report/distribution-operation-quality/v1/appDownloadExport/{appId}", desc: "下载安装" },
  "install-failed": { platform: "android", path: "/api/report/distribution-operation-quality/v1/appDownloadFailExport/{appId}", desc: "安装失败" },
  "new-and-retention": { platform: "android", path: "/api/report/distribution-operation-quality/v1/addAdKpExport/{appId}", desc: "新增和留存" },
  iap: { platform: "android", path: "/api/report/distribution-operation-quality/v1/IAPExport/{appId}", desc: "应用内付费" },
  "paid-download": { platform: "android", path: "/api/report/distribution-operation-quality/v1/orderAnalysisExport/{appId}", desc: "付费下载" },
  "paid-download-detail": { platform: "android", path: "/api/report/distribution-operation-quality/v1/orderDetailExport/{appId}", desc: "付费下载明细" },
  "game-reservation": { platform: "android", path: "/api/report/distribution-operation-quality/v1/gameReservationExport/{appId}", desc: "预约" },
  "activity-award": { platform: "android", path: "/api/report/distribution-operation-quality/v1/activityAwardExport/{appId}", desc: "指定用户群发奖" },
  coupon: { platform: "android", path: "/api/report/distribution-operation-quality/v1/activityCouponExport/{appId}", desc: "优惠券活动" },
  "atomic-distribute": { platform: "android", path: "/api/report/distribution-operation-quality/v1/fa/distributeAnalysisExport/{appId}", desc: "元服务分发分析（旧版）" },
  "atomic-user": { platform: "android", path: "/api/report/distribution-operation-quality/v1/fa/userAnalysisExport/{appId}", desc: "元服务新增留存（旧版）" },
  "atomic-widget": { platform: "android", path: "/api/report/distribution-operation-quality/v1/fa/widgetAnalysisExport/{appId}", desc: "元服务卡片分析（旧版）" },
};

export function registerTools(server: McpServer, client: AgcClient, hag?: HagClient): void {
  const { config } = client;
  const guardWrite = (what: string) => {
    if (config.readOnly) throw new Error(`当前为只读模式（AGC_READ_ONLY=true），已拒绝：${what}`);
  };

  // ───────────── 文档与通用调用 ─────────────

  server.registerTool(
    "agc_search_api",
    {
      title: "搜索 AGC API 目录",
      description:
        "在内置的 AppGallery Connect Connect API 目录（约 200 个端点、450 篇文档，含数据模型、错误码、附录）中按关键词搜索。" +
        "关键词可用中文或英文，空格分隔表示同时匹配。找到端点后用 agc_get_api_doc 查看参数，再用专用工具或 agc_request 调用。",
      inputSchema: {
        query: z.string().describe("关键词，如“提交发布”、“评论”、“upload”、“app-info”、“错误码 204144647”"),
        group: z
          .string()
          .optional()
          .describe("按 API 分组过滤，如 Publishing / Upload / Reports / Comments / PMS / Provisioning / Testing / Domain / Project"),
        platform: z.enum(["harmonyos", "android"]).optional().describe("按平台过滤"),
        limit: z.number().int().min(1).max(100).optional().describe("最多返回端点数，默认 30"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async ({ query, group, platform, limit }) => {
      const r = search(query, { group, platform, limit });
      return {
        endpoints: r.endpoints.map((e) => ({
          doc: e.doc,
          title: e.title,
          group: e.group,
          platform: e.platform,
          method: e.method,
          path: e.path ?? e.url,
          auth: e.auth,
        })),
        otherDocs: r.docs,
      };
    }),
  );

  server.registerTool(
    "agc_get_api_doc",
    {
      title: "查看 AGC API 文档",
      description:
        "读取某个 Connect API 文档的完整内容（Markdown，含接口 URL、Header/Query/Body 参数表、响应字段、示例）。" +
        "正文从华为开发者文档中心实时拉取并在本地缓存 7 天。docId 来自 agc_search_api 的 doc 字段；也可传文档标题（精确）或 docId 片段。",
      inputSchema: {
        docId: z.string().describe("文档 ID，如 agc-help-publish-api-app-submit-0000002271160585"),
        includeExamples: z.boolean().optional().describe("是否包含调用示例代码（Java），默认 false 以节省篇幅"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ docId, includeExamples }) => {
      const hit = findDoc(docId);
      if (!hit) throw new Error(`未找到文档：${docId}，请先用 agc_search_api 搜索`);
      const loaded = await loadDocMarkdown(hit.id, hit.entry.catalog);
      let md = loaded.markdown;
      if (!includeExamples) {
        md = md.replace(/\n#### (调用示例|Postman调试)[\s\S]*?(?=\n#### |$)/g, "");
        // Header 表中的鉴权参数由本服务自动处理；只保留其余必须自行传入的请求头（如 PMS 接口的 appId）
        md = md.replace(/\n##### Header[\s\S]*?(?=\n##### |\n#### )/g, (section) => {
          const extra = [...section.matchAll(/^\| ([A-Za-z][\w-]*) \| ([MO]) \|.*$/gm)]
            .filter((m) => !AUTH_HEADERS.has(m[1]))
            .map((m) => m[0]);
          const unique = [...new Set(extra)];
          const note = "\n##### Header\n\n（鉴权请求头 Authorization / client_id 由 MCP 服务自动添加";
          return unique.length
            ? `${note}；以下请求头需通过 agc_request 的 headers 参数自行传入）\n\n| 参数 | 必选(M)/可选(O) | 类型 | 描述 |\n|---|---|---|---|\n${unique.join("\n")}\n`
            : `${note}）\n`;
        });
      }
      return `<!-- ${hit.id} | ${hit.entry.path.join(" > ")} | 更新于 ${loaded.updated ?? "?"} | ${docUrl(hit.id, hit.entry)} -->\n\n${md}`;
    }),
  );

  server.registerTool(
    "agc_request",
    {
      title: "调用任意 AGC Connect API",
      description:
        "以当前凭据调用任意 Connect API 端点（自动添加鉴权头、按站点选择域名）。适用于没有专用工具的接口，" +
        "如 PMS 商品管理、Provisioning 证书/Profile、Testing 测试版本、Domain、资质审核、协议管理等。" +
        "调用前请先用 agc_get_api_doc 确认方法、路径和参数。返回 HTTP 状态与原始 JSON。",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
        path: z
          .string()
          .describe("接口路径，如 /api/publish/v3/app-info；路径参数需自行替换（如 {appId}）。也可传完整 https://connect-api*.cloud.huawei.com URL"),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
          .optional()
          .describe("Query 参数；数组值会展开为重复参数（如 filterCondition）"),
        body: z.any().optional().describe("JSON 请求体"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("额外请求头。鉴权头自动添加；但部分接口要求业务参数放在请求头里（如 PMS 接口的 appId），见 agc_get_api_doc 的 Header 段"),
        site: siteSchema,
        auth: z
          .enum(["service_account", "api_client"])
          .optional()
          .describe("强制使用的凭据；默认按接口文档支持的鉴权方式自动选择（两者都支持时优先 Service Account）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ method, path, query, body, headers, site, auth }) => {
      try {
        if (config.readOnly && !isReadRequest(method, path)) guardWrite(`${method} ${path}`);
        const res = await client.request(method as HttpMethod, path, { query, body, headers, site, auth });
        const biz = businessCode(res.data);
        const out: Record<string, unknown> = { status: res.status, url: res.url, auth: res.authMode, data: res.data };
        if (res.status === 401 || res.status === 403) out.hint = authHint(res);
        return text(out, res.status >= 400 || (!!biz && biz.code !== 0));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "agc_auth_status",
    {
      title: "检查 AGC 鉴权配置",
      description:
        "显示已配置的凭据（Service Account / API 客户端）、站点、只读模式，并逐一验证：API 客户端会向华为换取 token；" +
        "Service Account 会本地签发 JWT 并调用一次查询接口确认可用。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const checks: Record<string, string> = {};
      for (const mode of client.auth.modes()) {
        try {
          if (mode === "api_client") {
            await client.auth.headers(config.baseUrl, { preferred: [mode], forceRefresh: true });
            checks[mode] = "OK（已获取 access_token）";
          } else {
            // 包名随便填：凭据有效时接口返回成功（结果可能为空），无效时返回 401
            const res = await client.request("GET", "/api/publish/v2/appid-list", {
              query: { packageName: "com.example.auth.check" },
              auth: mode,
            });
            checks[mode] = res.status < 400 ? "OK（JWT 已被接口接受）" : `FAILED（HTTP ${res.status}：${JSON.stringify(res.data)}）`;
          }
        } catch (err) {
          checks[mode] = `FAILED：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const coverage = client.auth.modes().includes("api_client")
        ? "除 4 个仅限 OAuth 客户端的接口（团队列表、应用简略信息、证书指纹查询/添加）外的全部接口"
        : "Service Account 支持的接口（HarmonyOS 发布/上传/测试/证书/域名/项目/大部分报表）；评论、PMS、Android 发布需另配 API 客户端";
      const intentsApps: Record<string, string> = {};
      for (const name of hag?.appNames() ?? []) {
        try {
          await hag!.token(hag!.resolve(name).client, true);
          intentsApps[name] = "OK（已获取应用级 AccessToken）";
        } catch (err) {
          intentsApps[name] = `FAILED：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const ok =
        Object.keys(checks).length > 0 && [...Object.values(checks), ...Object.values(intentsApps)].every((v) => v.startsWith("OK"));
      return text(
        {
          credentials: client.auth.describe(),
          problems: [...config.credentials.problems, ...(hag?.config.problems ?? [])],
          checks,
          intentsApps: Object.keys(intentsApps).length ? intentsApps : "未配置（意图框架工具不可用，见 AGC_APP_CLIENTS_FILE）",
          coverage,
          site: config.site,
          baseUrl: config.baseUrl,
          readOnly: config.readOnly,
        },
        !ok,
      );
    },
  );

  // ───────────── 项目与应用 ─────────────

  server.registerTool(
    "agc_get_app_id",
    {
      title: "按包名查询应用 ID",
      description: "根据应用包名（最多 50 个，逗号分隔）查询 AGC 应用 ID（appId）。",
      inputSchema: {
        packageNames: z.string().describe("包名，多个用英文逗号分隔，如 com.example.app"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ packageNames }) => (await client.call("GET", "/api/publish/v2/appid-list", { query: { packageName: packageNames } })).data),
  );

  server.registerTool(
    "agc_list_apps",
    {
      title: "列出项目与应用",
      description:
        "列出当前团队的所有 AGC 项目及每个项目下的应用（appId、名称、包名、设备类型）。" +
        "（官方的“获取团队列表 / 应用简略信息”接口只对 OAuth 客户端开放，本工具改用项目管理接口实现。）",
      inputSchema: {
        projectId: z.string().optional().describe("只查询某个项目；不传则列出全部项目"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ projectId }) => {
      let ids: string[];
      if (projectId) {
        ids = [projectId];
      } else {
        const list = (await client.call("GET", "/api/project-service/v1/projects", { query: { pageSize: 100 } })).data as {
          projectList?: Array<{ projectId: string }>;
        };
        ids = (list.projectList ?? []).map((p) => p.projectId);
      }
      const projects = await Promise.all(
        ids.map(async (id) => {
          const d = (await client.call("GET", `/api/project-service/v1/projects/${encodeURIComponent(id)}`, { query: { queryFlag: 1 } }))
            .data as { project?: Record<string, unknown> & { appList?: Array<Record<string, unknown>> } };
          const p = d.project ?? {};
          return {
            projectId: p.projectId ?? id,
            name: p.name,
            siteId: p.siteId,
            teamId: p.teamId,
            apps: (p.appList ?? []).map((a) => ({
              appId: a.appId,
              appName: a.appName,
              packageName: a.packageName,
              appType: a.appType,
              deviceTypes: a.deviceTypes,
              hasPermission: a.hasPermission,
            })),
          };
        }),
      );
      return { projects };
    }),
  );

  server.registerTool(
    "agc_get_app_info",
    {
      title: "查询应用详细信息",
      description: "查询应用基本信息、各语言描述、审核意见、分阶段发布信息等。",
      inputSchema: {
        appId: z.string(),
        platform: platformSchema,
        lang: z.string().optional().describe("语言，如 zh-CN、en-US；不传返回全部语言"),
        releaseType: z.number().int().optional().describe("发布方式：1 全网（默认）；HarmonyOS 可用 6 = 测试发布（需配合 versionId）；Android 可用 3 = 分阶段"),
        versionId: z.string().optional().describe("HarmonyOS 版本 ID（releaseType=6 时必填）"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ appId, platform, lang, releaseType, versionId }) => {
      const path = platform === "harmonyos" ? "/api/publish/v3/app-info" : "/api/publish/v2/app-info";
      return (await client.call("GET", path, { query: { appId, lang, releaseType, versionId } })).data;
    }),
  );

  // ───────────── 上传与发布 ─────────────

  server.registerTool(
    "agc_upload_file",
    {
      title: "上传文件到 AGC",
      description:
        "把本地文件（软件包 .app/.apk/.aab/.rpk、图标、截图、视频、PDF、资质 zip 等）上传到 AGC 文件服务器，返回 objectId。" +
        "得到 objectId 后需调用相应接口（如 agc_update_app_package，或通过 agc_request 调用更新应用文件信息接口）把文件关联到应用。",
      inputSchema: {
        appId: z.string(),
        filePath: z.string().describe("本地文件绝对路径（支持 ~/ 开头）"),
        fileName: z.string().optional().describe("上报的文件名（含后缀），默认取本地文件名"),
        releaseType: z.number().int().optional().describe("发布方式，默认 1（全网）"),
        chineseMainlandFlag: z
          .number()
          .int()
          .min(0)
          .max(1)
          .optional()
          .describe("软件包是否分发中国大陆：1 是 / 0 否。开发者注册地非中国大陆时必填"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    wrap(async (args) => {
      guardWrite("上传文件");
      return client.uploadFile({ ...args, filePath: expandHome(args.filePath) });
    }),
  );

  server.registerTool(
    "agc_update_app_package",
    {
      title: "上传并关联应用软件包",
      description:
        "上传软件包并写入应用当前草稿版本：HarmonyOS 走 PUT /api/publish/v3/app-package-info（返回 packageId），" +
        "Android 走 PUT /api/publish/v2/app-file-info（fileType=5，返回 pkgVersion）。" +
        "可以传本地 filePath（自动上传），也可以传已上传的 objectId + fileName。软件包需异步解析，约 2 分钟后再提交发布，可用 agc_get_package_compile_status 查询。",
      inputSchema: {
        appId: z.string(),
        platform: platformSchema,
        filePath: z.string().optional().describe("本地软件包路径（.app / .apk / .aab / .rpk）"),
        objectId: z.string().optional().describe("已上传文件的 objectId（与 filePath 二选一）"),
        fileName: z.string().optional().describe("文件名（含后缀）；使用 objectId 时必填"),
        chineseMainlandFlag: z.number().int().min(0).max(1).optional().describe("软件包是否分发中国大陆，注册地非中国大陆时必填"),
        releasePhase: z.number().int().optional().describe("HarmonyOS：0 全网（默认）/ 3 分阶段"),
        releaseType: z.number().int().optional().describe("Android：1 全网（默认）/ 3 分阶段"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    wrap(async ({ appId, platform, filePath, objectId, fileName, chineseMainlandFlag, releasePhase, releaseType }) => {
      guardWrite("更新应用软件包");
      let upload: Awaited<ReturnType<AgcClient["uploadFile"]>> | undefined;
      if (filePath) {
        upload = await client.uploadFile({ appId, filePath: expandHome(filePath), fileName, chineseMainlandFlag, releaseType });
        objectId = upload.objectId;
        fileName = upload.fileName;
      }
      if (!objectId || !fileName) throw new Error("需要 filePath，或 objectId + fileName");
      const res =
        platform === "harmonyos"
          ? await client.call("PUT", "/api/publish/v3/app-package-info", {
              query: { appId, releasePhase },
              body: { fileName, objectId },
            })
          : await client.call("PUT", "/api/publish/v2/app-file-info", {
              query: { appId, releaseType },
              body: { fileType: 5, files: [{ fileName, fileDestUrl: objectId }] },
            });
      return { upload, result: res.data };
    }),
  );

  server.registerTool(
    "agc_get_package_compile_status",
    {
      title: "查询软件包编译/解析状态",
      description: "查询软件包解析状态。successStatus：0 正常 / 1 解析中 / 2 失败。",
      inputSchema: {
        appId: z.string(),
        platform: platformSchema,
        pkgIds: z.string().describe("软件包 ID，逗号分隔（HarmonyOS 为 packageId，Android 为 pkgVersion）"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ appId, platform, pkgIds }) => {
      const path = platform === "harmonyos" ? "/api/publish/v3/package/compile/status" : "/api/publish/v2/package/compile/status";
      return (await client.call("GET", path, { query: { appId, pkgIds } })).data;
    }),
  );

  server.registerTool(
    "agc_submit_app",
    {
      title: "提交应用发布审核",
      description:
        "提交应用审核发布（上架）。调用前应确认应用信息完整、软件包已解析成功。这是对外生效的操作，调用前请与用户确认。" +
        "HarmonyOS 走 POST /api/publish/v3/app-submit；Android 走 POST /api/publish/v2/app-submit。",
      inputSchema: {
        appId: z.string(),
        platform: platformSchema,
        releaseTime: z.string().optional().describe("指定上架时间，格式 yyyy-MM-ddTHH:mm:ssZZ，如 2026-10-01T10:00:00+0800；不填则审核通过后立即上架"),
        remark: z.string().optional().describe("提审备注，10-300 字"),
        phased: z
          .object({
            description: z.string().describe("分阶段发布说明"),
            startTime: z.string().optional().describe("Android 必填：开始时间 yyyy-MM-ddTHH:mm:ssZZ"),
            endTime: z.string().optional().describe("Android 必填：结束时间"),
            percent: z.string().optional().describe("Android 必填：百分比，如 \"10.00\""),
          })
          .optional()
          .describe("分阶段发布设置；不传为全网发布"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    wrap(async ({ appId, platform, releaseTime, remark, phased }) => {
      guardWrite("提交发布");
      if (platform === "harmonyos") {
        const body: Record<string, unknown> = { releaseTime, remark };
        if (phased) Object.assign(body, { releasePhase: 3, phasedReleaseDescription: phased.description });
        return (await client.call("POST", "/api/publish/v3/app-submit", { query: { appId }, body })).data;
      }
      if (phased && (!phased.startTime || !phased.endTime || !phased.percent)) {
        throw new Error("Android 分阶段发布需要 phased.startTime / endTime / percent");
      }
      return (
        await client.call("POST", "/api/publish/v2/app-submit", {
          query: { appId, releaseTime, remark, releaseType: phased ? 3 : undefined },
          body: phased
            ? {
                phasedReleaseStartTime: phased.startTime,
                phasedReleaseEndTime: phased.endTime,
                phasedReleasePercent: phased.percent,
                phasedReleaseDescription: phased.description,
              }
            : undefined,
        })
      ).data;
    }),
  );

  // ───────────── 评论 ─────────────

  server.registerTool(
    "agc_list_reviews",
    {
      title: "查询应用评论",
      description:
        "查询应用评论列表（时间跨度不超过 6 个月，一次只能查询同一站点内的国家）。" +
        "需要 API 客户端凭据（评论接口不支持 Service Account）；站点（site）需与所查国家所在站点一致。",
      inputSchema: {
        appId: z.string(),
        platform: platformSchema,
        begin: z.union([z.string(), z.number()]).describe("开始时间：YYYY-MM-DD（按北京时间）、ISO 时间或毫秒时间戳"),
        end: z.union([z.string(), z.number()]).describe("结束时间，格式同上；YYYY-MM-DD 取当天结束"),
        countries: z.string().default("CN").describe("国家码，逗号分隔，默认 CN"),
        ratings: z.string().optional().describe("评分过滤，如 \"1,2\""),
        versions: z.string().optional().describe("应用版本过滤，逗号分隔"),
        devReplyStates: z.string().optional().describe("答复状态：0 未答复 / 1 已答复 / 6 用户追加回复 / 3 答复被回复"),
        langs: z.string().optional().describe("语言过滤（HarmonyOS 如 zh；Android 如 zh_CN）"),
        content: z.string().optional().describe("评论内容关键词"),
        sort: z.number().int().min(0).max(2).optional().describe("0 按时间 / 1 分数降序 / 2 分数升序"),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("每页条数，最大 100，默认 20"),
        site: siteSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      const path = a.platform === "harmonyos" ? "/api/marketing-api/v2/reviews/manage/dev/reviews" : "/api/reviews/v1/manage/dev/reviews";
      const query = {
        appId: a.appId,
        beginTime: toMillis(a.begin),
        endTime: toMillis(a.end, true),
        countries: a.countries,
        ratings: a.ratings,
        [a.platform === "harmonyos" ? "appVersions" : "apkVersions"]: a.versions,
        devReplyStates: a.devReplyStates,
        langs: a.langs,
        content: a.content,
        sort: a.sort,
        page: a.page,
        limit: a.limit,
      };
      return (await client.call("GET", path, { query, site: a.site })).data;
    }),
  );

  server.registerTool(
    "agc_get_ratings",
    {
      title: "查询应用评分",
      description: "查询应用评分汇总（平均分、各星级数量）和评分明细。仅已上架应用有数据；时间跨度不超过 6 个月。需要 API 客户端凭据。",
      inputSchema: {
        appId: z.string(),
        platform: platformSchema,
        begin: z.union([z.string(), z.number()]).describe("开始时间：YYYY-MM-DD（按北京时间）、ISO 时间或毫秒时间戳"),
        end: z.union([z.string(), z.number()]).describe("结束时间，格式同上；YYYY-MM-DD 取当天结束"),
        countries: z.string().default("CN").describe("国家码，逗号分隔，默认 CN"),
        site: siteSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      const path = a.platform === "harmonyos" ? "/api/marketing-api/v2/reviews/manage/dev/ratings" : "/api/reviews/v1/manage/dev/ratings";
      const query = { appId: a.appId, beginTime: toMillis(a.begin), endTime: toMillis(a.end, true), countries: a.countries };
      return (await client.call("GET", path, { query, site: a.site })).data;
    }),
  );

  server.registerTool(
    "agc_reply_review",
    {
      title: "回复用户评论",
      description: "以开发者身份公开回复用户评论（或回复用户的追加回复）。回复会对所有用户可见，调用前请与用户确认回复内容。",
      inputSchema: {
        appId: z.string(),
        platform: platformSchema,
        reviewId: z.string(),
        content: z.string().describe("回复内容"),
        countryCode: z.string().describe("评论所属国家码，如 CN"),
        lang: z.string().describe("语言：HarmonyOS 取 zh / en / bo / ug；Android 取 zh_CN 这类格式"),
        toReplyId: z.string().optional().describe("回复用户的追加回复时传该回复 ID"),
        updateReplyId: z.string().optional().describe("仅 Android：修改已有回复时传回复 ID"),
        site: siteSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    wrap(async (a) => {
      guardWrite("回复评论");
      const path = a.platform === "harmonyos" ? "/api/marketing-api/v2/reviews/manage/dev/reviews" : "/api/reviews/v1/manage/dev/reviews";
      const body = {
        appId: a.appId,
        reviewId: a.reviewId,
        devReplyContent: a.content,
        countryCode: a.countryCode,
        lang: a.lang,
        toReplyId: a.toReplyId,
        updateReplyId: a.platform === "android" ? a.updateReplyId : undefined,
      };
      return (await client.call("POST", path, { body, site: a.site })).data;
    }),
  );

  // ───────────── 报表 ─────────────

  server.registerTool(
    "agc_get_report",
    {
      title: "导出 AGC 报表",
      description:
        "导出运营报表（CSV/Excel），返回文件下载地址（有效期约 5 分钟，需要内容时直接传 downloadTo）；可选下载到本地并预览前若干行。时间跨度一般不超过 180 天。可用报表：\n" +
        Object.entries(REPORTS)
          .map(([k, v]) => `- ${k}：${v.desc}（${v.platform}）`)
          .join("\n"),
      inputSchema: {
        appId: z.string(),
        report: z.enum(Object.keys(REPORTS) as [string, ...string[]]),
        startDate: z.string().describe("开始日期 YYYY-MM-DD 或 YYYYMMDD（UTC）"),
        endDate: z.string().describe("结束日期 YYYY-MM-DD 或 YYYYMMDD（UTC）"),
        language: z.enum(["zh-CN", "en-US", "ru-RU"]).default("zh-CN"),
        groupBy: z.string().optional().describe("分组：date（默认）/ countryId / appVersion / businessType / province / city / deviceName 等，视报表而定"),
        filters: z
          .record(z.string(), z.string())
          .optional()
          .describe("过滤器，键为 filterCondition、值为 filterConditionValue，如 {\"countryId\":\"CN\",\"appVersion\":\"1.0.0\"}"),
        exportType: z.enum(["CSV", "EXCEL"]).default("CSV"),
        extraQuery: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe("其他报表特有的 Query 参数（如 timeType），参见 agc_get_api_doc"),
        downloadTo: z
          .string()
          .optional()
          .describe("下载保存路径（文件或目录）；传 \"tmp\" 保存到系统临时目录。不传则只返回下载地址"),
        previewLines: z.number().int().min(0).max(500).optional().describe("下载 CSV 后预览的行数，默认 30"),
        site: siteSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async (a) => {
      const def = REPORTS[a.report];
      const filters = Object.entries(a.filters ?? {});
      const res = await client.call("GET", def.path.replace("{appId}", encodeURIComponent(a.appId)), {
        site: a.site,
        query: {
          startTime: yyyymmdd(a.startDate),
          endTime: yyyymmdd(a.endDate),
          language: a.language,
          groupBy: a.groupBy,
          exportType: a.exportType,
          filterCondition: filters.map(([k]) => k),
          filterConditionValue: filters.map(([, v]) => v),
          ...a.extraQuery,
        },
      });
      const data = res.data as { fileURL?: string };
      if (!a.downloadTo || !data.fileURL) return data;

      const ext = a.exportType === "EXCEL" ? "xlsx" : "csv";
      const defaultName = `agc-${a.report}-${a.appId}-${yyyymmdd(a.startDate)}-${yyyymmdd(a.endDate)}.${ext}`;
      let dest = a.downloadTo === "tmp" ? join(tmpdir(), defaultName) : expandHome(a.downloadTo);
      if (dest.endsWith("/") || !/\.[a-z0-9]+$/i.test(dest)) dest = join(dest, defaultName);
      await mkdir(dirname(dest), { recursive: true });
      const bytes = await client.download(data.fileURL, dest);
      let preview: string | undefined;
      if (ext === "csv") {
        const lines = (await readFile(dest, "utf8")).replace(/^﻿/, "").split(/\r?\n/);
        preview = lines.slice(0, (a.previewLines ?? 30) + 1).join("\n");
      }
      return { ...data, savedTo: dest, bytes, preview };
    }),
  );
}

/** 代理华为官方“鸿蒙开发者知识 MCP”，把嵌套参数展平成更易用的形式。 */
export function registerKnowledgeTools(server: McpServer, knowledge: KnowledgeClient): void {
  server.registerTool(
    "harmonyos_search_docs",
    {
      title: "搜索鸿蒙开发者文档",
      description:
        "通过华为官方“鸿蒙开发者知识 MCP”检索最新的 HarmonyOS 官方文档：版本说明、API 参考、开发指南、最佳实践、FAQ、" +
        "DevEco Studio 指南、UX 设计、应用上架与分发等（与官网准实时同步）。返回匹配的文本片段及文档标识 parent；" +
        "片段不够时用 harmonyos_get_docs 取全文。Connect API 接口参数请优先用 agc_search_api / agc_get_api_doc。",
      inputSchema: { query: z.string().describe("搜索词，中英文均可，如“Navigation 路由传参”“应用签名 证书申请”") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ query }) => knowledge.search(query)),
  );

  server.registerTool(
    "harmonyos_get_docs",
    {
      title: "获取鸿蒙开发者文档全文",
      description: "按文档标识批量获取 HarmonyOS 官方文档全文（Markdown，一次最多 10 篇）。标识来自 harmonyos_search_docs 结果的 parent 字段。",
      inputSchema: {
        names: z.array(z.string()).min(1).max(10).describe("文档标识列表，如 [\"document/cn/harmonyos-guides/abilitykit-overview\"]"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ names }) => knowledge.getDocuments(names)),
  );
}

const eventTarget = {
  openId: z.string().optional().describe("华为分配的 openId（账号绑定场景）；openId 与 sid 至少填一个"),
  sid: z.string().optional().describe("华为分配的 sid（非账号绑定场景）；openId 与 sid 至少填一个"),
};

/** Intents Kit（意图框架）服务端接口：意图共享、事件撤销。使用应用自己的 Client ID / Secret。 */
export function registerIntentsTools(server: McpServer, hag: HagClient, readOnly: boolean): void {
  const guardWrite = (what: string) => {
    if (readOnly) throw new Error(`当前为只读模式（AGC_READ_ONLY=true），已拒绝：${what}`);
  };
  const appParam = z
    .string()
    .optional()
    .describe("应用别名或 Client ID（对应 AGC_APP_CLIENTS_FILE 中的键）；只配置了一个应用时可省略");
  const finish = (res: HagResponse, count: number): CallToolResult =>
    res.status === 200
      ? text({ ok: true, status: 200, events: count })
      : text({ ok: false, status: res.status, response: res.data, hint: HAG_HINTS[res.status] }, true);

  server.registerTool(
    "intents_share_event",
    {
      title: "意图共享（推送事件）",
      description:
        "Intents Kit 意图共享：把用户事件或公共事件推送给小艺，用于事件提醒/推荐（POST hag.cloud.huawei.com/open-ability/v2/service-events/notify）。" +
        "前提：应用已在小艺开放平台完成意图注册并上架。intentEntityInfo 的字段因意图而异，先用 harmonyos_search_docs 查“<意图名> 意图 Schema”。" +
        "会向真实用户推送内容，调用前请与用户确认。",
      inputSchema: {
        app: appParam,
        eventType: z.enum(["USER", "COMMON"]).optional().describe("x-event-type：USER 用户事件 / COMMON 公共事件"),
        events: z
          .array(
            z.object({
              intentName: z.string().describe("意图名称，如 ViewRepayment"),
              identifier: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/).describe("事件唯一标识，撤销时要用到（字母数字和 -，最长 64）"),
              intentEntityInfo: z.record(z.string(), z.unknown()).describe("意图实体，字段见对应垂域意图 Schema"),
              abilityId: z.string().optional().describe("服务 ID（小艺开放平台特性发布后生成的 abilityId）"),
              ...eventTarget,
              overwriteByEventName: z.boolean().optional().describe("是否按事件名覆盖该用户同 Ability 的其他卡片，默认否"),
              overwriteByAbility: z.boolean().optional().describe("是否覆盖该用户同 Ability 的其他卡片，默认是"),
            }),
          )
          .min(1)
          .describe("要推送的事件列表"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ app, eventType, events }) => {
      try {
        guardWrite("意图共享");
        const requestTime = hagRequestTime();
        const body = {
          events: events.map((e) => {
            if (!e.openId && !e.sid) throw new Error(`事件 ${e.identifier}：openId 与 sid 至少填一个`);
            return {
              requestTime,
              abilityId: e.abilityId,
              openId: e.openId,
              sid: e.sid,
              overwriteByEventName: e.overwriteByEventName,
              overwriteByAbility: e.overwriteByAbility,
              content: {
                contentData: [
                  {
                    header: { namespace: "Intent", name: e.intentName },
                    payload: { identifier: e.identifier, intentEntityInfo: e.intentEntityInfo },
                  },
                ],
              },
            };
          }),
          userAgree: true,
        };
        const res = await hag.post("/open-ability/v2/service-events/notify", body, {
          app,
          headers: eventType ? { "x-event-type": eventType } : undefined,
        });
        return finish(res, events.length);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "intents_revoke_event",
    {
      title: "事件撤销",
      description:
        "Intents Kit 事件撤销：事件数据失效时，按推送时的 identifier 撤销，避免继续提醒（POST hag.cloud.huawei.com/open-ability/v2/service-events/revoke）。",
      inputSchema: {
        app: appParam,
        eventType: z.enum(["USER", "COMMON"]).describe("x-event-type：USER 用户事件 / COMMON 公共事件"),
        events: z
          .array(
            z.object({
              identifier: z.string().describe("推送时使用的事件 identifier"),
              abilityId: z.string().describe("上架服务的服务标识 abilityId"),
              ...eventTarget,
              eventName: z.string().optional().describe("事件名（按默认的 REQUEST_ID 方式撤销时可不填）"),
            }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ app, eventType, events }) => {
      try {
        guardWrite("事件撤销");
        const requestTime = hagRequestTime();
        const body = {
          events: events.map((e) => {
            if (!e.openId && !e.sid) throw new Error(`事件 ${e.identifier}：openId 与 sid 至少填一个`);
            return { requestTime, revokeBy: "REQUEST_ID", ...e };
          }),
        };
        const res = await hag.post("/open-ability/v2/service-events/revoke", body, { app, headers: { "x-event-type": eventType } });
        return finish(res, events.length);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

const HAG_HINTS: Record<number, string> = {
  400: "参数错误，见 errorEvents 中的 code / desc",
  401: "应用级 AccessToken 无效或过期：检查该应用的 Client ID / Client Secret",
  403: "网关校验开发者权限失败：确认该应用已在小艺开放平台开通意图框架并完成特性发布",
  404: "未找到用户（sid 没有对应的 uid），见 errorEvents",
};
