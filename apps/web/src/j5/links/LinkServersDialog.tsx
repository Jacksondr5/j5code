import { peeringCandidates } from "@t3tools/client-runtime/j5/peering";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import type { AuthMcpClientAccess, EnvironmentId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useRelayEnvironmentDiscovery } from "../../state/environments";
import { readPreparedConnection } from "../../state/session";
import { listPeerAddresses } from "../peering/peeringClient";
import { EXPLAINER_URL, StepList } from "../peering/peeringParts";
import type { ToolsLevel } from "./linkPairs";
import { pairLinkOps } from "./linksClient";
import {
  linkPair,
  pairLevelsOf,
  pairResultOf,
  pairRouteOf,
  turnOnFor,
  type LinkCandidate,
  type LinkSetupServer,
  type PairEdits,
  type PairLinkPlan,
  type PairLinkResult,
} from "./linkSetup";
import { linkCandidatesFor, refreshManagedLinks, type ManagedLinks } from "./managedLinks";
import { PairRouteChange, usePairChecks } from "./PairRoute";
import { ToolsLevelPicker, toolsLevelLabel } from "./ToolsLevelPicker";

const DEFAULT_LEVEL: ToolsLevel = "approval-required";

/** The tag line every link dialog opens with. */
export function LinkExplainer({ children }: { readonly children: ReactNode }) {
  return (
    <>
      {children}{" "}
      <a
        href={EXPLAINER_URL}
        target="_blank"
        rel="noreferrer"
        className="whitespace-nowrap text-primary hover:underline"
      >
        How does this work?
      </a>
    </>
  );
}

/** One direction's level: a picker, or the level it already has, which a row changes. */
export function ToolsDirection({
  label,
  fixed,
  children,
}: {
  readonly label: ReactNode;
  readonly fixed?: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
      <span className="min-w-0 text-muted-foreground">{label}</span>
      {fixed === undefined ? (
        children
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">{fixed}</span>
      )}
    </div>
  );
}

const fixedLevel = (level: AuthMcpClientAccess | null) =>
  level === null ? undefined : `${toolsLevelLabel(level)} · change it on the pair's row`;

const names = (servers: ReadonlyArray<{ readonly label: string }>) =>
  servers.length <= 1
    ? (servers[0]?.label ?? "")
    : `${servers
        .slice(0, -1)
        .map((server) => server.label)
        .join(", ")} and ${servers.at(-1)!.label}`;

interface LinkedPair {
  readonly candidate: LinkCandidate;
  readonly result: PairLinkResult;
}

/**
 * Links one server with others this client manages: choose them and the two levels, see how each
 * pair's messages will travel, then link. The check for a pair starts when it is ticked and the
 * dialog asks nothing; Change is where a person overrules the check for one pair.
 */
export function LinkServersDialog({
  open,
  onOpenChange,
  links,
  defaultServerId,
  initialOtherIds,
  offer = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly links: ManagedLinks;
  readonly defaultServerId: EnvironmentId;
  /** The servers ticked when the dialog opens. */
  readonly initialOtherIds?: ReadonlyArray<EnvironmentId>;
  /** Opened by itself for a server just added: that server is fixed, and declining is "Not now". */
  readonly offer?: boolean;
}) {
  const { environments, servers } = links;
  const discovery = useRelayEnvironmentDiscovery();
  const [sharedId, setSharedId] = useState(defaultServerId);
  const [ticked, setTicked] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(initialOtherIds ?? []),
  );
  const [edits, setEdits] = useState<Readonly<Record<string, PairEdits>>>({});
  const [changing, setChanging] = useState<EnvironmentId | null>(null);
  const [levels, setLevels] = useState({ local: DEFAULT_LEVEL, remote: DEFAULT_LEVEL });
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState<ReadonlyArray<LinkedPair> | null>(null);

  const { local, candidates } = linkCandidatesFor(links, sharedId);
  const chosen = candidates.filter(
    (candidate): candidate is LinkCandidate & { readonly server: LinkSetupServer } =>
      candidate.unavailable === null &&
      candidate.server !== null &&
      ticked.has(candidate.environmentId),
  );
  const checks = usePairChecks(
    local,
    chosen.flatMap((candidate) => (candidate.support === "full" ? [candidate.server] : [])),
  );

  const levelsOf = (candidate: LinkCandidate) =>
    pairLevelsOf({
      candidate,
      edits: edits[candidate.environmentId] ?? {},
      shared: levels,
      tickedCount: chosen.length,
    });
  const setupOf = (candidate: LinkCandidate & { readonly server: LinkSetupServer }) => {
    const pairEdits = edits[candidate.environmentId] ?? {};
    const { localLevel, remoteLevel } = levelsOf(candidate);
    return {
      pairEdits,
      route:
        local === null || candidate.support !== "full"
          ? null
          : pairRouteOf({
              local,
              remote: candidate.server,
              check: checks[candidate.environmentId] ?? null,
              edits: pairEdits,
              changing: changing === candidate.environmentId,
            }),
      localLevel,
      remoteLevel,
    } as const;
  };
  const editPair = (environmentId: EnvironmentId, change: PairEdits) =>
    setEdits((current) => ({
      ...current,
      [environmentId]: { ...current[environmentId], ...change },
    }));

  const ready =
    local !== null &&
    // Still managed: a server that lost that since the dialog opened would refuse every step.
    servers.includes(sharedId) &&
    chosen.length > 0 &&
    chosen.every((candidate) => {
      const { route, localLevel, remoteLevel } = setupOf(candidate);
      // A server linked for tools alone has nothing to make with both directions Off.
      const makesSomething =
        candidate.support === "full" || localLevel !== "off" || remoteLevel !== "off";
      return makesSomething && (route === null || route.ready);
    });
  const turnsOn =
    local === null
      ? []
      : [
          ...new Map(
            chosen
              .flatMap((candidate) => {
                const { localLevel, remoteLevel } = setupOf(candidate);
                return turnOnFor({ local, remote: candidate.server, localLevel, remoteLevel });
              })
              .map((server) => [server.environmentId, server]),
          ).values(),
        ];

  /** Where a server that does not run J5 and this one may reach each other, as this client knows it. */
  const clientAddresses = async (remote: LinkSetupServer) => {
    if (local === null) return { localUrls: [], remoteUrls: [] };
    const known = (from: EnvironmentId, to: EnvironmentId) =>
      linkableMachines({
        environments,
        threadEnvironmentId: from,
        links: [],
        connect: discovery.environments,
      }).find((machine) => machine.environmentId === to)?.urls ?? [];
    const offered = local.supportsPoll
      ? await listPeerAddresses(local.environmentId).catch(() => [])
      : [];
    return {
      remoteUrls: known(local.environmentId, remote.environmentId),
      localUrls: [
        ...new Set([
          ...peeringCandidates({
            addresses: offered,
            clientUrl: readPreparedConnection(local.environmentId)?.httpBaseUrl ?? null,
          }),
          ...known(remote.environmentId, local.environmentId),
        ]),
      ],
    };
  };

  const link = async () => {
    if (local === null || !ready) return;
    setBusy(true);
    setChanging(null);
    // The results take over at once: a list re-read mid-run would call a pair "Already linked".
    setLinked([]);
    const done: Array<LinkedPair> = [];
    // One pair after another: a pair that fails says why and never stops the next.
    for (const candidate of chosen) {
      const { route, localLevel, remoteLevel } = setupOf(candidate);
      const plan: PairLinkPlan = {
        local,
        remote: candidate.server,
        messaging:
          candidate.support === "tools-only"
            ? { kind: "none", ...(await clientAddresses(candidate.server)) }
            : route === null || route.choice === null
              ? { kind: "existing" }
              : { kind: "set-up", choice: route.choice, clearLeftover: candidate.clearLeftover },
        localLevel,
        remoteLevel,
        turnOn: turnOnFor({ local, remote: candidate.server, localLevel, remoteLevel }),
        kept: [candidate.localLevel, candidate.remoteLevel].filter((level) => level !== null)
          .length,
      };
      done.push({ candidate, result: await linkPair(plan, pairLinkOps) });
      setLinked([...done]);
    }
    refreshManagedLinks(servers);
    setBusy(false);
  };

  const close = () => onOpenChange(false);
  const title = offer
    ? `Link ${local?.label ?? "this server"} with your other servers?`
    : "Link servers";

  return (
    <Dialog
      open={open}
      // A run in flight reports into this dialog, so closing waits for it as Cancel does.
      onOpenChange={(next) => {
        if (busy && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            <LinkExplainer>
              Their agents can message each other and use tools on the other server.
            </LinkExplainer>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {linked !== null ? (
            <ul className="space-y-2">
              {linked.map(({ candidate, result }) => {
                const outcome = pairResultOf(result);
                return (
                  <li
                    key={candidate.environmentId}
                    className="space-y-1 rounded-lg border border-border/60 px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">{candidate.label}</p>
                    <p className="text-xs text-muted-foreground">{outcome.headline}</p>
                    {result.steps.length > 0 ? <StepList steps={result.steps} /> : null}
                    {outcome.problems.map((problem) => (
                      <p key={problem} className="text-xs text-destructive">
                        {problem}
                      </p>
                    ))}
                  </li>
                );
              })}
              {busy ? <li className="text-xs text-muted-foreground">Linking…</li> : null}
            </ul>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span>Link</span>
                {offer ? (
                  <span>{local?.label ?? sharedId}</span>
                ) : (
                  <Select
                    disabled={busy}
                    value={sharedId}
                    onValueChange={(value) => {
                      if (value === null || value === sharedId) return;
                      setSharedId(value as EnvironmentId);
                      setTicked(new Set());
                      setEdits({});
                      setChanging(null);
                    }}
                  >
                    <SelectTrigger size="xs" className="w-48" aria-label="Server to link">
                      <SelectValue>{local?.label ?? sharedId}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      {servers.map((id) => (
                        <SelectItem key={id} value={id}>
                          {environments.find((environment) => environment.environmentId === id)
                            ?.label ?? id}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
                <span>with</span>
              </div>

              <div className="space-y-1.5">
                {candidates.map((candidate) => {
                  const isChosen = chosen.find(
                    (each) => each.environmentId === candidate.environmentId,
                  );
                  const setup = isChosen === undefined ? null : setupOf(isChosen);
                  const isChanging = changing === candidate.environmentId && isChosen !== undefined;
                  const line =
                    candidate.unavailable ??
                    (candidate.support === "tools-only"
                      ? "T3 Code · tools only"
                      : (setup?.route?.line ?? null));
                  // A level set under Change still applies once Change is closed, so the line says it.
                  const ownLevels =
                    setup === null || local === null || isChanging || !levelsOf(candidate).own
                      ? []
                      : [
                          setup.pairEdits.localLevel === undefined || candidate.localLevel !== null
                            ? null
                            : `${local.label}'s agents: ${toolsLevelLabel(setup.pairEdits.localLevel)}`,
                          setup.pairEdits.remoteLevel === undefined ||
                          candidate.remoteLevel !== null
                            ? null
                            : `${candidate.label}'s agents: ${toolsLevelLabel(setup.pairEdits.remoteLevel)}`,
                        ].filter((part) => part !== null);
                  return (
                    <div
                      key={candidate.environmentId}
                      className={
                        candidate.unavailable === null
                          ? "rounded-lg border border-border/60 px-3 py-2"
                          : "rounded-lg border border-border/60 px-3 py-2 opacity-60"
                      }
                    >
                      <div className="flex items-center gap-2">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                          <span className="mt-0.5 flex">
                            <Checkbox
                              checked={ticked.has(candidate.environmentId)}
                              disabled={busy || candidate.unavailable !== null}
                              onCheckedChange={(next) =>
                                setTicked((current) => {
                                  const changed = new Set(current);
                                  if (next === true) changed.add(candidate.environmentId);
                                  else changed.delete(candidate.environmentId);
                                  return changed;
                                })
                              }
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-foreground">
                              {candidate.label}
                            </span>
                            {line === null ? null : (
                              <span
                                className={
                                  setup?.route?.problem === true
                                    ? "block text-xs text-destructive"
                                    : "block text-xs text-muted-foreground"
                                }
                              >
                                {line}
                              </span>
                            )}
                            {ownLevels.length === 0 ? null : (
                              <span className="block text-xs text-muted-foreground">
                                Its own Tools levels · {ownLevels.join(" · ")}
                              </span>
                            )}
                          </span>
                        </label>
                        {setup !== null &&
                        (setup.route === null || setup.route.options.length > 0) ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`${isChanging ? "Done changing" : "Change"} ${candidate.label}`}
                            onClick={() => setChanging(isChanging ? null : candidate.environmentId)}
                          >
                            {isChanging ? "Done" : "Change"}
                          </Button>
                        ) : null}
                      </div>
                      {isChanging && setup !== null && local !== null ? (
                        <div className="mt-2 space-y-3 border-t border-border/60 pt-2 pl-6.5">
                          {setup.route === null ? null : (
                            <PairRouteChange
                              local={local}
                              remote={isChosen.server}
                              route={setup.route}
                              onEdits={(change) => editPair(candidate.environmentId, change)}
                              disabled={busy}
                            />
                          )}
                          <div className="space-y-1.5" hidden={!levelsOf(candidate).own}>
                            <p className="text-xs font-medium text-foreground">Tools</p>
                            <ToolsDirection
                              label={`${local.label}'s agents on ${candidate.label}`}
                              fixed={fixedLevel(candidate.localLevel)}
                            >
                              <ToolsLevelPicker
                                value={setup.pairEdits.localLevel ?? levels.local}
                                holder={local.label}
                                other={candidate.label}
                                disabled={busy}
                                onChange={(level) =>
                                  editPair(candidate.environmentId, { localLevel: level })
                                }
                              />
                            </ToolsDirection>
                            <ToolsDirection
                              label={`${candidate.label}'s agents on ${local.label}`}
                              fixed={fixedLevel(candidate.remoteLevel)}
                            >
                              <ToolsLevelPicker
                                value={setup.pairEdits.remoteLevel ?? levels.remote}
                                holder={candidate.label}
                                other={local.label}
                                disabled={busy}
                                onChange={(level) =>
                                  editPair(candidate.environmentId, { remoteLevel: level })
                                }
                              />
                            </ToolsDirection>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {candidates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Add another environment under Environments first.
                  </p>
                ) : null}
              </div>

              {local === null ? null : (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">Tools</p>
                  <ToolsDirection label={`${local.label}'s agents on these servers`}>
                    <ToolsLevelPicker
                      value={levels.local}
                      holder={local.label}
                      other="each ticked server"
                      disabled={busy}
                      onChange={(level) => setLevels((current) => ({ ...current, local: level }))}
                    />
                  </ToolsDirection>
                  <ToolsDirection label={`These servers' agents on ${local.label}`}>
                    <ToolsLevelPicker
                      value={levels.remote}
                      holder="Each ticked server"
                      other={local.label}
                      disabled={busy}
                      onChange={(level) => setLevels((current) => ({ ...current, remote: level }))}
                    />
                  </ToolsDirection>
                </div>
              )}

              {turnsOn.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Turns on Linked environments on {names(turnsOn)}.
                </p>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {linked !== null ? (
            <Button disabled={busy} onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={close}>
                {offer ? "Not now" : "Cancel"}
              </Button>
              <Button disabled={!ready || busy} onClick={() => void link()}>
                {busy ? "Linking…" : chosen.length > 1 ? `Link ${chosen.length} servers` : "Link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
