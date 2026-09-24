/**
 * 维护脚本：从华为开发者文档中心抓取 Connect API 参考文档，生成 data/endpoints.json 与 data/doc-index.json。
 * 只保存接口元数据（方法、路径、标题、鉴权方式），不保存文档正文；正文在运行时按需在线拉取。
 *
 * 用法：npm run update-catalog [-- --refresh]
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToMarkdown } from "./html2md.js";
import { fetchCatalogTree, fetchRawDoc, type CatalogNode, type RawDoc } from "./portal.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_CACHE = join(ROOT, ".cache", "docs");
const DATA = join(ROOT, "data");

interface Source {
  catalog: string;
  anchor: string;
  isRoot: (n: CatalogNode) => boolean;
}

const SOURCES: Source[] = [
  // Android 及 HarmonyOS 4 及以下、以及通用接口
  { catalog: "AppGallery-connect-References", anchor: "agcapi-obtain_token-0000001158365043", isRoot: (n) => n.nodeName.trim() === "Connect API" },
  // HarmonyOS 5 及以上
  {
    catalog: "app",
    anchor: "agc-help-publish-api-reference-0000002271160565",
    isRoot: (n) => (n.relateDocument ?? "").startsWith("agc-help-connect-api-0000002236015554"),
  },
];
const EXTRA = [{ catalog: "AppGallery-connect-Guides", doc: "agcapi-getstarted-0000001111845114", path: ["Connect API", "使用入门"] }];

interface Item {
  catalog: string;
  doc: string;
  path: string[];
}

function collect(nodes: CatalogNode[], path: string[], inside: boolean, src: Source, out: Item[]) {
  for (const n of nodes) {
    const nowInside = inside || src.isRoot(n);
    const p = nowInside ? [...path, n.nodeName.trim()] : [];
    if (nowInside && n.relateDocument) out.push({ catalog: src.catalog, doc: n.relateDocument, path: p });
    collect(n.children ?? [], p, nowInside, src, out);
  }
}

function groupOf(path: string[]): string {
  for (const part of path) {
    const m = part.match(/^(.*?API)(指南|参考)?$/);
    if (m && part !== "Connect API" && part !== "AppGallery Connect API") return m[1];
  }
  return path.find((p) => ["在玩服务", "游戏道具商城", "资源包预下载", "附录"].includes(p)) ?? "Auth";
}

function platformOf(item: Item): string {
  const joined = item.path.join(" ");
  if (item.catalog === "app" || joined.includes("HarmonyOS 5")) return "harmonyos";
  if (joined.includes("Android") || joined.includes("HarmonyOS 3.1")) return "android";
  return "common";
}

function authModes(md: string): string[] {
  if (md.includes("只支持OAuth")) return ["oauth"];
  const modes = (
    [
      ["service_account", "Service Account"],
      ["api_client", "client_id"],
      ["oauth", "oauth2Token"],
    ] as const
  )
    .filter(([, kw]) => md.includes(kw))
    .map(([m]) => m);
  return modes.length ? modes : ["api_client"];
}

function endpointOf(md: string) {
  const cell = (label: string) => md.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*([^|\\n]+?)\\s*\\|`))?.[1].trim();
  const methodCell = cell("承载协议");
  const urlCell = cell("接口URL");
  if (!methodCell || !urlCell) return undefined;
  const method = methodCell.replace(/^HTTPS?\s*/, "").split("<br>")[0].trim().toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method)) return undefined;
  const url = urlCell.split("<br>")[0].trim();
  const m = url.match(/^https:\/\/(\{domain\}|connect-api[a-z-]*\.cloud\.huawei\.com)(\/[^?\s]*)/);
  return { method, path: m ? m[2].replace(/ /g, "") : null, url };
}

async function loadRaw(item: Item, refresh: boolean): Promise<RawDoc> {
  const file = join(RAW_CACHE, `${item.doc}.json`);
  if (!refresh && existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
  const raw = await fetchRawDoc(item.doc, item.catalog);
  await writeFile(file, JSON.stringify(raw));
  return raw;
}

async function main() {
  const refresh = process.argv.includes("--refresh");
  await mkdir(RAW_CACHE, { recursive: true });
  const items: Item[] = [];
  for (const src of SOURCES) collect(await fetchCatalogTree(src.anchor, src.catalog), [], false, src, items);
  items.push(...EXTRA);
  console.log(`${items.length} documents in catalog`);

  const raws = new Map<string, RawDoc>();
  for (let i = 0; i < items.length; i += 8) {
    const batch = items.slice(i, i + 8);
    const loaded = await Promise.all(batch.map((it) => loadRaw(it, refresh)));
    batch.forEach((it, j) => raws.set(it.doc, loaded[j]));
  }

  const docIndex: Record<string, unknown> = {};
  const endpoints: unknown[] = [];
  for (const it of items) {
    const raw = raws.get(it.doc)!;
    const md = htmlToMarkdown(raw.html);
    const group = groupOf(it.path);
    const platform = platformOf(it);
    docIndex[it.doc] = { title: raw.title, catalog: it.catalog, path: it.path, group, platform, updated: raw.updated };
    const ep = endpointOf(md);
    if (ep) endpoints.push({ doc: it.doc, title: raw.title, group, platform, ...ep, auth: authModes(md) });
  }

  await mkdir(DATA, { recursive: true });
  await writeFile(join(DATA, "doc-index.json"), `${JSON.stringify(docIndex, null, 1)}\n`);
  await writeFile(join(DATA, "endpoints.json"), `${JSON.stringify(endpoints, null, 1)}\n`);
  console.log(`wrote ${Object.keys(docIndex).length} doc index entries, ${endpoints.length} endpoints`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
