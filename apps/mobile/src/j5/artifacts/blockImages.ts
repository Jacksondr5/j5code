// An image, or inline code to leave alone; an image inside a link (`[![a](b)](c)`) stays inline.
const TOKEN = /`[^`]*`|(?<!\[)!\[[^\]]*\]\((?:[^()\s]|\([^()]*\))+(?:\s+"[^"]*")?\)/g;
const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|/;

/** The line's parts, with each image apart from its text; null when it holds no image. */
function imageParts(line: string): string[] | null {
  const parts: string[] = [];
  let rest = 0;
  for (const match of line.matchAll(TOKEN)) {
    if (match[0].startsWith("`")) continue;
    parts.push(line.slice(rest, match.index), match[0]);
    rest = match.index + match[0].length;
  }
  if (parts.length === 0) return null;
  parts.push(line.slice(rest));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * Gives each image a paragraph of its own. Enriched draws an image that is the only thing in its
 * paragraph as a block, at its own size, but one with anything else in the paragraph, a line
 * break included, as a 20-point inline glyph; web draws every image at its own size. Table rows
 * are left whole.
 */
export function withBlockImages(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  let afterImage = false;
  for (const line of markdown.split("\n")) {
    const fence = FENCE.test(line);
    const parts =
      fenced || fence || TABLE_ROW.test(line) || !line.includes("![") ? null : imageParts(line);
    if (fence) fenced = !fenced;
    if (parts === null) {
      // Text right after an image starts a paragraph of its own.
      if (afterImage && line.trim() !== "") out.push("");
      out.push(line);
      afterImage = false;
      continue;
    }
    if (out.length > 0 && out.at(-1)?.trim() !== "") out.push("");
    out.push(parts.join("\n\n"));
    afterImage = true;
  }
  return out.join("\n");
}
