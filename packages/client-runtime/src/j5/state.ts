import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { J5_PLAYBOOK_WS_METHODS } from "@t3tools/contracts/j5";
import type {
  AnswerHumanExchangeRequest,
  AssignImportedThreadsRequest,
  CrewProposalResolveRequest,
  CrewProposalPreviewRequest,
  CrewArchiveRequest,
  CrewStopRequest,
  FleetReadRequest,
  PlaybookLibraryRequest,
  PlaybookDeleteRequest,
  PlaybookRenameRequest,
  PlaybookRunsRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";
import * as J5Http from "./http.ts";

const preparedConnection = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  const state = yield* SubscriptionRef.get(supervisor.state);
  if (Option.isNone(prepared) || state.phase !== "connected") {
    return yield* new J5Http.J5HttpError({ status: 0, detail: "The environment is disconnected." });
  }
  return prepared.value;
});

export const supportedJ5Read = <A extends object, E, R>(read: Effect.Effect<A, E, R>) =>
  read.pipe(
    Effect.map((data) => ({ ...data, supported: true as const })),
    Effect.catchIf(J5Http.isJ5UnsupportedError, () =>
      Effect.succeed({ supported: false as const }),
    ),
  );

/** J5 uses the same environment registry, query lifecycle, and command dispatch as other features. */
export function createJ5EnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    playbookChanges: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "j5:playbook-changes",
      tag: J5_PLAYBOOK_WS_METHODS.subscribeChanges,
      idleTtlMs: 0,
    }),
    playbookRuns: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:playbook-runs",
      staleTimeMs: 2_500,
      execute: (input: PlaybookRunsRequest) =>
        supportedJ5Read(
          preparedConnection.pipe(
            Effect.flatMap((prepared) => J5Http.readAllPlaybooks(prepared, input)),
          ),
        ),
    }),
    playbookLibrary: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:playbook-library",
      staleTimeMs: 0,
      execute: (input: PlaybookLibraryRequest) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.readPlaybookLibrary(prepared, input)),
        ),
    }),
    deletePlaybook: createEnvironmentCommand(runtime, {
      label: "j5:delete-playbook",
      execute: (input: PlaybookDeleteRequest) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.deletePlaybook(prepared, input)),
        ),
    }),
    renamePlaybook: createEnvironmentCommand(runtime, {
      label: "j5:rename-playbook",
      execute: (input: PlaybookRenameRequest) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.renamePlaybook(prepared, input)),
        ),
    }),
    playbooks: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:playbooks",
      staleTimeMs: 2_500,
      execute: (input: { readonly threadId: ThreadId }) =>
        supportedJ5Read(
          preparedConnection.pipe(
            Effect.flatMap((prepared) => J5Http.readThreadPlaybooks(prepared, input.threadId)),
          ),
        ),
    }),
    squadrons: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:squadrons",
      staleTimeMs: 30_000,
      execute: (_input: Record<string, never>) =>
        preparedConnection.pipe(Effect.flatMap(J5Http.listSquadrons)),
    }),
    inbox: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:inbox",
      staleTimeMs: 7_500,
      execute: (input: { readonly status: "open" | "answered"; readonly personId?: string }) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) =>
            J5Http.listHumanInbox(prepared, input.status, input.personId),
          ),
        ),
    }),
    openCount: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:inbox-count",
      staleTimeMs: 7_500,
      execute: (input: { readonly personId?: string }) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.readOpenInboxCount(prepared, input.personId)),
        ),
    }),
    // The Fleet page reads every connected environment's roster; it changes on the scale of turns.
    fleet: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:fleet",
      staleTimeMs: 30_000,
      execute: (input: FleetReadRequest) =>
        preparedConnection.pipe(Effect.flatMap((prepared) => J5Http.readFleet(prepared, input))),
    }),
    // Crew gates are read per environment like the inbox; a Captain on any connected server
    // reaches the human's bell and thread.
    crewProposals: createEnvironmentQueryAtomFamily(runtime, {
      label: "j5:crew-proposals",
      staleTimeMs: 7_500,
      execute: (_input: Record<string, never>) =>
        preparedConnection.pipe(Effect.flatMap(J5Http.listCrewProposals)),
    }),
    previewCrewProposal: createEnvironmentCommand(runtime, {
      label: "j5:preview-crew-proposal",
      execute: (input: CrewProposalPreviewRequest) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.previewCrewProposal(prepared, input)),
        ),
    }),
    resolveCrewProposal: createEnvironmentCommand(runtime, {
      label: "j5:resolve-crew-proposal",
      execute: (input: CrewProposalResolveRequest) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.resolveCrewProposal(prepared, input)),
        ),
    }),
    archiveCrew: createEnvironmentCommand(runtime, {
      label: "j5:archive-crew",
      execute: (input: CrewArchiveRequest) =>
        preparedConnection.pipe(Effect.flatMap((prepared) => J5Http.archiveCrew(prepared, input))),
    }),
    stopCrew: createEnvironmentCommand(runtime, {
      label: "j5:stop-crew",
      execute: (input: CrewStopRequest) =>
        preparedConnection.pipe(Effect.flatMap((prepared) => J5Http.stopCrew(prepared, input))),
    }),
    createSquadron: createEnvironmentCommand(runtime, {
      label: "j5:create-squadron",
      execute: (input: { readonly name: string; readonly projectId: ProjectId }) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.createSquadron(prepared, input)),
        ),
    }),
    renameSquadron: createEnvironmentCommand(runtime, {
      label: "j5:rename-squadron",
      execute: (input: { readonly squadronId: string; readonly name: string }) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.renameSquadron(prepared, input)),
        ),
    }),
    deleteSquadron: createEnvironmentCommand(runtime, {
      label: "j5:delete-squadron",
      execute: (input: { readonly squadronId: string; readonly force?: boolean }) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.deleteSquadron(prepared, input)),
        ),
    }),
    assignImportedThreads: createEnvironmentCommand(runtime, {
      label: "j5:assign-imported-threads",
      execute: (input: AssignImportedThreadsRequest) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.assignImportedThreads(prepared, input)),
        ),
    }),
    answerHumanExchange: createEnvironmentCommand(runtime, {
      label: "j5:answer-exchange",
      execute: (input: AnswerHumanExchangeRequest) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.answerHumanExchange(prepared, input)),
        ),
    }),
  };
}
