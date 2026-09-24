/** 把华为文档中心返回的 HTML 转成 Markdown（重点保留参数表格与代码块）。 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

interface Table {
  rows: string[][];
  row: string[] | null;
  cell: string[] | null;
}

export function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  const tables: Table[] = [];
  let pre = 0;
  let skip = 0;

  const write = (t: string) => {
    const table = tables.at(-1);
    if (table?.cell) table.cell.push(t);
    else out.push(t);
  };

  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>|([^<]+|<)/g;
  for (const m of html.matchAll(token)) {
    const [, closing, rawTag, text] = m;
    if (text !== undefined) {
      if (skip) continue;
      const decoded = decodeEntities(text);
      write(pre ? decoded : decoded.replace(/\s+/g, " "));
      continue;
    }
    if (!rawTag) continue; // 注释
    const tag = rawTag.toLowerCase();
    const table = tables.at(-1);

    if (!closing) {
      if (tag === "script" || tag === "style") skip++;
      else if (tag === "pre") {
        pre++;
        write("\n```\n");
      } else if (/^h[1-4]$/.test(tag)) write(`\n\n${"#".repeat(Number(tag[1]))} `);
      else if (tag === "p" || tag === "div" || tag === "br") write("\n");
      else if (tag === "li") write("\n- ");
      else if (tag === "table") tables.push({ rows: [], row: null, cell: null });
      else if (tag === "tr" && table) table.row = [];
      else if ((tag === "td" || tag === "th") && table) table.cell = [];
      else if (tag === "code" && !pre) write("`");
      else if ((tag === "strong" || tag === "b") && !pre) write("**");
      continue;
    }

    if (tag === "script" || tag === "style") skip--;
    else if (tag === "pre") {
      pre--;
      write("\n```\n");
    } else if (/^h[1-4]$/.test(tag) || tag === "p") write("\n");
    else if ((tag === "td" || tag === "th") && table?.cell) {
      let c = table.cell.join("");
      c = c.replace(/[ \t\r\f\v]+/g, " ").trim();
      c = c.replace(/\s*\n\s*/g, "<br>").replace(/(<br>)+/g, "<br>").replace(/\|/g, "\\|");
      c = c.replace(/^(<br>)+|(<br>)+$/g, "");
      table.cell = null;
      table.row?.push(c);
    } else if (tag === "tr" && table?.row) {
      table.rows.push(table.row);
      table.row = null;
    } else if (tag === "table" && table) {
      tables.pop();
      const rows = table.rows.filter((r) => r.length);
      if (rows.length) {
        const n = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) => [...r, ...Array(n - r.length).fill("")];
        const line = (r: string[]) => `| ${pad(r).join(" | ")} |\n`;
        write(`\n\n${line(rows[0])}|${"---|".repeat(n)}\n${rows.slice(1).map(line).join("")}\n`);
      }
    } else if (tag === "code" && !pre) write("`");
    else if ((tag === "strong" || tag === "b") && !pre) write("**");
  }

  return out
    .join("")
    .replace(/(#+ )?\[h2\]/g, "##### ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
