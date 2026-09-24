import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Endpoint {
  doc: string;
  title: string;
  group: string;
  platform: "harmonyos" | "android" | "common";
  method: string;
  path: string | null;
  url: string;
  /** 文档中列出的鉴权方式 */
  auth: Array<"service_account" | "api_client" | "oauth">;
}

export interface DocIndexEntry {
  title: string;
  /** 华为文档中心的目录名，用于在线拉取正文 */
  catalog: string;
  path: string[];
  group: string;
  platform: string;
  updated?: string;
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

let endpoints: Endpoint[] | undefined;
let docIndex: Record<string, DocIndexEntry> | undefined;

export function getEndpoints(): Endpoint[] {
  endpoints ??= JSON.parse(readFileSync(join(DATA_DIR, "endpoints.json"), "utf8")) as Endpoint[];
  return endpoints;
}

export function getDocIndex(): Record<string, DocIndexEntry> {
  docIndex ??= JSON.parse(readFileSync(join(DATA_DIR, "doc-index.json"), "utf8")) as Record<string, DocIndexEntry>;
  return docIndex;
}

export function docUrl(id: string, entry: DocIndexEntry): string {
  return `https://developer.huawei.com/consumer/cn/doc/${entry.catalog}/${id}`;
}

function score(haystack: string, terms: string[]): number {
  const h = haystack.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (!h.includes(t)) return 0;
    s += 1;
  }
  return s;
}

/** 在内置目录中搜索端点和其他文档（数据模型、错误码、附录等，按标题匹配）。 */
export function search(query: string, opts: { group?: string; platform?: string; limit?: number } = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matchFilters = (group: string, platform: string) =>
    (!opts.group || group.toLowerCase().includes(opts.group.toLowerCase())) &&
    (!opts.platform || platform === opts.platform || platform === "common");

  const eps = getEndpoints()
    .filter((e) => matchFilters(e.group, e.platform))
    .map((e) => {
      const titleHit = score(e.title, terms) * 3;
      const pathHit = score(`${e.method} ${e.path ?? e.url}`, terms) * 2;
      const all = score(`${e.title} ${e.group} ${e.method} ${e.path ?? e.url} ${e.doc}`, terms);
      return { e, s: terms.length ? titleHit + pathHit + all : 1 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.limit ?? 30)
    .map((x) => x.e);

  const endpointDocs = new Set(getEndpoints().map((e) => e.doc));
  const otherDocs = terms.length
    ? Object.entries(getDocIndex())
        .filter(([id, d]) => !endpointDocs.has(id) && matchFilters(d.group, d.platform))
        .map(([id, d]) => ({ id, d, s: score(`${d.title} ${d.path.join(" ")} ${id}`, terms) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 15)
        .map(({ id, d }) => ({ doc: id, title: d.title, group: d.group, platform: d.platform }))
    : [];
  return { endpoints: eps, docs: otherDocs };
}

export function findDoc(idOrTitle: string): { id: string; entry: DocIndexEntry } | undefined {
  const all = getDocIndex();
  if (all[idOrTitle]) return { id: idOrTitle, entry: all[idOrTitle] };
  const q = idOrTitle.toLowerCase();
  const hit = Object.entries(all).find(([id, d]) => id.toLowerCase().includes(q) || d.title.toLowerCase() === q);
  return hit ? { id: hit[0], entry: hit[1] } : undefined;
}

export function pathMatches(template: string, actual: string): boolean {
  const re = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+")}$`);
  return re.test(actual);
}

const AUTH_ORDER = ["service_account", "api_client", "oauth"] as const;

/**
 * 按方法和路径在目录中查找端点（路径参数按 {xxx} 通配）。
 * 同一路径可能同时出现在 Android / HarmonyOS 两份文档中，鉴权方式取并集（同一个服务端接口）。
 */
export function findEndpoint(method: string, path: string): Endpoint | undefined {
  const clean = path.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const candidates = getEndpoints().filter((e) => e.path && e.method === method && pathMatches(e.path, clean));
  if (!candidates.length) return undefined;
  const modes = new Set(candidates.flatMap((e) => e.auth));
  return { ...candidates[0], auth: AUTH_ORDER.filter((m) => modes.has(m)) };
}
