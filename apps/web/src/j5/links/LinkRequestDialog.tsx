import {
  linkRequestAnswerInput,
  linkRequestDefaultAccess,
  linkRequestFailureMessage,
  linkRequestInitialMachine,
  type LinkRequestItem,
  linkRequestTargetName,
  rankMachinesByHint,
} from "@t3tools/client-runtime/link-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AuthMcpClientAccess, EnvironmentId } from "@t3tools/contracts";
import { useId, useState } from "react";

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
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { useNowMinute } from "../../hooks/useNowMinute";
import { peerLinkEnvironment, useLinkableMachines } from "../../state/peerLinks";
import { useAtomCommand } from "../../state/use-atom-command";
import { StepList, type StepReport } from "../peering/peeringParts";
import { pairLinkOps } from "./linksClient";
import { LinkExplainer, ToolsDirection } from "./LinkServersDialog";
import {
  pairRouteOf,
  prepareRequestLink,
  requestLinkStateOf,
  turnOnFor,
  type LinkCandidate,
  type LinkSetupServer,
  type PairEdits,
} from "./linkSetup";
import { linkCandidatesFor, refreshManagedLinks, useManagedLinks } from "./managedLinks";
import { PairRouteChange, usePairChecks } from "./PairRoute";
import { ToolsLevelPicker, toolsLevelLabel } from "./ToolsLevelPicker";

/** The real time, read when the minute clock ticks. */
const timeAtMinute = (_minute: string) => Date.now();

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The dialog behind an agent's link request card. Upstream's card and its answers are unchanged;
 * answering here also sets up messaging, and the server is one this client already has, never an
 * address or a pasted code.
 */
export function J5LinkRequestDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LinkRequestItem;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  // Mounted only while open, so a reopened dialog never shows the last one's choices.
  return props.open ? <OpenLinkRequestDialog {...props} /> : null;
}

function OpenLinkRequestDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LinkRequestItem;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { item } = props;
  const listId = useId();
  const links = useManagedLinks();
  const machines = useLinkableMachines(props.environmentId, true);
  const nowMs = timeAtMinute(useNowMinute());
  const answer = useAtomCommand(peerLinkEnvironment.answerRequest, {
    label: "answer link request",
    // The failure cause holds the request, and with it the code; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [choice, setChoice] = useState<EnvironmentId | null>(null);
  const [access, setAccess] = useState<AuthMcpClientAccess | null>(null);
  const [edits, setEdits] = useState<PairEdits>({});
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReadonlyArray<StepReport> | null>(null);

  const { local, candidates } = linkCandidatesFor(links, props.environmentId);
  // A request that names no server is answered by picking one. That includes an address the
  // agent's server could not put a name to: the person may have added that server since.
  const picks = item.environmentId === undefined;
  const ranked = rankMachinesByHint(candidates, item.hint);
  const hinted = picks ? linkRequestInitialMachine(item, machines) : null;
  const selectedId =
    item.environmentId ??
    choice ??
    (ranked.some((candidate) => candidate.environmentId === hinted && candidate.blocked === null)
      ? hinted
      : null);
  const selected =
    candidates.find(
      (candidate): candidate is LinkCandidate & { readonly server: LinkSetupServer } =>
        candidate.environmentId === selectedId && candidate.server !== null,
    ) ?? null;
  const link =
    selected === null
      ? null
      : (links.pairs
          .flatMap((pair) =>
            pair.sides.some((side) => side.environmentId === selected.environmentId)
              ? pair.sides
              : [],
          )
          .find((side) => side.environmentId === props.environmentId)?.link ?? null);
  const state = requestLinkStateOf(link, nowMs);
  const needsMessaging =
    selected !== null &&
    selected.blocked === null &&
    selected.support === "full" &&
    !selected.messaging &&
    // A half-recorded pair is refused below, so it is shown no route to change.
    selected.clearLeftover === null &&
    state !== "existing";
  const checks = usePairChecks(local, needsMessaging ? [selected.server] : []);
  const route =
    local === null || !needsMessaging
      ? null
      : pairRouteOf({
          local,
          remote: selected.server,
          check: checks[selected.environmentId] ?? null,
          edits,
        });
  const level =
    access ?? (state === "renew" ? link?.access : null) ?? linkRequestDefaultAccess(item);
  // Setting up messaging issues a credential on this server too, which answering alone does not.
  const cannotPeer =
    local === null || selected === null
      ? null
      : // Clearing the lone record would revoke the other direction's tools, which a request for
        // one direction must not touch; removing the pair on its row is the person's to choose.
        // A live link the agent can use as it is changes nothing, so it is still offered.
        selected.blocked === null && state !== "existing" && selected.clearLeftover !== null
        ? `Only one of ${local.label} and ${selected.label} records the other, so they are half linked. Remove their link in Settings → Environments, then answer this request.`
        : needsMessaging && !links.servers.includes(props.environmentId)
          ? `This app can't manage access on ${local.label}, so it can't set up messaging from here.`
          : null;
  const turnsOn =
    local === null || selected === null || state === "existing"
      ? []
      : turnOnFor({ local, remote: selected.server, localLevel: level, remoteLevel: "off" });
  const ready =
    local !== null &&
    selected !== null &&
    selected.blocked === null &&
    cannotPeer === null &&
    (route === null || route.ready);
  const missing = picks
    ? null
    : selected === null
      ? `${linkRequestTargetName(item)} isn't in this app. Add it under Settings → Environments, then answer this request.`
      : selected.blocked;

  const close = () => props.onOpenChange(false);

  const submit = async () => {
    if (local === null || selected === null || !ready) return;
    setBusy(true);
    setError(null);
    setReport(null);
    const input =
      state === "existing"
        ? linkRequestAnswerInput(item, {
            type: "use-existing",
            environmentId: selected.environmentId,
          })
        : await (async () => {
            const prepared = await prepareRequestLink(
              {
                local,
                remote: selected.server,
                messaging:
                  selected.support === "tools-only"
                    ? {
                        kind: "none",
                        localUrls: [],
                        remoteUrls:
                          machines.find(
                            (machine) => machine.environmentId === selected.environmentId,
                          )?.urls ?? [],
                      }
                    : route === null || route.choice === null
                      ? { kind: "existing" }
                      : {
                          kind: "set-up",
                          choice: route.choice,
                          clearLeftover: selected.clearLeftover,
                        },
                localLevel: level,
                remoteLevel: "off",
                turnOn: turnsOn,
              },
              pairLinkOps,
            );
            if (!prepared.ok) {
              setReport(prepared.steps.length > 0 ? prepared.steps : null);
              setError(prepared.error);
              return null;
            }
            try {
              return linkRequestAnswerInput(item, {
                type: "link",
                target: {
                  environmentId: selected.environmentId,
                  label: selected.label,
                  urls: prepared.urls,
                },
                access: level,
                pairingCode: await pairLinkOps.mintPairingCode(selected.environmentId, level),
              });
            } catch (cause) {
              setError(errorText(cause));
              return null;
            }
          })();
    const result =
      input === null ? null : await answer({ environmentId: props.environmentId, input });
    refreshManagedLinks(links.servers);
    setBusy(false);
    if (result === null) return;
    // The card switches to its answered row once the item updates; a link the other server
    // refused is recorded there, as upstream records it.
    if (result._tag === "Success") close();
    else if (!isAtomCommandInterrupted(result)) {
      setError(linkRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const here = local?.label ?? "This server";
  const title =
    selected !== null && state === "renew"
      ? `Renew ${here}'s tools on ${selected.label}`
      : picks
        ? `Link ${here} with another server`
        : `Link ${here} with ${selected?.label ?? linkRequestTargetName(item)}`;

  const routeBlock = (candidate: LinkCandidate & { readonly server: LinkSetupServer }) =>
    candidate.environmentId !== selected?.environmentId ||
    route === null ||
    local === null ||
    !changing ? null : (
      <div className="mt-2 border-t border-border/60 pt-2">
        <PairRouteChange
          local={local}
          remote={candidate.server}
          route={route}
          onEdits={(change) => setEdits((current) => ({ ...current, ...change }))}
          disabled={busy}
        />
      </div>
    );
  const lineOf = (candidate: LinkCandidate) =>
    candidate.blocked ??
    (candidate.support === "tools-only"
      ? "T3 Code · tools only"
      : candidate.messaging
        ? `Already exchanges messages with ${here}`
        : candidate.environmentId === selected?.environmentId
          ? (route?.line ?? null)
          : null);
  const changeButton =
    route !== null && route.options.length > 0 ? (
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => setChanging((current) => !current)}
      >
        {changing ? "Done" : "Change"}
      </Button>
    ) : null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // An answer that lands after a close would still link.
        if (!next && !busy) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {state === "renew" ? (
              `${here}'s agents could use tools there until the link ran out.${
                selected?.messaging === true ? " Messages still work." : ""
              }`
            ) : (
              <LinkExplainer>
                Their agents can message each other, and {here}'s agents can use tools there.
              </LinkExplainer>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {missing !== null ? (
              <p className="text-sm text-muted-foreground">{missing}</p>
            ) : picks ? (
              <div className="space-y-1.5">
                <span id={listId} className="sr-only">
                  Server
                </span>
                <RadioGroup
                  aria-labelledby={listId}
                  value={selectedId}
                  disabled={busy}
                  onValueChange={(next) => {
                    setChoice(next as EnvironmentId);
                    setEdits({});
                    setChanging(false);
                    setAccess(null);
                    setError(null);
                    setReport(null);
                  }}
                >
                  {ranked.map((candidate) => {
                    const line = lineOf(candidate);
                    const isSelected = candidate.environmentId === selected?.environmentId;
                    return (
                      <div
                        key={candidate.environmentId}
                        className={
                          candidate.blocked === null
                            ? "rounded-lg border border-border/60 px-3 py-2"
                            : "rounded-lg border border-border/60 px-3 py-2 opacity-60"
                        }
                      >
                        <div className="flex items-center gap-2">
                          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                            <span className="mt-0.5 flex">
                              <Radio
                                value={candidate.environmentId}
                                disabled={candidate.blocked !== null}
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium text-foreground">
                                {candidate.label}
                              </span>
                              {line === null ? null : (
                                <span
                                  className={
                                    isSelected && route?.problem === true
                                      ? "block text-xs text-destructive"
                                      : "block text-xs text-muted-foreground"
                                  }
                                >
                                  {line}
                                </span>
                              )}
                            </span>
                          </label>
                          {isSelected ? changeButton : null}
                        </div>
                        {candidate.server === null
                          ? null
                          : routeBlock({ ...candidate, server: candidate.server })}
                      </div>
                    );
                  })}
                </RadioGroup>
                <p className="text-xs text-muted-foreground">
                  A server that isn't listed has to be added to this app first, under Environments.
                </p>
              </div>
            ) : selected !== null && state !== "existing" && lineOf(selected) !== null ? (
              <div className="rounded-lg border border-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className={
                      route?.problem === true
                        ? "min-w-0 flex-1 text-xs text-destructive"
                        : "min-w-0 flex-1 text-xs text-muted-foreground"
                    }
                  >
                    {lineOf(selected)}
                  </span>
                  {changeButton}
                </div>
                {routeBlock(selected)}
              </div>
            ) : null}

            {selected === null || selected.blocked !== null || local === null ? null : state ===
              "existing" ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {here}'s agents can already use tools on {selected.label}
                </span>
                {link === null ? "" : `, at ${toolsLevelLabel(link.access)}`}. The agent can use
                that link as it is. To change the level, use the pair's row in Settings.
              </p>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-foreground">Tools</p>
                <ToolsDirection label={`${here}'s agents on ${selected.label}`}>
                  <ToolsLevelPicker
                    value={level}
                    holder={here}
                    other={selected.label}
                    disabled={busy}
                    withoutOff
                    onChange={(next) => {
                      if (next !== "off") setAccess(next);
                    }}
                  />
                </ToolsDirection>
                <ToolsDirection
                  label={`${selected.label}'s agents on ${here}`}
                  fixed={`${
                    selected.remoteLevel === null ? "Off" : toolsLevelLabel(selected.remoteLevel)
                  } · change it in Settings`}
                />
              </div>
            )}

            {turnsOn.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Turns on Linked environments on{" "}
                {turnsOn.map((server) => server.label).join(" and ")}.
              </p>
            ) : null}
            {cannotPeer !== null ? <p className="text-xs text-destructive">{cannotPeer}</p> : null}
            {report !== null ? <StepList steps={report} /> : null}
            {error !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {missing !== null ? null : (
            <Button disabled={!ready || busy} onClick={() => void submit()}>
              {busy
                ? "Linking…"
                : state === "existing"
                  ? "Use this link"
                  : state === "renew"
                    ? "Renew"
                    : "Link"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
