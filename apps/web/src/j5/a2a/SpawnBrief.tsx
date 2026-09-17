import { ThreadId } from "@t3tools/contracts";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import type { DisplayedUserMessageState } from "~/lib/terminalContext";
import type { ChatMessage } from "~/types";

import {
  presentParticipantIdentity,
  type ParticipantIdentityPresentation,
} from "./ParticipantIdentity";

/**
 * `spawn_agent` starts a Peer Agent's thread with one user-role message whose
 * id is `message:j5:a2a:mcp:<session>:spawn-brief:<request key>` (server
 * `spawnMessageId`). The id shape is the only gate; envelope-looking text alone
 * is never a spawn brief.
 */
const SPAWN_BRIEF_MESSAGE_ID_PATTERN = /^message:j5:a2a:mcp:[^:]+:spawn-brief:/;

const CONTEXT_OPEN = "<j5_spawn_context>\n";
const CONTEXT_CLOSE = "\n</j5_spawn_context>\n\n<spawner_brief>\n";
const BRIEF_CLOSE = "\n</spawner_brief>";

export interface SpawnBriefPresentation {
  /** The spawner's brief, without the platform wrapper. */
  readonly brief: string;
  readonly participantId: string;
  readonly squadronId: string;
  readonly squadronName: string;
  /** Null on briefs written before the server recorded the spawner. */
  readonly spawnedBy: string | null;
  readonly spawnerThreadId: ThreadId | null;
}

export function isSpawnBriefMessage(message: ChatMessage): boolean {
  return message.role === "user" && SPAWN_BRIEF_MESSAGE_ID_PATTERN.test(String(message.id));
}

/**
 * Strictly recognizes the server's `spawnFirstTurnText` template. A changed
 * template returns null so the message falls back to the plain user row rather
 * than hiding text the agent actually received.
 */
export function presentSpawnBrief(message: ChatMessage): SpawnBriefPresentation | null {
  if (!isSpawnBriefMessage(message)) return null;
  const text = message.text;
  if (!text.startsWith(CONTEXT_OPEN) || !text.endsWith(BRIEF_CLOSE)) return null;
  const closeIndex = text.indexOf(CONTEXT_CLOSE, CONTEXT_OPEN.length);
  if (closeIndex < 0) return null;

  const facts = new Map<string, string>();
  for (const line of text.slice(CONTEXT_OPEN.length, closeIndex).split("\n")) {
    const separator = line.indexOf(": ");
    if (separator > 0) facts.set(line.slice(0, separator), line.slice(separator + 2));
  }
  const participantId = facts.get("participant_id");
  const squadronId = facts.get("squadron_id");
  const squadronName = facts.get("squadron_name");
  if (!participantId || !squadronId || !squadronName) return null;
  const spawnerThreadId = facts.get("spawner_thread_id");

  return {
    brief: text.slice(closeIndex + CONTEXT_CLOSE.length, -BRIEF_CLOSE.length),
    participantId,
    squadronId,
    squadronName,
    spawnedBy: facts.get("spawned_by") ?? null,
    spawnerThreadId: spawnerThreadId ? ThreadId.make(spawnerThreadId) : null,
  };
}

export function participantIdsForSpawnBrief(message: ChatMessage): ReadonlyArray<string> {
  const spawnedBy = presentSpawnBrief(message)?.spawnedBy ?? null;
  return spawnedBy === null ? [] : [spawnedBy];
}

/**
 * A brief is literal authored text. The composer never appends its
 * `<terminal_context>`, `<element_context>`, or preview-annotation blocks to
 * it, so the user row must not run those trailing-block extractors over it: a
 * brief that quotes one of those tags would otherwise lose its tail.
 */
export function displayedSpawnBriefState(brief: string): DisplayedUserMessageState {
  return {
    visibleText: brief,
    copyText: brief,
    contextCount: 0,
    previewTitle: null,
    contexts: [],
    elementContexts: [],
  };
}

/** The spawner's name when known; otherwise the honest unnamed label with the id as a tooltip. */
export function presentSpawnerIdentity(input: {
  readonly spawnedBy: string | null;
  readonly participantLabels: ReadonlyMap<string, string>;
}): ParticipantIdentityPresentation {
  return input.spawnedBy === null
    ? { label: "another agent", tooltipParticipantId: null }
    : presentParticipantIdentity({
        participantId: input.spawnedBy,
        participantLabels: input.participantLabels,
      });
}

export function SpawnerIdentity(props: {
  readonly spawnedBy: string | null;
  readonly participantLabels: ReadonlyMap<string, string>;
}) {
  const identity = presentSpawnerIdentity(props);
  return identity.tooltipParticipantId === null ? (
    <>{identity.label}</>
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span />}>{identity.label}</TooltipTrigger>
      <TooltipPopup>{identity.tooltipParticipantId}</TooltipPopup>
    </Tooltip>
  );
}

/** Replaces upstream's "Sent by another agent" line above a spawn brief bubble. */
export function SpawnBriefAttribution(props: {
  readonly spawnedBy: string | null;
  readonly participantLabels: ReadonlyMap<string, string>;
}) {
  return (
    <p
      className="me-1 text-[11px] text-muted-foreground/70"
      data-user-message-attribution="spawn-brief"
    >
      Brief from <SpawnerIdentity {...props} />
    </p>
  );
}
