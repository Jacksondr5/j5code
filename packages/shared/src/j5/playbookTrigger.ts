/** Detect the playbook name at the start of a message, before any following text. */
export function detectPlaybookTrigger(
  linePrefix: string,
  textBeforeLine: string,
  textAfterCursor: string,
) {
  const match = /^\/playbook[ \t]+([a-z][a-z0-9-]*)?$/i.exec(linePrefix);
  if (!match || textBeforeLine.trim() || !/^(?:$|\s)/.test(textAfterCursor)) return null;
  return {
    kind: "slash-playbook" as const,
    query: match[1] ?? "",
    rangeStart: textBeforeLine.length,
    rangeEnd: textBeforeLine.length + linePrefix.length,
  };
}
