import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { EllipsisIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ConnectionStatusDot } from "../../components/ConnectionStatusDot";
import { ITEM_ROW_CLASSNAME } from "../../components/settings/itemRows";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { editableSides, PeerEditDialog } from "../peering/PeerEditDialog";
import { refreshPeers } from "../peering/peeringClient";
import { pairTitle } from "../peering/peerPairs";
import {
  applyLevelChange,
  planLevelChange,
  unmanagedReason,
  removableSides,
  removalOf,
  removePair,
  renewableSides,
  type LevelChangePlan,
  type LinkServerFacts,
} from "./linkChanges";
import {
  otherSideOf,
  toolsExpiryOf,
  toolsLevelOf,
  type LinkPair,
  type LinkPairSide,
  type ToolsLevel,
} from "./linkPairs";
import { linkOps, refreshLinks } from "./linksClient";
import { messagesStatusOf, toolsExpiryLine } from "./linkStatus";
import { ToolsLevelPicker, toolsLevelLabel } from "./ToolsLevelPicker";

/** What the row needs to know of a server; null for one this client is not connected to. */
export interface LinkRowServerFacts extends LinkServerFacts {
  /** It runs J5 Code, so messages can be set up with it; a T3 Code server takes tools only. */
  readonly supportsMessaging: boolean;
}

interface DirectionState {
  readonly busy: boolean;
  readonly error: string | null;
}

const IDLE: DirectionState = { busy: false, error: null };

/** The real time, read when the minute clock ticks. */
const timeAtMinute = (_minute: string) => Date.now();

const names = (servers: ReadonlyArray<{ readonly label: string }>) =>
  servers.map((server) => server.label).join(" and ");

const confirmed = (dialog: Promise<boolean> | undefined) => dialog ?? Promise.resolve(false);

/** Upstream's Linked environments is a setting a person turns on, so they are asked, by name. */
const confirmTurnOn = (servers: ReadonlyArray<{ readonly label: string }>) =>
  confirmed(
    requestConfirmDialog(
      "Turn on Linked environments?",
      {},
      {
        confirmLabel: "Turn on and link",
        content: (
          <span>
            Agents use tools on another server through Linked environments, a T3 Code beta. It is
            off on <span className="font-medium text-foreground">{names(servers)}</span>, and this
            turns it on there.
          </span>
        ),
      },
    ),
  );

/**
 * One linked pair: how its messages travel, what each server's agents may do on the other, and
 * the changes a person makes to it. Every change acts on each server this client manages; a
 * server it cannot manage is named where that stops something.
 */
export function LinkPairRow({
  pair,
  factsOf,
  awayOf,
  onSetUpMessaging,
}: {
  readonly pair: LinkPair;
  readonly factsOf: (environmentId: EnvironmentId) => LinkRowServerFacts | null;
  /** A server this client has but is not connected to now. */
  readonly awayOf: (environmentId: EnvironmentId) => boolean;
  readonly onSetUpMessaging: (pair: LinkPair) => void;
}) {
  const [directions, setDirections] = useState<Readonly<Record<string, DirectionState>>>({});
  const [renewing, setRenewing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false);
  // Re-rendered each minute: a poller that stopped, and a link that ran out, send nothing to re-read for.
  const nowMs = timeAtMinute(useNowMinute());
  const messaging = messagesStatusOf(pair, nowMs);
  const expiry = toolsExpiryOf(pair, DateTime.makeUnsafe(nowMs));
  const expiryLine = toolsExpiryLine(expiry, nowMs, messaging !== null);
  // A level change in flight makes a link the row has not read yet, which a removal would miss.
  const busy =
    renewing || removing || Object.values(directions).some((direction) => direction.busy);
  const title = pairTitle(pair);

  const stateOf = (side: LinkPairSide) => directions[side.environmentId] ?? IDLE;
  const setState = (side: LinkPairSide, next: DirectionState) =>
    setDirections((current) => ({ ...current, [side.environmentId]: next }));
  const refresh = () => {
    for (const side of pair.sides) {
      if (!side.managed) continue;
      refreshPeers(side.environmentId);
      refreshLinks(side.environmentId);
    }
  };

  const apply = async (
    holder: LinkPairSide,
    plan: Exclude<LevelChangePlan, { readonly kind: "blocked" }>,
    failed: string,
  ) => {
    setState(holder, { busy: true, error: null });
    const outcome = await applyLevelChange({ pair, holder, plan, ops: linkOps });
    setState(
      holder,
      outcome.ok
        ? { busy: false, error: null }
        : { busy: false, error: `${failed}: ${outcome.reason}` },
    );
    // A toast, not the row: turning off a pair's only part takes the row away with what it said.
    if (outcome.ok && outcome.note !== null) {
      toastManager.add({
        type: "warning",
        title: "A session was left on the other server",
        description: outcome.note,
      });
    }
    return outcome.ok;
  };

  const changeLevel = async (holder: LinkPairSide, level: ToolsLevel, address?: string) => {
    const plan = planLevelChange({
      pair,
      holder,
      level,
      factsOf,
      awayOf,
      ...(address === undefined ? {} : { address }),
    });
    if (plan.kind === "blocked") {
      setState(holder, { busy: false, error: plan.reason });
      return;
    }
    if (plan.kind === "link" && plan.turnOn.length > 0 && !(await confirmTurnOn(plan.turnOn))) {
      return;
    }
    await apply(
      holder,
      plan,
      level === "off" ? "Couldn't turn this off" : `Couldn't set ${toolsLevelLabel(level)}`,
    );
    refresh();
  };

  const renew = async () => {
    const plans = renewableSides(pair).map((holder) => ({
      holder,
      plan: planLevelChange({ pair, holder, level: toolsLevelOf(holder), factsOf, awayOf }),
    }));
    const turnOn = new Map(
      plans.flatMap(({ plan }) =>
        plan.kind === "link" ? plan.turnOn.map((server) => [server.environmentId, server]) : [],
      ),
    );
    if (turnOn.size > 0 && !(await confirmTurnOn([...turnOn.values()]))) return;
    setRenewing(true);
    let renewed = 0;
    for (const { holder, plan } of plans) {
      if (plan.kind === "blocked") {
        setState(holder, { busy: false, error: plan.reason });
      } else if (await apply(holder, plan, "Couldn't renew this")) {
        renewed += 1;
      }
    }
    refresh();
    setRenewing(false);
    if (renewed === plans.length) {
      toastManager.add({ type: "success", title: `Renewed tools for ${title}` });
    }
  };

  const remove = async () => {
    const { kind, holder, other } = removalOf(pair);
    const proceed = await confirmed(
      kind === "both"
        ? requestConfirmDialog(
            `Remove the link between ${pair.sides[0].label} and ${pair.sides[1].label}?`,
            { variant: "destructive" },
            {
              confirmLabel: "Remove link",
              content: (
                <span className="flex flex-col gap-2">
                  <span>
                    Their agents can no longer message each other or use tools on the other server.
                  </span>
                  <span>
                    Messages still waiting are cancelled and open Exchanges between them are
                    dropped, and each agent involved is told. Work that one server's agents started
                    on the other keeps running there, but is no longer followed.
                  </span>
                </span>
              ),
            },
          )
        : kind === "ended"
          ? requestConfirmDialog(
              `Remove ${other.label} from ${holder.label}?`,
              { variant: "destructive" },
              {
                confirmLabel: "Remove link",
                content: (
                  <span>
                    {other.label} no longer holds its side of this link. {holder.label} forgets{" "}
                    {other.label}, and its agents can no longer use tools there. Messages still
                    waiting on {holder.label} for {other.label} are cancelled and open Exchanges
                    with its agents are dropped, and each agent on {holder.label} that was involved
                    is told.
                  </span>
                ),
              },
            )
          : requestConfirmDialog(
              `Remove ${other.label} on ${holder.label} only?`,
              { variant: "destructive" },
              {
                confirmLabel: "Remove here only",
                content: (
                  <span className="flex flex-col gap-2">
                    <span className="font-medium text-foreground">
                      {other.label} will keep its side of this link.
                    </span>
                    <span>
                      This app can't manage {other.label} to remove it there. {holder.label} forgets{" "}
                      {other.label}, and {other.label}'s agents can no longer message {holder.label}
                      's agents or use tools on {holder.label}. Until you remove the link on{" "}
                      {other.label} too, {other.label} keeps trying to reach {holder.label} and its
                      messages fail.
                    </span>
                    <span>
                      If {other.label} linked to {holder.label} from the command line, or on an
                      older version of J5 Code, that session stays in {holder.label}'s Settings →
                      Sharing & access until you revoke it there or it runs out.
                    </span>
                  </span>
                ),
              },
            ),
    );
    if (!proceed) return;
    setRemoving(true);
    const outcome = await removePair(pair, linkOps);
    for (const { side, reason } of outcome.failures) {
      toastManager.add({
        type: "error",
        title: `Could not remove the link on ${side.label}`,
        description: `${side.label} may still be linked with ${otherSideOf(pair, side).label}. ${reason}`,
      });
    }
    for (const note of outcome.notes) {
      toastManager.add({
        type: "warning",
        title: "A session was left on the other server",
        description: note,
      });
    }
    refresh();
    setRemoving(false);
  };

  const shown = messaging === null ? pair.sides.filter((side) => side.link !== null) : pair.sides;
  const levelsKnown = pair.sides.every((side) => side.managed && side.linksRead);
  const toolsOff = pair.sides.every((side) => toolsLevelOf(side) === "off");
  const health = shown.map((side) =>
    side.link === null ? null : peerLinkHealth(side.link, DateTime.makeUnsafe(nowMs)),
  );
  const wrong =
    (messaging?.problems.length ?? 0) > 0 ||
    expiry.kind === "expired" ||
    health.some((each) => each?.kind === "failing") ||
    pair.sides.some((side) => stateOf(side).error !== null);
  const renewDue = expiry.kind === "expired" || (expiry.kind === "running" && expiry.soon);
  // A saved level says nothing of upstream's setting, which refuses every tool call while off.
  const pausedBy = (holder: LinkPairSide) =>
    holder.link === null
      ? []
      : [holder, otherSideOf(pair, holder)].filter(
          (side) => factsOf(side.environmentId)?.linkedEnvironmentsEnabled === false,
        );
  const paused = pair.sides.some((side) => pausedBy(side).length > 0);
  const missingMessaging = pair.sides.find(
    (side) => factsOf(side.environmentId)?.supportsMessaging === false,
  );
  const canSetUpMessaging =
    messaging === null &&
    missingMessaging === undefined &&
    pair.sides.every((side) => side.managed);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="space-y-2">
        <div className="flex min-h-6 items-center gap-1.5">
          <ConnectionStatusDot
            tooltipText={
              messaging?.problems[0] ??
              (paused ? "Tools are paused: Linked environments is off" : null) ??
              expiryLine ??
              (messaging === null ? "Messaging isn't set up" : "Linked")
            }
            dotClassName={
              wrong
                ? "bg-destructive"
                : renewDue || messaging === null || paused
                  ? "bg-warning"
                  : "bg-success"
            }
            pingClassName={null}
          />
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</h3>
          {renewDue && renewableSides(pair).length > 0 ? (
            <Button
              size="xs"
              variant={expiry.kind === "expired" ? "default" : "outline"}
              disabled={busy}
              onClick={() => void renew()}
            >
              {renewing ? "Renewing…" : "Renew"}
            </Button>
          ) : null}
          {canSetUpMessaging ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onSetUpMessaging(pair)}
            >
              Set up messaging
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  disabled={busy}
                  aria-label={`More actions for ${title}`}
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              {renewableSides(pair).length > 0 ? (
                <MenuItem onClick={() => void renew()}>
                  <RefreshCwIcon />
                  Renew tools
                </MenuItem>
              ) : null}
              {editableSides(pair).length > 0 ? (
                <MenuItem onClick={() => setEditing(true)}>
                  <PencilIcon />
                  Edit address
                </MenuItem>
              ) : null}
              {renewableSides(pair).length > 0 || editableSides(pair).length > 0 ? (
                <MenuSeparator />
              ) : null}
              <MenuItem
                variant="destructive"
                disabled={removableSides(pair).length === 0}
                onClick={() => void remove()}
              >
                {removing ? "Removing…" : "Remove…"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>

        <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
          <dt className="pt-0.5 text-muted-foreground">Messages</dt>
          <dd className="flex min-w-0 flex-col gap-0.5 text-sm text-foreground">
            {messaging === null ? (
              <span className="text-warning-foreground">
                {missingMessaging === undefined
                  ? "Tools work. Messaging isn't set up."
                  : `Tools work. Messaging needs J5 Code on ${missingMessaging.label}.`}
              </span>
            ) : (
              <>
                <span>
                  {messaging.travel}
                  {messaging.state === null ? null : (
                    <span className="text-muted-foreground"> · {messaging.state}</span>
                  )}
                </span>
                {messaging.reach === null ? null : <Detail>{messaging.reach}</Detail>}
                {messaging.problems.map((problem) => (
                  <Detail key={problem} tone="destructive">
                    {problem}
                  </Detail>
                ))}
              </>
            )}
          </dd>

          <dt className="pt-1 text-muted-foreground">Tools</dt>
          <dd className="flex min-w-0 flex-col gap-2">
            {shown.map((holder, index) => {
              const other = otherSideOf(pair, holder);
              const state = stateOf(holder);
              const linkHealth = health[index] ?? null;
              const readable = holder.managed && holder.linksRead;
              return (
                <div key={holder.environmentId} className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex min-h-7 items-center justify-between gap-3">
                    <span className="min-w-0 text-sm text-foreground">
                      <span className="font-medium">{holder.label}</span>'s agents on{" "}
                      <span className="font-medium">{other.label}</span>
                    </span>
                    {readable ? (
                      <ToolsLevelPicker
                        value={toolsLevelOf(holder)}
                        holder={holder.label}
                        other={other.label}
                        disabled={busy || state.busy}
                        onlyOff={!other.managed}
                        onChange={(level) => void changeLevel(holder, level)}
                      />
                    ) : null}
                  </div>
                  {!holder.managed ? (
                    <Detail>
                      {unmanagedReason(holder.label, awayOf(holder.environmentId))}, so it can't
                      show or change this.
                    </Detail>
                  ) : !holder.linksRead ? (
                    <Detail>Couldn't read {holder.label}'s links.</Detail>
                  ) : !other.managed ? (
                    <Detail>
                      {unmanagedReason(other.label, awayOf(other.environmentId))}, so it can't{" "}
                      {toolsLevelOf(holder) === "off" ? "turn this on" : "change or renew this"}.
                    </Detail>
                  ) : null}
                  {pausedBy(holder).length > 0 ? (
                    <Detail tone="warning">
                      Paused: Linked environments is off on{" "}
                      {pausedBy(holder)
                        .map((side) => side.label)
                        .join(" and ")}
                      . Turn it on there in Settings → Labs.
                    </Detail>
                  ) : null}
                  {linkHealth?.kind === "unreachable" ? (
                    <Detail>
                      {linkHealth.detail ??
                        `${other.label} isn't answering ${holder.label} right now.`}
                    </Detail>
                  ) : linkHealth?.kind === "failing" ? (
                    <Detail tone="destructive">{linkHealth.detail}</Detail>
                  ) : null}
                  {state.error === null ? null : <Detail tone="destructive">{state.error}</Detail>}
                </div>
              );
            })}
            {expiryLine === null ? null : (
              <Detail
                tone={expiry.kind === "expired" ? "destructive" : renewDue ? "warning" : "muted"}
              >
                {expiryLine}
              </Detail>
            )}
            {messaging !== null && levelsKnown && toolsOff ? (
              <Detail>Choose a level to let one server's agents use tools on the other.</Detail>
            ) : null}
          </dd>
        </dl>
      </div>
      {editing ? (
        <PeerEditDialog
          pair={pair}
          onClose={() => setEditing(false)}
          onOriginChanged={(changed, origin) => {
            const holder = pair.sides.find((side) => side.environmentId === changed.environmentId);
            // The link was made at the address messages took; it follows them to the new one. One
            // that ran out is left alone: only the person renews a link.
            if (
              holder?.link != null &&
              peerLinkHealth(holder.link, DateTime.makeUnsafe(Date.now())).kind !== "expired"
            ) {
              void changeLevel(holder, holder.link.access, origin);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function Detail({
  tone = "muted",
  children,
}: {
  readonly tone?: "muted" | "warning" | "destructive";
  readonly children: ReactNode;
}) {
  return (
    <span
      className={
        tone === "destructive"
          ? "text-xs text-destructive"
          : tone === "warning"
            ? "text-xs text-warning-foreground"
            : "text-xs text-muted-foreground"
      }
    >
      {children}
    </span>
  );
}
