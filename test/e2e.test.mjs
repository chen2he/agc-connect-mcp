import assert from "node:assert/strict";
import { constants, createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServiceAccountJwt } from "../dist/auth.js";
import { htmlToMarkdown } from "../dist/html2md.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const serviceAccount = { key_id: "kid123", private_key: privateKey, sub_account: "1000000019" };

function verifyJwt(jwt) {
  const [h, p, s] = jwt.split(".");
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), {
    key: createPublicKey(publicKey),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }, Buffer.from(s, "base64url"));
  return { ok, header: JSON.parse(Buffer.from(h, "base64url")), payload: JSON.parse(Buffer.from(p, "base64url")) };
}

// ───── 模拟 AGC 服务端 ─────
const requests = [];
let base;
const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const json = (o, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    const route = `${req.method} ${url.pathname}`;
    if (url.pathname === "/mcp") return knowledgeMock(req, res, body);
    // 应用级 AccessToken（表单）与 Intents Kit 接口
    if (route === "POST /app-token") {
      const form = new URLSearchParams(body.toString());
      return json({ access_token: `app-token-${form.get("client_id")}`, expires_in: 3600 });
    }
    if (route === "POST /open-ability/v2/service-events/notify") {
      res.writeHead(200);
      return res.end();
    }
    if (route === "POST /open-ability/v2/service-events/revoke") {
      const ev = JSON.parse(body).events[0];
      if (ev.sid === "unknown") return json({ errorEvents: [{ requestId: ev.identifier, resultInfo: { code: "userNotFound", desc: "User is not found" } }] }, 404);
      res.writeHead(200);
      return res.end();
    }
    if (route === "POST /api/oauth2/v1/token") return json({ access_token: "client-token", expires_in: 172800 });
    if (route === "GET /api/publish/v2/upload-url/for-obs") {
      return json({
        ret: { code: 0, msg: "success" },
        urlInfo: {
          objectId: "obj-1",
          url: `${base}/obs/obj-1`,
          method: "PUT",
          headers: { Authorization: "obs-sig", "x-amz-content-sha256": url.searchParams.get("sha256"), "Content-Type": "application/octet-stream" },
        },
      });
    }
    if (route === "PUT /obs/obj-1") {
      const sha = createHash("sha256").update(body).digest("hex");
      return sha === req.headers["x-amz-content-sha256"] && req.headers.authorization === "obs-sig" ? json({}) : json({ bad: true }, 400);
    }
    if (route === "PUT /api/publish/v3/app-package-info") return json({ ret: { code: 0, msg: "success" }, packageId: "pkg-1" });
    if (route === "GET /api/publish/v3/app-info") return json({ ret: { code: 204144660, msg: "app not found" } });
    if (route === "GET /api/project-service/v1/projects") {
      return json({ ret: '{"code":0,"msg":"ok"}', totalCount: 2, projectList: [{ projectId: "p1", appList: [] }, { projectId: "p2", appList: [] }] });
    }
    if (url.pathname.startsWith("/api/project-service/v1/projects/")) {
      const id = url.pathname.split("/").pop();
      const appList = url.searchParams.get("queryFlag") === "1" ? [{ appId: `${id}-app`, appName: "App", packageName: `com.${id}` }] : undefined;
      return json({ ret: { code: 0, msg: "success" }, project: { projectId: id, name: `Project ${id}`, appList } });
    }
    if (route === "GET /api/pms/product-price-service/v2/manage/product/check") {
      if (!req.headers.appid) return json({ error: { errorCode: 6000, errorMsg: "appId missing" } });
      return json({ checkInfos: [], error: { errorCode: 0, errorMsg: "success" } });
    }
    if (route === "GET /api/publish/v2/appid-list") return json({ ret: { code: 0, msg: "success" }, appids: [] });
    if (url.pathname.startsWith("/api/report/harmony-report/v1/harmony/appDownloadAnalysisExport/")) {
      return json({ ret: { code: 0 }, fileURL: `${base}/files/report.csv` });
    }
    if (route === "GET /files/report.csv") {
      res.writeHead(200, { "Content-Type": "text/csv" });
      return res.end("﻿日期,新下载成功次数\n20260901,10\n20260902,12\n");
    }
    if (route === "GET /api/marketing-api/v2/reviews/manage/dev/reviews") {
      // 真实接口不接受 Service Account 的 JWT
      if (req.headers.authorization !== "Bearer client-token") return json({ ret: { code: 205524993, msg: "client token auth failed" } }, 401);
      if (url.searchParams.get("appId") === "not-mine") return json({ rtnCode: 50010028, rtnDesc: "user or app auth validate failed, noPermission", data: [] });
      return json({ rtnCode: 0, rtnDesc: "success", data: [], total: 0 });
    }
    json({ error: "not mocked", route }, 404);
  });
});

// 模拟“鸿蒙开发者知识 MCP”（与真实服务一样：参数包在 SearchDocumentsReq / GetDocumentsByIdRequest 里）
function knowledgeMock(req, res, body) {
  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end();
  }
  const msg = JSON.parse(body);
  if (!("id" in msg)) {
    res.writeHead(202);
    return res.end();
  }
  const reply = (result) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  };
  if (msg.method === "initialize") {
    return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } });
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    const data =
      name === "searchDocuments"
        ? { code: 0, message: "success", resultList: [{ parent: "document/cn/harmonyos-guides/x", content: `hit:${args.SearchDocumentsReq.query}` }] }
        : { code: 0, message: "success", resultList: args.GetDocumentsByIdRequest.names.map((n) => ({ name: n, title: "T", content: "# full" })) };
    return reply({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
  }
  reply({});
}

// 离线文档缓存：用自拟的小样例代替在线拉取，测试不依赖网络
const docsCache = mkdtempSync(join(tmpdir(), "agc-docs-"));
const fixture = (id, html) =>
  writeFileSync(join(docsCache, `${id}.json`), JSON.stringify({ title: "fixture", html, updated: "2026-01-01", fetchedAt: Date.now() }));
fixture(
  "agc-help-publish-api-app-submit-0000002271160585",
  `<h1>提交发布</h1><h4>请求参数</h4><p>[h2]Header</p>
   <table><tr><th>参数名称</th><th>必选(M)/可选(O)</th><th>类型</th><th>参数说明</th></tr>
   <tr><td>client_id</td><td>M</td><td>String</td><td>客户端ID</td></tr></table>
   <p>[h2]Body</p><table><tr><th>参数名称</th><th>必选(M)/可选(O)</th><th>类型</th><th>参数说明</th></tr>
   <tr><td>phasedReleaseDescription</td><td>O</td><td>String</td><td>分阶段发布说明</td></tr></table>
   <h4>调用示例</h4><pre>public static void submit() {}</pre>`,
);
fixture(
  "agcapi-isproductactive-harmonyosnext-0000002166670145",
  `<h1>查询是否有在线商品</h1><h4>请求参数</h4><p>[h2]Header</p>
   <table><tr><th>参数</th><th>必选(M)/可选(O)</th><th>类型</th><th>描述</th></tr>
   <tr><td>client_id</td><td>M</td><td>String</td><td>客户端ID</td></tr>
   <tr><td>Authorization</td><td>M</td><td>String</td><td>认证信息</td></tr>
   <tr><td>appId</td><td>M</td><td>String</td><td>应用ID</td></tr></table><h4>响应参数</h4>`,
);

const appClientsFile = join(mkdtempSync(join(tmpdir(), "agc-apps-")), "apps.json");
writeFileSync(appClientsFile, JSON.stringify({ "app-a": { client_id: "111", client_secret: "s1" }, "app-b": { client_id: "222", client_secret: "s2" } }));

async function startClient(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "dist", "index.js")],
    env: { PATH: process.env.PATH, AGC_API_BASE_URL: base, AGC_DOCS_CACHE_DIR: docsCache, AGC_KNOWLEDGE_MCP_URL: `${base}/mcp`,
      AGC_HAG_BASE_URL: base, AGC_APP_TOKEN_URL: `${base}/app-token`, AGC_APP_CLIENTS_FILE: appClientsFile, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: !!r.isError, data, text };
};

before(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${mock.address().port}`;
});
after(() => mock.close());

test("HTML 转 Markdown：表格、代码块、实体", () => {
  const md = htmlToMarkdown(
    `<h1>标题</h1><p>a &amp; b</p><table><tr><th>参数</th><th>说明</th></tr><tr><td><p>x</p><p>y|z</p></td><td>&lt;List&gt;</td></tr></table>` +
      `<pre>GET /a?x=1&amp;current=2\n  indented</pre><p>[h2]Query</p>`,
  );
  assert.match(md, /^# 标题/);
  assert.match(md, /a & b/);
  assert.match(md, /\| 参数 \| 说明 \|\n\|---\|---\|\n\| x<br>y\\\|z \| <List> \|/);
  assert.match(md, /```\nGET \/a\?x=1&current=2\n  indented\n```/);
  assert.match(md, /##### Query/);
});

test("Service Account JWT 使用 PS256 签名且字段符合文档", () => {
  const jwt = createServiceAccountJwt(serviceAccount, 1_700_000_000);
  const { ok, header, payload } = verifyJwt(jwt);
  assert.ok(ok, "签名校验失败");
  assert.deepEqual(header, { kid: "kid123", typ: "JWT", alg: "PS256" });
  assert.deepEqual(payload, {
    aud: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
    iss: "1000000019",
    exp: 1_700_003_600,
    iat: 1_700_000_000,
  });
});

describe("API 客户端凭据", () => {
  let client;
  before(async () => {
    client = await startClient({ AGC_CLIENT_ID: "cid", AGC_CLIENT_SECRET: "secret" });
  });
  after(() => client.close());

  test("列出全部工具", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "agc_auth_status", "agc_get_api_doc", "agc_get_app_id", "agc_get_app_info", "agc_get_package_compile_status",
      "agc_get_ratings", "agc_get_report", "agc_list_apps", "agc_list_reviews", "agc_reply_review", "agc_request",
      "agc_search_api", "agc_submit_app", "agc_update_app_package", "agc_upload_file",
      "harmonyos_get_docs", "harmonyos_search_docs", "intents_revoke_event", "intents_share_event",
    ]);
  });

  test("搜索目录与读取文档", async () => {
    const s = await call(client, "agc_search_api", { query: "提交发布", platform: "harmonyos" });
    const hit = s.data.endpoints.find((e) => e.path === "/api/publish/v3/app-submit");
    assert.ok(hit, JSON.stringify(s.data).slice(0, 500));
    const d = await call(client, "agc_get_api_doc", { docId: hit.doc });
    assert.match(d.text, /phasedReleaseDescription/);
    assert.doesNotMatch(d.text, /public static void/);
  });

  test("获取 token 并携带 client_id 调用接口", async () => {
    const r = await call(client, "agc_get_app_id", { packageNames: "com.example" });
    assert.equal(r.isError, false, r.text);
    const req = requests.findLast((x) => x.path.endsWith("appid-list"));
    assert.equal(req.headers.authorization, "Bearer client-token");
    assert.equal(req.headers.client_id, "cid");
    const tokenReq = requests.find((x) => x.path === "/api/oauth2/v1/token");
    assert.deepEqual(JSON.parse(tokenReq.body), { grant_type: "client_credentials", client_id: "cid", client_secret: "secret" });
  });

  test("agc_list_apps 汇总各项目下的应用；ret 为字符串也能识别", async () => {
    const r = await call(client, "agc_list_apps");
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.data.projects.map((p) => p.apps[0].packageName), ["com.p1", "com.p2"]);
  });

  test("仅限 OAuth 的接口直接拒绝，不发请求", async () => {
    const before = requests.length;
    const r = await call(client, "agc_request", { method: "GET", path: "/api/ups/user-permission-service/v1/user-team-list" });
    assert.equal(r.isError, true);
    assert.match(r.text, /只支持 OAuth/);
    assert.equal(requests.length, before);
  });

  test("PMS 文档保留非鉴权请求头，error.errorCode 能识别为错误", async () => {
    const s = await call(client, "agc_search_api", { query: "查询是否有在线商品", platform: "harmonyos" });
    const doc = await call(client, "agc_get_api_doc", { docId: s.data.endpoints[0].doc });
    assert.match(doc.text, /\| appId \| M \|/);
    assert.doesNotMatch(doc.text, /\| client_id \| M \|/);
    const path = "/api/pms/product-price-service/v2/manage/product/check";
    assert.equal((await call(client, "agc_request", { method: "GET", path })).isError, true);
    assert.equal((await call(client, "agc_request", { method: "GET", path, headers: { appId: "123" } })).isError, false);
  });

  test("评论 50010028 附带排查提示", async () => {
    const r = await call(client, "agc_list_reviews", { appId: "not-mine", platform: "harmonyos", begin: "2026-09-01", end: "2026-09-02" });
    assert.equal(r.isError, true);
    assert.match(r.data.hint, /尚未正式上架/);
  });

  test("鸿蒙知识库工具：展平参数后转发给远程 MCP", async () => {
    const s = await call(client, "harmonyos_search_docs", { query: "Navigation 传参" });
    assert.equal(s.isError, false, s.text);
    assert.equal(s.data.resultList[0].content, "hit:Navigation 传参");
    const g = await call(client, "harmonyos_get_docs", { names: ["document/cn/a", "document/cn/b"] });
    assert.deepEqual(g.data.resultList.map((d) => d.name), ["document/cn/a", "document/cn/b"]);
  });

  test("意图共享：应用凭据换 token、x-appid、请求体结构", async () => {
    const event = { intentName: "ViewRepayment", identifier: "evt-1", sid: "sid-1", abilityId: "ab1", intentEntityInfo: { bankName: "x" } };
    const r = await call(client, "intents_share_event", { app: "app-a", eventType: "USER", events: [event] });
    assert.equal(r.isError, false, r.text);
    const tokenReq = requests.findLast((x) => x.path === "/app-token");
    assert.match(tokenReq.headers["content-type"], /x-www-form-urlencoded/);
    assert.equal(new URLSearchParams(tokenReq.body.toString()).get("client_secret"), "s1");
    const req = requests.findLast((x) => x.path.endsWith("/service-events/notify"));
    assert.equal(req.headers["x-appid"], "111");
    assert.equal(req.headers.authorization, "Bearer app-token-111");
    assert.equal(req.headers["x-event-type"], "USER");
    const body = JSON.parse(req.body);
    assert.equal(body.userAgree, true);
    assert.match(body.events[0].requestTime, /^\d{17}$/);
    assert.deepEqual(body.events[0].content.contentData[0], {
      header: { namespace: "Intent", name: "ViewRepayment" },
      payload: { identifier: "evt-1", intentEntityInfo: { bankName: "x" } },
    });
  });

  test("意图共享：多个应用须指定 app；openId/sid 都缺时不发请求", async () => {
    const before = requests.length;
    const noApp = await call(client, "intents_share_event", { events: [{ intentName: "A", identifier: "e", sid: "s", intentEntityInfo: {} }] });
    assert.match(noApp.text, /app-a \/ app-b/);
    const noTarget = await call(client, "intents_share_event", { app: "app-a", events: [{ intentName: "A", identifier: "e", intentEntityInfo: {} }] });
    assert.match(noTarget.text, /openId 与 sid 至少填一个/);
    assert.equal(requests.length, before);
  });

  test("事件撤销：404 返回错误详情与提示", async () => {
    const ok = await call(client, "intents_revoke_event", { app: "app-b", eventType: "USER", events: [{ identifier: "evt-1", abilityId: "ab1", sid: "sid-1" }] });
    assert.equal(ok.isError, false, ok.text);
    const req = requests.findLast((x) => x.path.endsWith("/service-events/revoke"));
    assert.equal(req.headers["x-appid"], "222");
    assert.equal(JSON.parse(req.body).events[0].revokeBy, "REQUEST_ID");
    const bad = await call(client, "intents_revoke_event", { app: "app-b", eventType: "USER", events: [{ identifier: "e2", abilityId: "ab1", sid: "unknown" }] });
    assert.equal(bad.isError, true);
    assert.equal(bad.data.status, 404);
    assert.match(bad.data.hint, /未找到用户/);
  });

  test("业务错误码返回 isError", async () => {
    const r = await call(client, "agc_get_app_info", { appId: "1", platform: "harmonyos" });
    assert.equal(r.isError, true);
    assert.match(r.text, /204144660/);
  });

  test("上传并关联 HarmonyOS 软件包", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agc-test-"));
    const file = join(dir, "entry-default-signed.app");
    writeFileSync(file, Buffer.alloc(300_000, 7));
    const r = await call(client, "agc_update_app_package", { appId: "123", platform: "harmonyos", filePath: file, chineseMainlandFlag: 1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.upload.objectId, "obj-1");
    assert.equal(r.data.result.packageId, "pkg-1");
    const urlReq = requests.findLast((x) => x.path.endsWith("/upload-url/for-obs"));
    assert.equal(urlReq.query.get("contentLength"), "300000");
    assert.equal(urlReq.query.get("chineseMainlandFlag"), "1");
    const put = requests.findLast((x) => x.path === "/api/publish/v3/app-package-info");
    assert.equal(put.query.get("appId"), "123");
    assert.deepEqual(JSON.parse(put.body), { fileName: "entry-default-signed.app", objectId: "obj-1" });
  });

  test("导出报表：数组过滤器展开 + 下载预览", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agc-report-"));
    const r = await call(client, "agc_get_report", {
      appId: "123",
      report: "harmony-download",
      startDate: "2026-09-01",
      endDate: "2026-09-02",
      filters: { countryId: "CN", appVersion: "1.0.0" },
      downloadTo: dir,
    });
    assert.equal(r.isError, false, r.text);
    const req = requests.findLast((x) => x.path.includes("appDownloadAnalysisExport"));
    assert.equal(req.query.get("startTime"), "20260901");
    assert.deepEqual(req.query.getAll("filterCondition"), ["countryId", "appVersion"]);
    assert.deepEqual(req.query.getAll("filterConditionValue"), ["CN", "1.0.0"]);
    assert.match(r.data.preview, /20260902,12/);
    assert.match(readFileSync(r.data.savedTo, "utf8"), /新下载成功次数/);
  });

  test("评论查询把日期转换为北京时间毫秒", async () => {
    const r = await call(client, "agc_list_reviews", { appId: "123", platform: "harmonyos", begin: "2026-09-01", end: "2026-09-01" });
    assert.equal(r.isError, false, r.text);
    const req = requests.findLast((x) => x.path.endsWith("/dev/reviews"));
    assert.equal(req.query.get("beginTime"), String(Date.parse("2026-09-01T00:00:00+08:00")));
    assert.equal(req.query.get("endTime"), String(Date.parse("2026-09-01T23:59:59.999+08:00")));
    assert.equal(req.query.get("countries"), "CN");
  });

  test("agc_request 拒绝向非华为域名发送凭据", async () => {
    const r = await call(client, "agc_request", { method: "GET", path: "https://evil.example.com/api/x" });
    assert.equal(r.isError, true);
    assert.match(r.text, /拒绝/);
  });
});

describe("Service Account 凭据 + 只读模式", () => {
  let client;
  before(async () => {
    client = await startClient({ AGC_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount), AGC_READ_ONLY: "true" });
  });
  after(() => client.close());

  test("使用 JWT 作为 Bearer，且不发送 client_id", async () => {
    const r = await call(client, "agc_get_app_id", { packageNames: "com.example" });
    assert.equal(r.isError, false, r.text);
    const req = requests.findLast((x) => x.path.endsWith("appid-list"));
    assert.equal(req.headers.client_id, undefined);
    const jwt = req.headers.authorization.replace(/^Bearer /, "");
    assert.ok(verifyJwt(jwt).ok);
  });

  test("只读模式拦截写操作，但放行 POST 查询接口", async () => {
    const before = requests.length;
    const submit = await call(client, "agc_submit_app", { appId: "1", platform: "harmonyos" });
    assert.equal(submit.isError, true);
    assert.match(submit.text, /只读模式/);
    const put = await call(client, "agc_request", { method: "PUT", path: "/api/publish/v3/app-info", query: { appId: "1" }, body: {} });
    assert.match(put.text, /只读模式/);
    assert.equal(requests.length, before, "被拦截的请求不应发出");
    const share = await call(client, "intents_share_event", { app: "app-a", events: [{ intentName: "A", identifier: "e", sid: "s", intentEntityInfo: {} }] });
    assert.match(share.text, /只读模式/);
    const list = await call(client, "agc_request", { method: "POST", path: "/api/pms/product-price-service/v2/manage/product/list", body: {} });
    assert.doesNotMatch(list.text, /只读模式/);
  });
});

describe("仅 Service Account 调用只支持 API 客户端的接口", () => {
  let client;
  before(async () => {
    client = await startClient({ AGC_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount) });
  });
  after(() => client.close());

  test("401 时提示需要配置 API 客户端", async () => {
    const r = await call(client, "agc_list_reviews", { appId: "1", platform: "harmonyos", begin: "2026-09-01", end: "2026-09-02" });
    assert.equal(r.isError, true);
    assert.match(r.text, /只支持 API 客户端/);
  });
});

describe("同时配置两种凭据", () => {
  let client;
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "agc-cred-"));
    const clientFile = join(dir, "client.json");
    writeFileSync(clientFile, JSON.stringify({ client_id: "cid2", client_secret: "s2" }));
    client = await startClient({ AGC_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount), AGC_CLIENT_FILE: clientFile });
  });
  after(() => client.close());

  test("按接口文档自动选择凭据", async () => {
    assert.equal((await call(client, "agc_list_reviews", { appId: "1", platform: "harmonyos", begin: "2026-09-01", end: "2026-09-02" })).isError, false);
    const reviews = requests.findLast((x) => x.path.endsWith("/dev/reviews"));
    assert.equal(reviews.headers.client_id, "cid2");

    assert.equal((await call(client, "agc_get_app_id", { packageNames: "com.example" })).isError, false);
    const appid = requests.findLast((x) => x.path.endsWith("appid-list"));
    assert.equal(appid.headers.client_id, undefined);
    assert.ok(verifyJwt(appid.headers.authorization.slice(7)).ok);
  });

  test("agc_request 可强制指定凭据", async () => {
    const r = await call(client, "agc_request", { method: "GET", path: "/api/publish/v2/appid-list", query: { packageName: "x" }, auth: "api_client" });
    assert.equal(r.data.auth, "api_client");
  });

  test("agc_auth_status 逐一验证两种凭据", async () => {
    const r = await call(client, "agc_auth_status");
    assert.equal(r.isError, false, r.text);
    assert.match(r.data.checks.service_account, /^OK/);
    assert.match(r.data.checks.api_client, /^OK/);
    assert.match(r.data.coverage, /OAuth/);
    assert.deepEqual(Object.keys(r.data.intentsApps), ["app-a", "app-b"]);
    assert.ok(Object.values(r.data.intentsApps).every((v) => v.startsWith("OK")));
  });
});
