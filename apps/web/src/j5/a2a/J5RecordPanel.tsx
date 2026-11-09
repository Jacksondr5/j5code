import { splitRecordText } from "@t3tools/client-runtime/j5/inbox";

/**
 * Text J5 itself recorded, such as a blocked persona's escalation, shown beside an agent's
 * message rather than inside it. It renders as plain text, so nothing an agent writes, and
 * no markup in the record, can hide it, swallow it, or imitate it. An indented block it quotes,
 * such as a persona draft's definition, keeps its layout and scrolls sideways.
 */
export function J5RecordPanel(props: { readonly text: string; readonly label?: string }) {
  return (
    <section
      aria-label={props.label ?? "Recorded by J5"}
      className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
      data-j5-record=""
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        {props.label ?? "Recorded by J5"}
      </h3>
      {splitRecordText(props.text).map((part, index) =>
        part.kind === "block" ? (
          <pre
            // oxlint-disable-next-line react/no-array-index-key -- the parts are the record's fixed order.
            key={index}
            className="mt-1 overflow-x-auto whitespace-pre font-mono text-xs text-foreground"
          >
            {part.text}
          </pre>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- the parts are the record's fixed order.
          <p key={index} className="mt-1 whitespace-pre-wrap break-words text-foreground">
            {part.text}
          </p>
        ),
      )}
    </section>
  );
}
