import { peerOriginWarning, type PeeringReach } from "@t3tools/client-runtime/j5/peering";

import { Input } from "../../components/ui/input";

/** Where "How does this work?" goes: the explainer for links, sending directly and polling. */
export const EXPLAINER_URL = "https://j5.codes/linking";

export interface StepReport {
  readonly title: string;
  readonly status: "done" | "failed" | "skipped";
  readonly detail: string | null;
}

export function ReachLine({
  from,
  to,
  reach,
}: {
  readonly from: { readonly label: string };
  readonly to: { readonly label: string };
  readonly reach: PeeringReach;
}) {
  switch (reach.kind) {
    case "reached":
      return (
        <li>
          <span className="text-foreground">
            ✓ {from.label} reaches {to.label}
          </span>
          <span className="block text-xs">at {reach.origin}</span>
        </li>
      );
    case "failed":
      return (
        <li>
          <span className="text-foreground">
            ✕ {from.label} can't reach {to.label}
          </span>
          {reach.errors.map((error) => (
            <span key={error} className="block font-mono text-xs">
              {error}
            </span>
          ))}
        </li>
      );
    case "untested":
      return (
        <li>
          <span className="text-foreground">
            ? Couldn't test {from.label} reaching {to.label}
          </span>
          <span className="block text-xs">
            {reach.error === null
              ? `${to.label} only knows loopback addresses for itself`
              : `${to.label} could not list its addresses: ${reach.error}`}
          </span>
        </li>
      );
  }
}

export function OriginField({
  title,
  value,
  onChange,
  disabled,
  error = null,
}: {
  readonly title: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  /** Why this field must be filled in before the pair can be linked. */
  readonly error?: string | null;
}) {
  const warning = peerOriginWarning(value);
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
      {title}
      <Input
        nativeInput
        value={value}
        disabled={disabled}
        aria-invalid={error !== null}
        placeholder="https://host:3773"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error !== null ? (
        <span className="text-xs font-normal text-destructive">{error}</span>
      ) : null}
      {warning !== null ? (
        <span className="text-xs font-normal text-warning-foreground">{warning}</span>
      ) : null}
    </label>
  );
}

export function StepList({ steps }: { readonly steps: ReadonlyArray<StepReport> }) {
  const failedAfterIssuing =
    steps.some((step) => step.status === "failed") &&
    steps.some((step) => step.status === "done" && step.title.startsWith("Issue"));
  return (
    <ol className="space-y-1 text-xs">
      {steps.map((step) => (
        <li key={step.title} className="flex flex-col">
          <span
            className={
              step.status === "failed"
                ? "text-destructive"
                : step.status === "skipped"
                  ? "text-muted-foreground/60"
                  : "text-foreground"
            }
          >
            {step.status === "done" ? "Done" : step.status === "failed" ? "Failed" : "Skipped"}
            {": "}
            {step.title}
          </span>
          {step.detail !== null ? (
            <span className="text-muted-foreground">{step.detail}</span>
          ) : null}
        </li>
      ))}
      {failedAfterIssuing ? (
        <li className="text-muted-foreground">
          Nothing was undone. Messaging the two servers already had, if any, still works.
          Credentials issued in this attempt stay listed under Sharing &amp; access on the server
          that issued them until a later link replaces them, or you revoke them there.
        </li>
      ) : null}
    </ol>
  );
}
