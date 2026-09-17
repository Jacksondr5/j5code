import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import {
  defaultPeerOrigin,
  introducePeers,
  peerOriginWarning,
  peeringStepTitle,
  resolvePeeringReadiness,
  type PeeringOutcome,
  type PeeringSide,
} from "@t3tools/client-runtime/j5/peering";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  useEnvironments,
} from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { addPeer, issuePeerCredential } from "./peeringClient";

/**
 * The introduction: this client is connected to both servers, so it asks each
 * to issue a credential for the other and tells each where the other is
 * reached. The origins default to what this client uses, which is only a hint;
 * the person confirms the address each server can actually reach.
 */
export function PeerIntroductionDialog({
  open,
  onOpenChange,
  primaryEnvironmentId,
  onPeered,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly primaryEnvironmentId: EnvironmentId;
  readonly onPeered: (otherEnvironmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const primary = useEnvironment(primaryEnvironmentId);
  const candidates = useMemo(
    () =>
      environments
        .filter((environment) => environment.environmentId !== primaryEnvironmentId)
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [environments, primaryEnvironmentId],
  );
  const [otherId, setOtherId] = useState<EnvironmentId | null>(null);
  const other = candidates.find((environment) => environment.environmentId === otherId) ?? null;
  const primaryBaseUrl = useEnvironmentHttpBaseUrl(primaryEnvironmentId);
  const otherBaseUrl = useEnvironmentHttpBaseUrl(otherId);
  const otherSession = useEnvironmentSessionState(otherId ?? primaryEnvironmentId);

  // What the person typed, if anything; the defaults below follow the chosen
  // environment until then, and choosing another environment clears the edits.
  const [primaryOriginEdit, setPrimaryOrigin] = useState<string | null>(null);
  const [otherOriginEdit, setOtherOrigin] = useState<string | null>(null);
  const [primaryLabelEdit, setPrimaryLabel] = useState<string | null>(null);
  const [otherLabelEdit, setOtherLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PeeringOutcome | null>(null);
  const primaryOrigin = primaryOriginEdit ?? defaultPeerOrigin(primaryBaseUrl);
  const otherOrigin = otherOriginEdit ?? defaultPeerOrigin(otherBaseUrl);
  const primaryLabel = primaryLabelEdit ?? primary?.label ?? "";
  const otherLabel = otherLabelEdit ?? other?.label ?? "";
  const chooseOther = (value: EnvironmentId | null) => {
    setOtherId(value);
    setOtherOrigin(null);
    setOtherLabel(null);
    setOutcome(null);
  };

  const readiness = resolvePeeringReadiness({
    otherLabel: other?.label ?? null,
    otherConnected: other?.connection.phase === "connected",
    otherCanManage:
      otherId !== null &&
      otherSession.data?.authenticated === true &&
      (otherSession.data.scopes?.includes(AuthAccessWriteScope) ?? false),
    localOrigin: primaryOrigin,
    remoteOrigin: otherOrigin,
  });

  const peer = async () => {
    if (readiness.kind !== "ready" || otherId === null || other === null) return;
    const local: PeeringSide = {
      environmentId: primaryEnvironmentId,
      label: primaryLabel.trim() || (primary?.label ?? primaryEnvironmentId),
      origin: primaryOrigin.trim(),
    };
    const remote: PeeringSide = {
      environmentId: otherId,
      label: otherLabel.trim() || other.label,
      origin: otherOrigin.trim(),
    };
    setBusy(true);
    setOutcome(null);
    try {
      const result = await introducePeers({
        local,
        remote,
        issue: (issuer, holder) =>
          issuePeerCredential(issuer.environmentId as EnvironmentId, {
            environmentId: holder.environmentId,
            label: holder.label,
          }),
        record: (recorder, target, credential) =>
          addPeer(recorder.environmentId as EnvironmentId, {
            origin: target.origin,
            credential,
            label: target.label,
          }),
      });
      setOutcome(result);
      if (result.ok) {
        onPeered(otherId);
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const local: PeeringSide = {
    environmentId: primaryEnvironmentId,
    label: primaryLabel || (primary?.label ?? "this server"),
    origin: primaryOrigin,
  };
  const remote: PeeringSide = {
    environmentId: otherId ?? "",
    label: otherLabel || (other?.label ?? "the other server"),
    origin: otherOrigin,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Peer with another environment</DialogTitle>
          <DialogDescription>
            Both servers will hold a credential the other issued and the address they reach each
            other at. Use the address each server can reach; the one this client uses is only a
            starting point.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              Environment to peer with
              <Select
                disabled={busy}
                value={otherId ?? undefined}
                onValueChange={(value) => chooseOther((value as EnvironmentId | null) ?? null)}
              >
                <SelectTrigger className="w-full" aria-label="Environment to peer with">
                  <SelectValue>{other?.label ?? "Choose an environment"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {candidates.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {candidates.length === 0 ? (
                <span className="text-xs font-normal text-muted-foreground">
                  Add another environment under Remote environments first.
                </span>
              ) : null}
            </label>

            <OriginField
              title={`Where ${remote.label} reaches ${local.label}`}
              value={primaryOrigin}
              onChange={setPrimaryOrigin}
              disabled={busy}
            />
            <OriginField
              title={`Where ${local.label} reaches ${remote.label}`}
              value={otherOrigin}
              onChange={setOtherOrigin}
              disabled={busy || otherId === null}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                {`Label for ${local.label} on ${remote.label}`}
                <Input
                  nativeInput
                  value={primaryLabel}
                  disabled={busy}
                  onChange={(event) => setPrimaryLabel(event.currentTarget.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                {`Label for ${remote.label} on ${local.label}`}
                <Input
                  nativeInput
                  value={otherLabel}
                  disabled={busy || otherId === null}
                  onChange={(event) => setOtherLabel(event.currentTarget.value)}
                />
              </label>
            </div>

            {readiness.kind !== "ready" && otherId !== null ? (
              <p className="text-xs text-muted-foreground">{readiness.message}</p>
            ) : null}

            {outcome !== null ? (
              <ol className="space-y-1 text-xs">
                {outcome.steps.map((step) => (
                  <li key={step.step} className="flex flex-col">
                    <span
                      className={
                        step.status === "failed"
                          ? "text-destructive"
                          : step.status === "skipped"
                            ? "text-muted-foreground/60"
                            : "text-foreground"
                      }
                    >
                      {step.status === "done"
                        ? "Done"
                        : step.status === "failed"
                          ? "Failed"
                          : "Skipped"}
                      {": "}
                      {peeringStepTitle(step.step, local, remote)}
                    </span>
                    {step.detail !== null ? (
                      <span className="text-muted-foreground">{step.detail}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || readiness.kind !== "ready"} onClick={() => void peer()}>
            {busy ? "Peering…" : "Peer"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function OriginField({
  title,
  value,
  onChange,
  disabled,
}: {
  readonly title: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  const warning = peerOriginWarning(value);
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
      {title}
      <Input
        nativeInput
        value={value}
        disabled={disabled}
        placeholder="https://host:3773"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {warning !== null ? (
        <span className="text-xs font-normal text-warning-foreground">{warning}</span>
      ) : null}
    </label>
  );
}
