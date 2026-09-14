import type { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import { ArtifactWorkspace } from "../artifacts/ArtifactWorkspace.ts";
import { AgentHandoffNudgeQueue } from "./agentHandoffNudgeQueue.ts";
import { makeAgentHandoffStore } from "./agentHandoffStore.ts";
import { agentHandoffArtifactPath } from "./agentPersonaArtifacts.ts";
import { makeAgentPersonaLibrary } from "./agentPersonaLibrary.ts";

/**
 * The handoff gate. After each run of a saved-agent task whose definition declares an output
 * artifact, check the shared artifacts for the expected file. Present: record `written`.
 * Absent the first time: record `nudged` and queue one follow-up message asking the agent to
 * write it (the parent sees a pending child run instead of a clean completion). Absent again:
 * record `missing`. Wraps the upstream observer so the refresh behavior it owns is preserved.
 */
export const layer = Layer.effect(
  RunFinalization.RunFinalizationObserver,
  Effect.gen(function* () {
    const artifacts = yield* ArtifactWorkspace;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const nudges = yield* AgentHandoffNudgeQueue;
    const store = yield* makeAgentHandoffStore;
    const library = yield* makeAgentPersonaLibrary;
    const upstream = yield* RunFinalization.RunFinalizationObserver;

    const check = Effect.fn("j5.agentHandoffObserver.check")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) {
      const projection = yield* projections.getThreadProjection(input.threadId);
      const assignment = projection.thread.agentPersonaAssignment;
      if (assignment === undefined) return;
      const run = projection.runs.find((candidate) => candidate.id === input.runId);
      if (run !== undefined && run.status !== "completed") return;
      const definition = yield* library.readSnapshot(assignment);
      if (definition.outputArtifact === undefined) return;
      const path = agentHandoffArtifactPath({
        personaId: assignment.personaId,
        artifact: definition.outputArtifact,
        threadId: input.threadId,
      });
      const projectId = projection.thread.projectId;
      const entries = yield* artifacts.list(projectId);
      const written = entries.some((entry) => entry.path === path);
      const previous = yield* store.get(input.threadId);
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const base = {
        threadId: input.threadId,
        projectId,
        personaId: assignment.personaId,
        artifact: definition.outputArtifact,
        path,
        runId: input.runId,
        checkedAt,
      };
      if (written) return yield* store.upsert({ ...base, status: "written" });
      if (previous?.status === "nudged") {
        yield* Effect.logWarning("j5.agent-handoff.missing", { threadId: input.threadId, path });
        return yield* store.upsert({ ...base, status: "missing" });
      }
      yield* store.upsert({ ...base, status: "nudged" });
      yield* Queue.offer(nudges, {
        projectId,
        threadId: input.threadId,
        runId: input.runId,
        personaId: assignment.personaId,
        artifact: definition.outputArtifact,
        path,
      });
    });

    return RunFinalization.RunFinalizationObserver.of({
      refreshAfterTurn: upstream.refreshAfterTurn,
      refresh: (input) =>
        upstream.refresh(input).pipe(
          Effect.andThen(
            check(input).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("j5.agent-handoff.check-failed", {
                  cause,
                  threadId: input.threadId,
                  runId: input.runId,
                }),
              ),
            ),
          ),
        ),
    });
  }),
);
