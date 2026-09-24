import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { htmlToMarkdown } from "./html2md.js";

/** 华为开发者文档中心的公开 JSON 接口（文档页面本身是前端渲染的）。 */
const PORTAL = "https://svc-drcn.developer.huawei.com/community/servlet/consumer/cn/documentPortal";
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

export interface CatalogNode {
  nodeName: string;
  relateDocument?: string;
  isLeaf?: boolean;
  children?: CatalogNode[];
}

export interface RawDoc {
  title: string;
  html: string;
  updated?: string;
}

async function post<T>(api: string, body: unknown): Promise<T> {
  const res = await fetch(`${PORTAL}/${api}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json()) as { code?: number; message?: string; value?: T };
  if (!res.ok || !json.value) throw new Error(`华为文档中心接口 ${api} 调用失败：HTTP ${res.status} ${json.message ?? ""}`);
  return json.value;
}

export async function fetchCatalogTree(anchorDoc: string, catalogName: string): Promise<CatalogNode[]> {
  const v = await post<{ catalogTreeList: CatalogNode[] }>("getCatalogTree", {
    objectId: anchorDoc,
    version: "",
    catalogName,
    language: "cn",
  });
  return v.catalogTreeList;
}

export async function fetchRawDoc(docId: string, catalogName: string): Promise<RawDoc> {
  const v = await post<{ title: string; content: { content: string }; updatedDate?: string }>("getDocumentById", {
    objectId: docId,
    version: "",
    catalogName,
    language: "cn",
  });
  return { title: v.title, html: v.content.content, updated: v.updatedDate };
}

export function docsCacheDir(): string {
  return process.env.AGC_DOCS_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "agc-connect-mcp", "docs");
}

/** 读取文档 Markdown：优先本地缓存（7 天内），否则在线拉取；拉取失败时退回过期缓存。 */
export async function loadDocMarkdown(docId: string, catalogName: string): Promise<RawDoc & { markdown: string; cached: boolean }> {
  const file = join(docsCacheDir(), `${docId}.json`);
  let cached: (RawDoc & { fetchedAt: number }) | undefined;
  try {
    cached = JSON.parse(await readFile(file, "utf8"));
  } catch {
    /* 无缓存 */
  }
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached, markdown: htmlToMarkdown(cached.html), cached: true };
  }
  try {
    const raw = await fetchRawDoc(docId, catalogName);
    await mkdir(docsCacheDir(), { recursive: true });
    await writeFile(file, JSON.stringify({ ...raw, fetchedAt: Date.now() }));
    return { ...raw, markdown: htmlToMarkdown(raw.html), cached: false };
  } catch (err) {
    if (cached) return { ...cached, markdown: htmlToMarkdown(cached.html), cached: true };
    throw err;
  }
}
