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
  // The hook needs an id; until a remote is chosen, readiness stops before reading this.
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

  // The two sides as the request will send them; the step titles read from the same values.
  const local: PeeringSide = {
    environmentId: primaryEnvironmentId,
    label: primaryLabel.trim() || (primary?.label ?? primaryEnvironmentId),
    origin: primaryOrigin.trim(),
  };
  const remote: PeeringSide | null =
    otherId === null || other === null
      ? null
      : {
          environmentId: otherId,
          label: otherLabel.trim() || other.label,
          origin: otherOrigin.trim(),
        };
  const remoteLabel = remote?.label ?? "the other server";

  const peer = async () => {
    if (readiness.kind !== "ready" || remote === null) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await introducePeers({
        local,
        remote,
        issue: (issuer, holder) =>
          issuePeerCredential(issuer.environmentId, {
            environmentId: holder.environmentId,
            label: holder.label,
          }),
        record: (recorder, target, credential) =>
          addPeer(recorder.environmentId, {
            origin: target.origin,
            credential,
            label: target.label,
          }),
      });
      setOutcome(result);
      if (result.ok) {
        onPeered(remote.environmentId);
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Peer with another server</DialogTitle>
          <DialogDescription>
            Each server ends up holding a credential the other issued and the address it reaches the
            other at. The addresses below start from what this browser uses; confirm the address
            each server can actually reach.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-foreground">This server</span>
                <span className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-foreground">
                  {primary?.label ?? primaryEnvironmentId}
                </span>
                <span className="text-xs text-muted-foreground">
                  The server this page is served from.
                </span>
              </div>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                Remote server
                <Select
                  disabled={busy}
                  value={otherId ?? undefined}
                  onValueChange={(value) => chooseOther((value as EnvironmentId | null) ?? null)}
                >
                  <SelectTrigger className="w-full" aria-label="Remote server to peer with">
                    <SelectValue>{other?.label ?? "Choose a remote server"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {candidates.map((environment) => (
                      <SelectItem key={environment.environmentId} value={environment.environmentId}>
                        {environment.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <span className="text-xs font-normal text-muted-foreground">
                  {candidates.length === 0
                    ? "Add another environment under Remote environments first."
                    : "One of the environments this browser is connected to."}
                </span>
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <PeerSideFields
                heading={`This server · ${primary?.label ?? primaryEnvironmentId}`}
                originTitle={`Reaches ${remoteLabel} at`}
                originValue={otherOrigin}
                onOriginChange={setOtherOrigin}
                labelTitle={`Known on ${remoteLabel} as`}
                labelValue={primaryLabel}
                onLabelChange={setPrimaryLabel}
                disabled={busy || otherId === null}
              />
              <PeerSideFields
                heading={`Remote server · ${other?.label ?? "not chosen"}`}
                originTitle="Reaches this server at"
                originValue={primaryOrigin}
                onOriginChange={setPrimaryOrigin}
                labelTitle="Known on this server as"
                labelValue={otherLabel}
                onLabelChange={setOtherLabel}
                disabled={busy || otherId === null}
              />
            </div>

            {readiness.kind !== "ready" && otherId !== null ? (
              <p className="text-xs text-muted-foreground">{readiness.message}</p>
            ) : null}

            {outcome !== null && remote !== null ? (
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
                {!outcome.ok &&
                outcome.steps.some(
                  (step) => step.status === "done" && step.step.startsWith("issue-"),
                ) ? (
                  <li className="text-muted-foreground">
                    Nothing was undone. The existing peering, if any, still works. Credentials
                    issued in this attempt stay listed under Connections on the server that issued
                    them until a later peering replaces them, or you revoke them there.
                  </li>
                ) : null}
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

/**
 * One side of the pairing, from that server's point of view: where it reaches
 * the other server, and what the other server will call it. The two columns
 * mirror each other and stack when the dialog is narrow.
 */
function PeerSideFields({
  heading,
  originTitle,
  originValue,
  onOriginChange,
  labelTitle,
  labelValue,
  onLabelChange,
  disabled,
}: {
  readonly heading: string;
  readonly originTitle: string;
  readonly originValue: string;
  readonly onOriginChange: (value: string) => void;
  readonly labelTitle: string;
  readonly labelValue: string;
  readonly onLabelChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  const warning = peerOriginWarning(originValue);
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">{heading}</legend>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
        {originTitle}
        <Input
          nativeInput
          value={originValue}
          disabled={disabled}
          placeholder="https://host:3773"
          onChange={(event) => onOriginChange(event.currentTarget.value)}
        />
        {warning !== null ? (
          <span className="text-xs font-normal text-warning-foreground">{warning}</span>
        ) : null}
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
        {labelTitle}
        <Input
          nativeInput
          value={labelValue}
          disabled={disabled}
          onChange={(event) => onLabelChange(event.currentTarget.value)}
        />
      </label>
    </fieldset>
  );
}
