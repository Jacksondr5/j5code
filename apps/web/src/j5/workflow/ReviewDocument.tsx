import { useMemo } from "react";
import ChatMarkdown from "../../components/ChatMarkdown";
import { getDiffLineStat, getRenderablePatch, resolveFileDiffPath } from "../../lib/diffRendering";
import { reviewDocument } from "./artifactMarkdown";

function RecordedDiff({ diff }: { diff: string }) {
  const parsed = useMemo(() => getRenderablePatch(diff, "workflow-recorded-evidence"), [diff]);
  const sections = useMemo(
    () => diff.split(/(?=^diff --git )/m).filter((section) => section.trim().length > 0),
    [diff],
  );
  if (!diff.trim())
    return <p className="text-sm text-muted-foreground">No file changes recorded.</p>;
  if (!parsed || parsed.kind === "raw")
    return (
      <div>
        <p className="text-sm text-muted-foreground">
          {parsed?.kind === "raw" ? parsed.reason : "No parseable file diff was recorded."}
        </p>
        <pre className="mt-2 max-h-[36rem] overflow-auto rounded bg-muted p-3 text-xs">{diff}</pre>
      </div>
    );
  const total = getDiffLineStat(parsed.files);
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {parsed.files.length} {parsed.files.length === 1 ? "file" : "files"} · +{total.additions} −
        {total.deletions}
      </p>
      {parsed.files.map((file, index) => {
        const stats = getDiffLineStat([file]);
        return (
          <details
            className="rounded border"
            key={`${file.prevName ?? ""}:${file.name ?? ""}:${file.prevObjectId ?? ""}:${file.newObjectId ?? ""}`}
            open={index === 0}
          >
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
              {resolveFileDiffPath(file) || "Binary or unnamed change"} · +{stats.additions} −
              {stats.deletions}
            </summary>
            <pre className="max-h-[36rem] overflow-auto border-t bg-muted/50 p-3 text-xs">
              {sections[index] ?? "Diff body unavailable for this file."}
            </pre>
          </details>
        );
      })}
    </div>
  );
}

export function ReviewDocument({ content }: { content: unknown }) {
  const markdown = useMemo(() => reviewDocument(content), [content]);
  const diff =
    content !== null &&
    typeof content === "object" &&
    "diff" in content &&
    typeof content.diff === "string"
      ? content.diff
      : null;
  return (
    <div className="space-y-4">
      <article className="rounded-lg border bg-background p-5" aria-label="Review document">
        <ChatMarkdown text={markdown} cwd={undefined} />
      </article>
      {diff !== null && (
        <details open className="rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">Candidate diff</summary>
          <div className="mt-3">
            <RecordedDiff diff={diff} />
          </div>
        </details>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Source artifact</summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(content, null, 2)}
        </pre>
      </details>
    </div>
  );
}
