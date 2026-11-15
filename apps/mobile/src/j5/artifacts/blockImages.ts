// An image, or inline code to leave alone; an image inside a link (`[![a](b)](c)`) stays inline.
const TOKEN = /`[^`]*`|(?<!\[)!\[[^\]]*\]\((?:[^()\s]|\([^()]*\))+(?:\s+"[^"]*")?\)/g;
const FENCE = /^\s*(```|~~~)/;

/**
 * Gives each image that shares a line with text a paragraph of its own. Enriched draws an image
 * that is the only thing in its paragraph as a block, at its own size, but one inside a line of
 * text as a 20-point inline glyph; web draws every image at its own size.
 */
export function withBlockImages(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced || !line.includes("![")) return line;
      const parts: string[] = [];
      let rest = 0;
      for (const match of line.matchAll(TOKEN)) {
        if (match[0].startsWith("`")) continue;
        parts.push(line.slice(rest, match.index), match[0]);
        rest = match.index + match[0].length;
      }
      parts.push(line.slice(rest));
      const kept = parts.filter((part) => part.trim() !== "");
      return kept.length <= 1 ? line : kept.map((part) => part.trim()).join("\n\n");
    })
    .join("\n");
}
