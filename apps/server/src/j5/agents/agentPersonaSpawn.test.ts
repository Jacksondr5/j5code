import type { OrchestrationV2AgentPersonaAssignment, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveAgentPersonaPeerSpawnPolicy } from "./agentPersonaSpawn.ts";

const assignment = (
  authorityPolicy: OrchestrationV2AgentPersonaAssignment["authorityPolicy"],
): OrchestrationV2AgentPersonaAssignment => ({
  personaId: "builder",
  definitionVersion: 1,
  authorityPolicy,
  resolvedRoute: "primary",
  resolvedDriver: ProviderDriverKind.make("codex"),
  resolvedModelSelection: { instanceId: "codex" as ProviderInstanceId, model: "gpt-5.6-sol" },
});

// The library is consulted only for a persona parent; a plain parent decides on its runtime mode.
const noLibrary = {} as never;

it.effect("a plain thread with approvals on cannot spawn a write-capable saved agent", () =>
  Effect.gen(function* () {
    const refused = yield* resolveAgentPersonaPeerSpawnPolicy(
      { agentPersonaAssignment: undefined, runtimeMode: "approval-required" },
      assignment("workspace-write"),
      noLibrary,
    ).pipe(Effect.flip);
    assert.include(refused.message, "approvals on");

    const readOnlyChild = yield* resolveAgentPersonaPeerSpawnPolicy(
      { agentPersonaAssignment: undefined, runtimeMode: "approval-required" },
      assignment("read-only"),
      noLibrary,
    );
    assert.equal(readOnlyChild.sandboxPolicy.type, "readOnly");

    const fullAccessParent = yield* resolveAgentPersonaPeerSpawnPolicy(
      { agentPersonaAssignment: undefined, runtimeMode: "full-access" },
      assignment("workspace-write"),
      noLibrary,
    );
    assert.notEqual(fullAccessParent.sandboxPolicy.type, "readOnly");
  }),
);
