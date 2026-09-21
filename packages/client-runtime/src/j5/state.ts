import type { ProjectId } from "@t3tools/contracts";
import type {
  AnswerHumanExchangeRequest,
  CrewProposalResolveRequest,
  CrewArchiveRequest,
  CrewStopRequest,
  FleetReadRequest,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { createEnvironmentCommand, createEnvironmentQueryAtomFamily } from "../state/runtime.ts";
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

/** J5 uses the same environment registry, query lifecycle, and command dispatch as other features. */
export function createJ5EnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
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
    answerHumanExchange: createEnvironmentCommand(runtime, {
      label: "j5:answer-exchange",
      execute: (input: AnswerHumanExchangeRequest) =>
        preparedConnection.pipe(
          Effect.flatMap((prepared) => J5Http.answerHumanExchange(prepared, input)),
        ),
    }),
  };
}
