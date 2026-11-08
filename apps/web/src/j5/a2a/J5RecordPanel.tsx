/**
 * Text J5 itself recorded, such as a blocked persona's escalation, shown beside an agent's
 * message rather than inside it. It renders as plain text, so nothing an agent writes, and
 * no markup in the record, can hide it, swallow it, or imitate it.
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
      <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{props.text}</p>
    </section>
  );
}
