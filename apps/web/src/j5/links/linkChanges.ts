import type { AuthMcpClientAccess, EnvironmentId, PeerLinkCreateInput } from "@t3tools/contracts";
import { isPeerCredentialRejected } from "@t3tools/contracts/j5";
import { removalConfirmation } from "@t3tools/client-runtime/j5/peering";

import {
  otherSideOf,
  toolsAddressOf,
  type LinkPair,
  type LinkPairSide,
  type ToolsLevel,
} from "./linkPairs";

/** What this client knows of a server that bears on changing a link. Null when it is not here. */
export interface LinkServerFacts {
  /** Upstream's Linked environments setting; a server with it off takes no link. */
  readonly linkedEnvironmentsEnabled: boolean;
}

/** The calls a change makes, each against one server. Any of them fails by throwing. */
export interface LinkOps {
  readonly enableLinkedEnvironments: (environmentId: EnvironmentId) => Promise<void>;
  /** A one-use pairing code minted on the server being linked to, for the level. */
  readonly mintPairingCode: (
    environmentId: EnvironmentId,
    access: AuthMcpClientAccess,
  ) => Promise<string>;
  readonly link: (holder: EnvironmentId, input: PeerLinkCreateInput) => Promise<void>;
  /** Forgets the holder's link; `detail` says why its session on the other server was left. */
  readonly forget: (
    holder: EnvironmentId,
    other: EnvironmentId,
  ) => Promise<{ readonly detail: string | null }>;
  readonly removePeer: (holder: EnvironmentId, other: EnvironmentId) => Promise<void>;
}

export type LevelChangePlan =
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "off" }
  | {
      readonly kind: "link";
      readonly level: AuthMcpClientAccess;
      /** Where the holder's link is made, most preferred first. */
      readonly urls: readonly [string, ...Array<string>];
      /** The servers whose Linked environments setting this turns on, for the person to confirm. */
      readonly turnOn: ReadonlyArray<Pick<LinkPairSide, "environmentId" | "label">>;
    };

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Why this client cannot act on a server: it is away just now, or its session may not manage access. */
export const unmanagedReason = (label: string, away: boolean) =>
  away
    ? `This app isn't connected to ${label} right now`
    : `This app can't manage access on ${label}`;

/**
 * What setting `holder`'s agents' level on the other server takes. The link is made at the
 * address the holder's messages already go to, so the pair is never checked again; a pair with
 * no messaging keeps the addresses its link already has. `address` is one just recorded that the
 * pair as read does not show yet.
 */
export function planLevelChange(input: {
  readonly pair: LinkPair;
  readonly holder: LinkPairSide;
  readonly level: ToolsLevel;
  readonly factsOf: (environmentId: EnvironmentId) => LinkServerFacts | null;
  /** A server this client has but is not connected to now. */
  readonly awayOf?: (environmentId: EnvironmentId) => boolean;
  readonly address?: string;
}): LevelChangePlan {
  const { holder, level } = input;
  const other = otherSideOf(input.pair, holder);
  const unmanaged = (side: LinkPairSide) =>
    unmanagedReason(side.label, input.awayOf?.(side.environmentId) === true);
  if (!holder.managed) {
    return { kind: "blocked", reason: `${unmanaged(holder)}, so it can't change this.` };
  }
  if (level === "off") return { kind: "off" };
  if (!other.managed) {
    return { kind: "blocked", reason: `${unmanaged(other)}, so it can't change or renew this.` };
  }
  const messageAddress = input.address ?? toolsAddressOf(holder.record);
  const [first, ...rest] = messageAddress === null ? (holder.link?.urls ?? []) : [messageAddress];
  if (first === undefined) {
    return {
      kind: "blocked",
      reason:
        holder.record?.linkMode === "store"
          ? `${other.label} has not connected to ${holder.label} yet, so ${holder.label} can't reach it. Try again once ${other.label} is running.`
          : `${holder.label} has no address for ${other.label}. Set up messaging first.`,
    };
  }
  return {
    kind: "link",
    level,
    urls: [first, ...rest],
    turnOn: [holder, other].filter(
      (side) => input.factsOf(side.environmentId)?.linkedEnvironmentsEnabled === false,
    ),
  };
}

/**
 * Makes `holder`'s link to the other server: a one-use code minted there for the level, then
 * upstream's link here at the addresses given, kept only where they answer as that server.
 */
export async function makeLink(input: {
  readonly holder: EnvironmentId;
  readonly other: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly level: AuthMcpClientAccess;
  readonly urls: readonly [string, ...Array<string>];
  readonly ops: Pick<LinkOps, "mintPairingCode" | "link">;
}): Promise<void> {
  const pairingCode = await input.ops.mintPairingCode(input.other.environmentId, input.level);
  const [url, ...alternateUrls] = input.urls;
  await input.ops.link(input.holder, {
    url,
    ...(alternateUrls.length === 0 ? {} : { alternateUrls }),
    expectedEnvironmentId: input.other.environmentId,
    expectedLabel: input.other.label,
    pairingCode,
    access: input.level,
  });
}

export type LinkChangeOutcome =
  | { readonly ok: true; readonly note: string | null }
  | { readonly ok: false; readonly reason: string };

/** Carries out a plan the person has agreed to. Nothing is undone when a step fails. */
export async function applyLevelChange(input: {
  readonly pair: LinkPair;
  readonly holder: LinkPairSide;
  readonly plan: Exclude<LevelChangePlan, { readonly kind: "blocked" }>;
  readonly ops: LinkOps;
}): Promise<LinkChangeOutcome> {
  const { holder, plan, ops } = input;
  const other = otherSideOf(input.pair, holder);
  try {
    if (plan.kind === "off") {
      const forgotten = await ops.forget(holder.environmentId, other.environmentId);
      return { ok: true, note: forgotten.detail };
    }
    for (const server of plan.turnOn) await ops.enableLinkedEnvironments(server.environmentId);
    await makeLink({
      holder: holder.environmentId,
      other,
      level: plan.level,
      urls: plan.urls,
      ops,
    });
    return { ok: true, note: null };
  } catch (cause) {
    return { ok: false, reason: errorText(cause) };
  }
}

/** The directions a renewal covers: every one that has tools, at the level it has. */
export const renewableSides = (pair: LinkPair): ReadonlyArray<LinkPairSide> =>
  pair.sides.filter((side) => side.link !== null);

/**
 * The sides the row shows something to remove on: each one this client manages that holds, or
 * may hold, its part. It words the confirmation; the removal itself acts on every managed side.
 */
export const removableSides = (pair: LinkPair): ReadonlyArray<LinkPairSide> =>
  pair.sides.filter(
    (side) =>
      side.managed && (side.record !== null || side.link !== null || !side.read || !side.linksRead),
  );

/** Which of the three removals this is, and the side whose words the confirmation uses. */
export function removalOf(pair: LinkPair): {
  readonly kind: ReturnType<typeof removalConfirmation>;
  readonly holder: LinkPairSide;
  readonly other: LinkPairSide;
} {
  const removable = removableSides(pair);
  const holder =
    removable.find((side) => side.record !== null) ??
    removable.find((side) => side.link !== null) ??
    removable[0] ??
    pair.sides[0];
  const other = otherSideOf(pair, holder);
  return {
    kind: removalConfirmation({
      otherManageable: removable.includes(other),
      ended:
        (other.managed && other.read) ||
        (holder.record !== null && isPeerCredentialRejected(holder.record)),
    }),
    holder,
    other,
  };
}

export interface RemovalOutcome {
  /** A side whose part may still be there, and why. */
  readonly failures: ReadonlyArray<{ readonly side: LinkPairSide; readonly reason: string }>;
  /** A session a link held on the other server that could not be ended. */
  readonly notes: ReadonlyArray<string>;
}

/**
 * Ends both parts on every managed side, whatever the row last read: it can be behind a link just
 * made, and a side with no record may hold sessions for the other's links. Links go before peers,
 * since removing a peer revokes the token a link needs to revoke its own session. A side that
 * fails never stops the others.
 */
export async function removePair(pair: LinkPair, ops: LinkOps): Promise<RemovalOutcome> {
  const sides = pair.sides.filter((side) => side.managed);
  const failed = new Map<LinkPairSide, string>();
  const notes: Array<string> = [];
  for (const side of sides) {
    try {
      const forgotten = await ops.forget(side.environmentId, otherSideOf(pair, side).environmentId);
      if (forgotten.detail !== null) notes.push(forgotten.detail);
    } catch (cause) {
      // Reported even where the row showed no link: nothing here can prove one was not just made.
      failed.set(side, errorText(cause));
    }
  }
  for (const side of sides) {
    try {
      await ops.removePeer(side.environmentId, otherSideOf(pair, side).environmentId);
    } catch (cause) {
      failed.set(side, [failed.get(side), errorText(cause)].filter(Boolean).join(" "));
    }
  }
  return {
    failures: [...failed].map(([side, reason]) => ({ side, reason })),
    notes,
  };
}
