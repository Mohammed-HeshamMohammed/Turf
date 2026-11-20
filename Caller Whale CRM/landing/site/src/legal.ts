// The legal pages are written in Markdown (./legal/*.md) and drawn by the site. parseLegal turns the text into blocks; LegalPage (PublicPages.tsx) draws them.
// Supported: # title, ## and ### headings, paragraphs, "- " and "1. " lists, | tables |, **bold**, [text](/path or https://...), and [PLACEHOLDERS] in capitals.

export type Inline = { kind: "text" | "bold" | "link" | "placeholder"; text: string; href?: string };
export type Block =
  | { kind: "h1" | "h2" | "h3" | "p"; inline: Inline[] }
  | { kind: "ul" | "ol"; items: Inline[][] }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] };

export function inlineOf(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\[([A-Z][A-Z0-9 ,.'/-]{3,})\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ kind: "bold", text: match[1] });
    else if (match[2] !== undefined) out.push({ kind: "link", text: match[2], href: match[3] });
    else out.push({ kind: "placeholder", text: match[4] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function parseLegal(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "p", inline: inlineOf(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: (["h1", "h2", "h3"] as const)[heading[1].length - 1], inline: inlineOf(heading[2]) }); continue; }
    if (/^\|.*\|$/.test(line)) {
      flush();
      const cells = (row: string) => row.slice(1, -1).split("|").map(cell => inlineOf(cell.trim()));
      const head = cells(line);
      i += 1; // the |---| line
      const rows: Inline[][][] = [];
      while (i + 1 < lines.length && /^\|.*\|$/.test(lines[i + 1])) { i += 1; rows.push(cells(lines[i])); }
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const bullet = /^- (.+)$/.exec(line);
    const numbered = /^\d+\. (.+)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const items: Inline[][] = [inlineOf((bullet || numbered)![1])];
      while (i + 1 < lines.length && (kind === "ul" ? /^- /.test(lines[i + 1]) : /^\d+\. /.test(lines[i + 1]))) {
        i += 1;
        items.push(inlineOf(lines[i].replace(kind === "ul" ? /^- / : /^\d+\. /, "")));
      }
      blocks.push({ kind, items });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** The version line at the top of a legal text ("Version 2026-11-10"), for the page's "last updated" label. */
export const versionOf = (source: string) => /^Version (\d{4}-\d{2}-\d{2})/m.exec(source)?.[1] || "";
