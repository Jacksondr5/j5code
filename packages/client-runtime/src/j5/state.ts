import type { ProjectId } from "@t3tools/contracts";
import type { AnswerHumanExchangeRequest } from "@t3tools/contracts/j5";
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
