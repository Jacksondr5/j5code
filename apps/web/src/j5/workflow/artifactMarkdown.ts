const label = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const code = (value: unknown) => {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  const fence = "`".repeat(
    Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)),
  );
  return `${fence}\n${text}\n${fence}`;
};

/** A readable projection of the immutable artifact. Approval continues to bind the original content. */
export function reviewDocument(content: unknown): string {
  if (typeof content === "string") return content;
  if (!record(content)) return code(content);
  return Object.entries(content)
    .filter(([key]) => !["diff", "codeIdentity", "tree", "subjectHash"].includes(key))
    .map(([key, value]) => {
      if (key === "summary") return String(value);
      if (key === "steps" && Array.isArray(value))
        return `## Implementation plan\n\n${value.map((item, index) => `${index + 1}. ${String(item)}`).join("\n")}`;
      if (key === "findings" && Array.isArray(value))
        return `## Review findings\n\n${value.length ? value.map((item) => (record(item) ? `### ${item.blocking ? "Blocking finding" : "Observation"}\n\n${String(item.description ?? "")}` : code(item))).join("\n\n") : "No findings."}`;
      if (key === "checks" && Array.isArray(value))
        return `## Verification commands\n\n${value
          .map((item, index) => {
            if (!record(item)) return code(item);
            return `### Check ${index + 1}${typeof item.exitCode === "number" ? (item.exitCode === 0 ? " — Passed" : ` — Failed (exit ${item.exitCode})`) : ""}\n\nExecutable and arguments:\n\n${code([item.executable, ...(Array.isArray(item.args) ? item.args : [])])}${typeof item.output === "string" ? `\n\nOutput:\n\n${code(item.output)}` : ""}`;
          })
          .join("\n\n")}`;
      if (key === "passed") return `## Validation result\n\n${value ? "Passed" : "Failed"}`;
      if (key === "verdict")
        return `## Review decision\n\n${value === "accept" ? "Accepted" : "Changes requested"}`;
      const text = Array.isArray(value)
        ? value.length
          ? value.map((item) => (typeof item === "string" ? `- ${item}` : code(item))).join("\n\n")
          : "None."
        : typeof value === "string"
          ? value
          : code(value);
      return `## ${label(key)}\n\n${text}`;
    })
    .join("\n\n");
}
