import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import type { ChatMessage } from "~/types";
import {
  displayedSpawnBriefState,
  isSpawnBriefMessage,
  participantIdsForSpawnBrief,
  presentSpawnBrief,
  presentSpawnerIdentity,
} from "./SpawnBrief";

const CREATED_AT = "2026-09-17T12:00:00.000Z";
const SPAWN_BRIEF_ID = MessageId.make(
  "message:j5:a2a:mcp:session-1:spawn-brief:spawn-arch-review-20260917",
);

function message(input: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: SPAWN_BRIEF_ID,
    role: "user",
    text: "",
    runId: null,
    streaming: false,
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input,
  };
}

const brief = [
  "IDENTITY: You are the ARCHITECTURE REVIEWER.",
  "",
  "TASK: Review both repos: agent-ops and obs-sentinel.",
  "",
  'REPLY: send_message(to="agent:director") when done.',
].join("\n");

const currentRaw = [
  "<j5_spawn_context>",
  "Platform-provided identity facts:",
  "participant_id: agent:reviewer",
  "squadron_id: squadron:prod",
  "squadron_name: Production Monitoring",
  "spawned_by: agent:director",
  "spawner_thread_id: thread-director",
  "</j5_spawn_context>",
  "",
  "<spawner_brief>",
  brief,
  "</spawner_brief>",
].join("\n");

const legacyRaw = [
  "<j5_spawn_context>",
  "Platform-provided identity facts:",
  "participant_id: agent:reviewer",
  "squadron_id: squadron:prod",
  "squadron_name: Production Monitoring",
  "</j5_spawn_context>",
  "",
  "<spawner_brief>",
  brief,
  "</spawner_brief>",
].join("\n");

describe("presentSpawnBrief", () => {
  it("separates the brief from the platform facts and names the spawner", () => {
    expect(presentSpawnBrief(message({ text: currentRaw }))).toEqual({
      brief,
      participantId: "agent:reviewer",
      squadronId: "squadron:prod",
      squadronName: "Production Monitoring",
      spawnedBy: "agent:director",
      spawnerThreadId: "thread-director",
    });
    expect(participantIdsForSpawnBrief(message({ text: currentRaw }))).toEqual(["agent:director"]);
  });

  it("keeps briefs written before the spawner facts existed, without a spawner", () => {
    expect(presentSpawnBrief(message({ text: legacyRaw }))).toMatchObject({
      brief,
      spawnedBy: null,
      spawnerThreadId: null,
    });
    expect(participantIdsForSpawnBrief(message({ text: legacyRaw }))).toEqual([]);
  });

  it("gates on the spawn-brief message id, never on envelope-looking text", () => {
    const delivery = message({
      id: MessageId.make("message:j5:a2a:delivery:abc"),
      text: currentRaw,
    });
    expect(isSpawnBriefMessage(delivery)).toBe(false);
    expect(presentSpawnBrief(delivery)).toBeNull();
    expect(
      presentSpawnBrief(message({ id: MessageId.make("message-1"), text: currentRaw })),
    ).toBeNull();
    expect(presentSpawnBrief(message({ role: "assistant", text: currentRaw }))).toBeNull();
  });

  it("returns null for an unrecognized template so the raw text stays visible", () => {
    expect(presentSpawnBrief(message({ text: "Just a brief with no wrapper." }))).toBeNull();
    expect(
      presentSpawnBrief(message({ text: currentRaw.replace("squadron_name: ", "name: ") })),
    ).toBeNull();
    expect(presentSpawnBrief(message({ text: currentRaw.slice(0, -5) }))).toBeNull();
  });
});

describe("displayedSpawnBriefState", () => {
  it("shows a brief that quotes composer context tags verbatim", () => {
    const quoting = [
      "Review the terminal capture format. A user message ends like this:",
      "",
      "<terminal_context>",
      "- zsh:",
      "  npm test",
      "</terminal_context>",
    ].join("\n");

    // The generic user-row derivation would strip the quoted block.
    expect(deriveDisplayedUserMessageState(quoting).visibleText).not.toBe(quoting);

    const state = displayedSpawnBriefState(quoting);
    expect(state.visibleText).toBe(quoting);
    expect(state.copyText).toBe(quoting);
    expect(state.contexts).toEqual([]);
    expect(state.elementContexts).toEqual([]);
  });
});

describe("presentSpawnerIdentity", () => {
  it("names a known spawner without a tooltip", () => {
    expect(
      presentSpawnerIdentity({
        spawnedBy: "agent:director",
        participantLabels: new Map([["agent:director", "Director"]]),
      }),
    ).toEqual({ label: "Director", tooltipParticipantId: null });
  });

  it("stays honest about unknown and missing spawners", () => {
    expect(
      presentSpawnerIdentity({ spawnedBy: "agent:director", participantLabels: new Map() }),
    ).toEqual({ label: "Unnamed participant", tooltipParticipantId: "agent:director" });
    expect(presentSpawnerIdentity({ spawnedBy: null, participantLabels: new Map() })).toEqual({
      label: "another agent",
      tooltipParticipantId: null,
    });
  });
});
