import {
  linkTakesOrigin,
  peeringChoiceReady,
  recommendPeering,
  type PeeringChoice,
  type PeeringReach,
  type PeeringServer,
} from "@t3tools/client-runtime/j5/peering";
import type { AuthMcpClientAccess, EnvironmentId, PeerLinkSummary } from "@t3tools/contracts";
import { PeerOrigin } from "@t3tools/contracts/j5";
import * as Schema from "effect/Schema";

import type { PeeringCheck } from "../peering/peeringCheck";
import type { PeerRecord } from "../peering/peeringClient";
import type { StepReport } from "../peering/peeringParts";
import { makeLink, type LinkOps } from "./linkChanges";
import { toolsAddressOf, type LinkPair, type ToolsLevel } from "./linkPairs";

/** One server's facts for linking, from the descriptor and settings this client holds for it. */
export interface LinkSetupServer extends PeeringServer {
  /** It publishes upstream's links, so agents can be given tools across them. */
  readonly supportsLinks: boolean;
  /** Upstream's Linked environments setting; a link needs it on at both ends. */
  readonly linkedEnvironmentsEnabled: boolean;
}

/**
 * What two servers can be linked for. A server that publishes upstream's links and no J5 peering
 * runs T3 Code: it is linked for tools only. One that publishes neither is a J5 too old to link.
 */
export type PairSupport =
  | { readonly kind: "full" }
  | { readonly kind: "tools-only" }
  | { readonly kind: "too-old"; readonly server: LinkSetupServer };

const pairSupportOf = (local: LinkSetupServer, remote: LinkSetupServer): PairSupport => {
  if (local.supportsPoll && remote.supportsPoll) return { kind: "full" };
  if (local.supportsLinks && remote.supportsLinks) return { kind: "tools-only" };
  return { kind: "too-old", server: remote.supportsLinks || remote.supportsPoll ? local : remote };
};

/** Which of the two holds a record the other does not: the server being linked, or the other one. */
export type LeftoverSide = "local" | "remote";

/** Another server as the link dialog lists it for the one being linked. */
export interface LinkCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Why nothing can be set up with it from here: not connected, not managed, or too old. */
  readonly blocked: string | null;
  /** Why the link dialog cannot tick it: `blocked`, or that the two are linked already. */
  readonly unavailable: string | null;
  /** The two already exchange messages: each records the other. */
  readonly messaging: boolean;
  readonly server: LinkSetupServer | null;
  /** Messages and tools, or tools alone for a server that does not run J5. */
  readonly support: "full" | "tools-only";
  /**
   * The one server that still records the other, when only one does: a removal made on one side,
   * or an introduction that failed halfway. It is cleared before messaging is set up.
   */
  readonly clearLeftover: LeftoverSide | null;
  /**
   * The level each direction already has and keeps. A link that ran out, or one on a pair with a
   * leftover record (whose session the other side's removal may have revoked), is made again.
   */
  readonly localLevel: AuthMcpClientAccess | null;
  readonly remoteLevel: AuthMcpClientAccess | null;
}

export function linkCandidateOf(input: {
  readonly local: LinkSetupServer;
  readonly other: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connected: boolean;
    /** This client can manage access there. */
    readonly managed: boolean;
    readonly server: LinkSetupServer | null;
  };
  /** The pair the two already make, as the managed servers record it. */
  readonly pair: LinkPair | null;
  /**
   * One of the two whose peers or links this client could not read. What the pair already is
   * cannot be told then, so nothing is set up over it.
   */
  readonly unread?: string | null;
}): LinkCandidate {
  const { local, other, pair } = input;
  const sideOf = (environmentId: EnvironmentId) =>
    pair?.sides.find((side) => side.environmentId === environmentId) ?? null;
  const [mine, theirs] = [sideOf(local.environmentId), sideOf(other.environmentId)];
  const support = other.server === null ? null : pairSupportOf(local, other.server);
  const [mineRecords, theirsRecords] = [mine?.record != null, theirs?.record != null];
  // A server whose records this client did not read shows none, which says nothing of what it holds.
  const bothRead = mine?.read === true && theirs?.read === true;
  const messaging = bothRead ? mineRecords && theirsRecords : mineRecords || theirsRecords;
  const clearLeftover: LeftoverSide | null =
    !bothRead || mineRecords === theirsRecords ? null : mineRecords ? "local" : "remote";
  const keptLevel = (side: typeof mine) =>
    clearLeftover !== null || side?.link == null || side.link.status === "expired"
      ? null
      : side.link.access;
  const linked =
    support?.kind === "tools-only" ? (mine?.link ?? theirs?.link ?? null) !== null : messaging;
  const blocked =
    !other.connected || support === null
      ? "Not connected"
      : !other.managed
        ? "This app can't manage access there"
        : support.kind === "too-old"
          ? `Update J5 on ${support.server.label} first`
          : // A server that does not run J5 has no peers to read, so only a full pair needs them.
            support.kind === "full" && (input.unread ?? null) !== null
            ? `Couldn't read ${input.unread}'s links`
            : null;
  return {
    environmentId: other.environmentId,
    label: other.label,
    blocked,
    unavailable: blocked ?? (linked ? "Already linked" : null),
    messaging,
    server: other.server,
    support: support?.kind === "tools-only" ? "tools-only" : "full",
    clearLeftover,
    localLevel: keptLevel(mine),
    remoteLevel: keptLevel(theirs),
  };
}

/**
 * What an agent's request finds of this server's link to the one picked: none, so it is made;
 * one that ran out, so it is renewed; or a live one, which the agent can use as it is.
 */
export const requestLinkStateOf = (
  link: Pick<PeerLinkSummary, "status" | "expiresAt"> | null,
  nowMs: number,
): "new" | "renew" | "existing" =>
  link === null
    ? "new"
    : link.status === "expired" || link.expiresAt.epochMilliseconds <= nowMs
      ? "renew"
      : "existing";

type Connections = PeeringChoice["connections"];
type OriginField = "localOrigin" | "remoteOrigin";
const isPeerOrigin = Schema.is(PeerOrigin);

/** One way a pair's messages can travel, as Change offers it. */
interface RouteOption {
  readonly connections: Connections;
  /** The check's own pick. */
  readonly recommended: boolean;
  /** The addresses the check did not prove, which the person types for this option. */
  readonly asks: ReadonlyArray<OriginField>;
}

/** The address each option needs: where this server reaches the other, and the reverse. */
const NEEDS: Record<Connections, ReadonlyArray<OriginField>> = {
  both: ["remoteOrigin", "localOrigin"],
  "local-only": ["remoteOrigin"],
  "remote-only": ["localOrigin"],
};

const reachOf = (check: PeeringCheck, field: OriginField): PeeringReach =>
  field === "remoteOrigin" ? check.localToRemote : check.remoteToLocal;

const provenOrigin = (reach: PeeringReach) => (reach.kind === "reached" ? reach.origin : "");

/**
 * Every way messages can travel, with the check's pick marked. A way that needs a direction the
 * check could not prove asks for that address: the person may know one the servers do not offer.
 */
function routeOptionsOf(input: {
  readonly local: PeeringServer;
  readonly remote: PeeringServer;
  readonly check: PeeringCheck;
}): ReadonlyArray<RouteOption> {
  const recommendation = recommendPeering({
    local: input.local,
    remote: input.remote,
    ...input.check,
  });
  // Where the check alone cannot say store or direct, storing is the pick: it works on any network.
  const picked = recommendation.kind === "setup" ? recommendation.choice.connections : null;
  return (Object.keys(NEEDS) as ReadonlyArray<Connections>).map((connections) => ({
    connections,
    recommended: connections === picked,
    asks: NEEDS[connections].filter((field) => reachOf(input.check, field).kind !== "reached"),
  }));
}

/** What the person changed for one pair; anything unset follows the check and the shared levels. */
export interface PairEdits {
  readonly connections?: Connections;
  readonly localOrigin?: string;
  readonly remoteOrigin?: string;
  readonly localLevel?: ToolsLevel;
  readonly remoteLevel?: ToolsLevel;
}

/**
 * The levels linking a pair uses. Its own count only while their pickers are shown: beside other
 * ticked servers, or when a direction keeps a level. A direction that keeps its level plans none.
 */
export function pairLevelsOf(input: {
  readonly candidate: Pick<LinkCandidate, "localLevel" | "remoteLevel">;
  readonly edits: PairEdits;
  readonly shared: { readonly local: ToolsLevel; readonly remote: ToolsLevel };
  readonly tickedCount: number;
}): { readonly own: boolean; readonly localLevel: ToolsLevel; readonly remoteLevel: ToolsLevel } {
  const { candidate, shared } = input;
  const own =
    input.tickedCount > 1 || candidate.localLevel !== null || candidate.remoteLevel !== null;
  const edits = own ? input.edits : {};
  return {
    own,
    localLevel: candidate.localLevel === null ? (edits.localLevel ?? shared.local) : "off",
    remoteLevel: candidate.remoteLevel === null ? (edits.remoteLevel ?? shared.remote) : "off",
  };
}

type Named = { readonly label: string };

/** A way of travelling in a line, and the reason to pick it. */
export const routeWording = (connections: Connections, local: Named, remote: Named) => {
  const polls = (poller: Named, storer: Named) => ({
    line: `${poller.label} polls ${storer.label} for messages`,
    title: `${poller.label} polls ${storer.label}`,
    when: `${poller.label} isn't always on, or can't be reached`,
  });
  return connections === "both"
    ? {
        line: "Messages are sent directly both ways",
        title: "Sent directly both ways",
        when: "both always on and reachable",
      }
    : connections === "local-only"
      ? polls(local, remote)
      : polls(remote, local);
};

/** An address Change asks for, and why the pair cannot be linked with what it holds. */
export interface RouteField {
  readonly field: OriginField;
  readonly error: string | null;
}

/** How a pair's messages will travel, as its one line says it and as Change lets it be picked. */
export interface PairRoute {
  readonly options: ReadonlyArray<RouteOption>;
  /** The person's pick, else the check's; null while checking and when the check found no way. */
  readonly choice: PeeringChoice | null;
  /**
   * The addresses Change shows for the choice: each the check did not prove, each the person
   * typed, and each proven one that tools cannot use while its direction's tools are on.
   */
  readonly fields: ReadonlyArray<RouteField>;
  /** Every address the choice needs is there and carries what is asked of it. */
  readonly ready: boolean;
  readonly line: string;
  readonly problem: boolean;
}

export function pairRouteOf(input: {
  readonly local: PeeringServer;
  readonly remote: PeeringServer;
  /** Null while the check runs. */
  readonly check: PeeringCheck | null;
  readonly edits: PairEdits;
  /** Change is open for this pair, so its address fields say what is missing. */
  readonly changing?: boolean;
  /** The tools this linking makes each way; a direction that is Off or keeps its link makes none. */
  readonly levels?: { readonly localLevel: ToolsLevel; readonly remoteLevel: ToolsLevel };
}): PairRoute {
  const { check, edits, local, remote } = input;
  if (check === null) {
    return {
      options: [],
      choice: null,
      fields: [],
      ready: false,
      line: "Checking…",
      problem: false,
    };
  }
  const options = routeOptionsOf({ local: input.local, remote: input.remote, check });
  const connections =
    edits.connections ?? options.find((option) => option.recommended)?.connections;
  if (connections === undefined) {
    return {
      options,
      choice: null,
      fields: [],
      ready: false,
      line:
        check.localToRemote.kind === "failed" && check.remoteToLocal.kind === "failed"
          ? "Neither server could reach the other. Use Change to enter an address."
          : "The check couldn't find how these servers reach each other. Use Change to enter an address.",
      problem: true,
    };
  }
  const choice: PeeringChoice = {
    connections,
    localOrigin: edits.localOrigin ?? provenOrigin(check.remoteToLocal),
    remoteOrigin: edits.remoteOrigin ?? provenOrigin(check.localToRemote),
  };
  const asks = options.find((option) => option.connections === connections)?.asks ?? [];
  // Tools take the address messages take: this server's agents reach the other at remoteOrigin.
  const toolsOver = {
    remoteOrigin: { level: input.levels?.localLevel ?? "off", agents: local },
    localOrigin: { level: input.levels?.remoteLevel ?? "off", agents: remote },
  };
  const fields = NEEDS[connections].flatMap((field): ReadonlyArray<RouteField> => {
    const value = choice[field];
    const { level, agents } = toolsOver[field];
    const error =
      value.trim() === ""
        ? "The check couldn't find this address. Enter it to link."
        : !isPeerOrigin(value)
          ? "Enter an address such as https://host:3773, with no path or trailing slash."
          : level !== "off" && !linkTakesOrigin(value)
            ? `Plain http works for messages, not for tools. Enter an https address or a Tailscale name (ending .ts.net), or set ${agents.label}'s agents to Off.`
            : null;
    return asks.includes(field) || edits[field] !== undefined || error !== null
      ? [{ field, error }]
      : [];
  });
  const toolsRefused = peeringChoiceReady(choice) && fields.some((field) => field.error !== null);
  const ready = peeringChoiceReady(choice) && !toolsRefused;
  const { line } = routeWording(connections, local, remote);
  return {
    options,
    choice,
    fields,
    ready,
    // With Change open, each address still needed is asked for on its own field.
    line:
      ready || input.changing === true
        ? line
        : `${line} · ${toolsRefused ? "tools need another address" : "needs an address"}`,
    problem: !ready && input.changing !== true,
  };
}

export interface PairLinkServer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export type PairMessaging =
  | {
      readonly kind: "set-up";
      readonly choice: PeeringChoice;
      /** The one server that still holds an old record of the other, cleared first. */
      readonly clearLeftover: LeftoverSide | null;
    }
  | { readonly kind: "existing" }
  /** A server that does not run J5: upstream's link alone, at addresses this client knows. */
  | {
      readonly kind: "none";
      /** Where the other server may reach this one, and where this one may reach the other. */
      readonly localUrls: ReadonlyArray<string>;
      readonly remoteUrls: ReadonlyArray<string>;
    };

export interface PairLinkPlan {
  readonly local: PairLinkServer;
  readonly remote: PairLinkServer;
  readonly messaging: PairMessaging;
  /** What this server's agents may do on the other, and the other's on this one. */
  readonly localLevel: ToolsLevel;
  readonly remoteLevel: ToolsLevel;
  /** The servers whose Linked environments setting is turned on first. */
  readonly turnOn: ReadonlyArray<PairLinkServer>;
  /** How many directions already have tools and stay as they are. */
  readonly kept?: number;
}

export interface PairLinkOps extends Pick<
  LinkOps,
  "enableLinkedEnvironments" | "mintPairingCode" | "link" | "forget" | "removePeer"
> {
  /** Sets up messaging as chosen; each step is reported, and a failed one ends it. */
  readonly introduce: (
    choice: PeeringChoice,
    local: PairLinkServer,
    remote: PairLinkServer,
  ) => Promise<{ readonly ok: boolean; readonly steps: ReadonlyArray<StepReport> }>;
  /** `holder`'s record of `other`, read again now. */
  readonly peerRecord: (holder: EnvironmentId, other: EnvironmentId) => Promise<PeerRecord | null>;
}

export interface DirectionResult {
  readonly holder: PairLinkServer;
  readonly other: PairLinkServer;
  readonly level: AuthMcpClientAccess;
  /** Why the direction's tools could not be made; it is left Off. Null when they were. */
  readonly error: string | null;
}

export interface PairLinkResult {
  readonly messaging: "set-up" | "existing" | "none" | "failed";
  /** What setting up messaging did, step by step, when it failed. */
  readonly steps: ReadonlyArray<StepReport>;
  readonly directions: ReadonlyArray<DirectionResult>;
  /** Directions that had tools before and were left alone; they count in what the pair now has. */
  readonly kept?: number;
  /** A session an old link held on the other server that clearing it could not end. */
  readonly notes?: ReadonlyArray<string>;
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Messaging as planned, then the setting. A failed step of messaging ends the pair there. */
const setUpPair = async (
  plan: PairLinkPlan,
  ops: PairLinkOps,
): Promise<
  | { readonly ok: false; readonly steps: ReadonlyArray<StepReport> }
  | {
      readonly ok: true;
      readonly settingError: string | null;
      /** A session an old link held on the other server that could not be ended. */
      readonly notes: ReadonlyArray<string>;
    }
> => {
  const { local, remote, messaging } = plan;
  const notes: Array<string> = [];
  if (messaging.kind === "set-up") {
    const cleared: Array<StepReport> = [];
    if (messaging.clearLeftover !== null) {
      const [holder, recorded] =
        messaging.clearLeftover === "local" ? [local, remote] : [remote, local];
      const forget = (from: PairLinkServer, to: PairLinkServer) => async () => {
        const { detail } = await ops.forget(from.environmentId, to.environmentId);
        if (detail !== null) notes.push(detail);
        return detail;
      };
      // What is left of the old pair goes with the record, links first: clearing the record
      // revokes the sessions the other's links hold, and a link revokes its own with a live token.
      const clearing = [
        [`Forget ${local.label}'s old link to ${remote.label}`, forget(local, remote)],
        [`Forget ${remote.label}'s old link to ${local.label}`, forget(remote, local)],
        [
          `Clear ${holder.label}'s old record of ${recorded.label}`,
          async () => {
            await ops.removePeer(holder.environmentId, recorded.environmentId);
            return null;
          },
        ],
      ] as const;
      for (const [title, run] of clearing) {
        try {
          // A session a forgotten link left behind stays on its step, so a later failure shows it.
          cleared.push({ title, status: "done", detail: await run() });
        } catch (cause) {
          return {
            ok: false,
            steps: [...cleared, { title, status: "failed", detail: errorText(cause) }],
          };
        }
      }
    }
    const introduced = await ops.introduce(messaging.choice, local, remote);
    if (!introduced.ok) return { ok: false, steps: [...cleared, ...introduced.steps] };
  }
  let settingError: string | null = null;
  for (const server of plan.turnOn) {
    try {
      await ops.enableLinkedEnvironments(server.environmentId);
    } catch (cause) {
      settingError ??= `Linked environments could not be turned on for ${server.label}: ${errorText(cause)}`;
    }
  }
  return { ok: true, settingError, notes };
};

/**
 * Where `holder`'s link to `other` is made: the address its messages take now, read from its
 * record as it stands after messaging was set up, or the addresses given for a tools-only pair.
 */
const toolsUrlsOf = async (
  plan: PairLinkPlan,
  holder: PairLinkServer,
  other: PairLinkServer,
  ops: PairLinkOps,
): Promise<
  | { readonly urls: readonly [string, ...Array<string>] }
  | { readonly urls: null; readonly error: string }
> => {
  if (plan.messaging.kind === "none") {
    const [first, ...rest] =
      holder === plan.local ? plan.messaging.remoteUrls : plan.messaging.localUrls;
    return first === undefined
      ? { urls: null, error: `This app knows no address for ${other.label}.` }
      : { urls: [first, ...rest] };
  }
  const record = await ops.peerRecord(holder.environmentId, other.environmentId);
  const address = toolsAddressOf(record);
  if (address !== null) return { urls: [address] };
  return {
    urls: null,
    error:
      record?.linkMode === "store"
        ? `${other.label} has not connected to ${holder.label} yet, so ${holder.label} can't reach it.`
        : `${holder.label} has no address for ${other.label}.`,
  };
};

/**
 * Links one pair: messaging first, then each direction's tools at the address its messages now
 * take. Messaging that fails ends the pair with nothing linked. A direction's tools that fail
 * leave that direction Off and everything else standing.
 */
export async function linkPair(plan: PairLinkPlan, ops: PairLinkOps): Promise<PairLinkResult> {
  const setUp = await setUpPair(plan, ops);
  if (!setUp.ok) return { messaging: "failed", steps: setUp.steps, directions: [] };
  const directions: Array<DirectionResult> = [];
  for (const [holder, other, level] of [
    [plan.local, plan.remote, plan.localLevel],
    [plan.remote, plan.local, plan.remoteLevel],
  ] as const) {
    if (level === "off") continue;
    let error = setUp.settingError;
    if (error === null) {
      try {
        const found = await toolsUrlsOf(plan, holder, other, ops);
        if (found.urls === null) error = found.error;
        else {
          await makeLink({ holder: holder.environmentId, other, level, urls: found.urls, ops });
        }
      } catch (cause) {
        error = errorText(cause);
      }
    }
    directions.push({ holder, other, level, error });
  }
  return {
    messaging: plan.messaging.kind === "set-up" ? "set-up" : plan.messaging.kind,
    steps: [],
    directions,
    kept: plan.kept ?? 0,
    notes: setUp.notes,
  };
}

/**
 * Everything an agent's link request needs before its own answer makes the link: messaging,
 * the setting, and the address this server's link to the other is made at. The link itself is
 * upstream's, made when the card is answered.
 */
export async function prepareRequestLink(
  plan: PairLinkPlan,
  ops: PairLinkOps,
): Promise<
  | { readonly ok: true; readonly urls: readonly [string, ...Array<string>] }
  | { readonly ok: false; readonly steps: ReadonlyArray<StepReport>; readonly error: string | null }
> {
  const setUp = await setUpPair(plan, ops);
  if (!setUp.ok) return { ok: false, steps: setUp.steps, error: null };
  if (setUp.settingError !== null) return { ok: false, steps: [], error: setUp.settingError };
  try {
    const found = await toolsUrlsOf(plan, plan.local, plan.remote, ops);
    return found.urls === null
      ? { ok: false, steps: [], error: found.error }
      : { ok: true, urls: found.urls };
  } catch (cause) {
    return { ok: false, steps: [], error: errorText(cause) };
  }
}

/** The servers a pair's levels need Linked environments on for, of those that have it off. */
export const turnOnFor = (input: {
  readonly local: LinkSetupServer;
  readonly remote: LinkSetupServer;
  readonly localLevel: ToolsLevel;
  readonly remoteLevel: ToolsLevel;
}): ReadonlyArray<LinkSetupServer> =>
  input.localLevel === "off" && input.remoteLevel === "off"
    ? []
    : [input.local, input.remote].filter((server) => !server.linkedEnvironmentsEnabled);

/** What linking a pair came to, in the words its result line uses. */
export function pairResultOf(result: PairLinkResult): {
  readonly headline: string;
  readonly problems: ReadonlyArray<string>;
} {
  if (result.messaging === "failed") return { headline: "Not linked.", problems: [] };
  const made =
    (result.kept ?? 0) + result.directions.filter((direction) => direction.error === null).length;
  const tools = made === 2 ? "tools both ways" : made === 1 ? "tools one way" : null;
  return {
    headline:
      result.messaging === "none"
        ? tools === null
          ? "Not linked."
          : `Linked for ${tools}.`
        : `Linked for messages${tools === null ? "" : ` and ${tools}`}.`,
    problems: [
      ...result.directions.flatMap((direction) =>
        direction.error === null
          ? []
          : [
              `${direction.holder.label}'s agents can't use tools on ${direction.other.label} yet: ${direction.error} That direction is Off; choose a level on the pair's row to try again.`,
            ],
      ),
      ...(result.notes ?? []),
    ],
  };
}
