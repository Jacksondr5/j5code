import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2AgentPersonaAssignment,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { describeCrewSeatRuntime } from "./crewRuntimePreview.ts";

const instanceId = ProviderInstanceId.make("codex");
const selection = { instanceId, model: "gpt-5.6-sol" };
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-05T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: [],
} satisfies ServerProvider;
const persona = (
  authorityPolicy: OrchestrationV2AgentPersonaAssignment["authorityPolicy"],
  runtimeModeOverride?: OrchestrationV2AgentPersonaAssignment["runtimeModeOverride"],
): OrchestrationV2AgentPersonaAssignment => ({
  personaId: "builder",
  definitionVersion: 1,
  authorityPolicy,
  ...(runtimeModeOverride === undefined ? {} : { runtimeModeOverride }),
  resolvedRoute: "primary",
  resolvedDriver: ProviderDriverKind.make("codex"),
  resolvedModelSelection: selection,
});
const access = (
  ...args: Parameters<typeof describeCrewSeatRuntime> extends [
    unknown,
    unknown,
    unknown,
    ...infer Rest,
  ]
    ? Rest
    : never
) => describeCrewSeatRuntime("seat", selection, provider, ...args).access;

it("labels persona seats by their policy and everything else by its explicit mode", () => {
  // A persona running its own policy.
  assert.equal(access("approval-required", persona("read-only")), "Read only");
  assert.equal(access("auto-accept-edits", persona("workspace-write")), "Repository write");
  assert.equal(access("full-access", persona("full-access")), "Full access");
  // An explicit override or a custom seat is labelled by the mode it will run.
  assert.equal(
    access("approval-required", persona("full-access", "approval-required")),
    "Supervised",
  );
  assert.equal(access("full-access", null), "Full access");
  assert.equal(access("auto-accept-edits", null), "Auto-accept edits");
});
