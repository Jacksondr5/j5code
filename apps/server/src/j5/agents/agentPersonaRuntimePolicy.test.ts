import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  layerFromProjectRepository,
  RuntimePolicyV2,
} from "../../orchestration-v2/RuntimePolicy.ts";
import * as ProjectionProjects from "../../persistence/Services/ProjectionProjects.ts";

// Mirrors the fixtures in orchestration-v2/RuntimePolicy.test.ts (FORK.md).
const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const TestLayer = layerFromProjectRepository.pipe(
  Layer.provide(
    Layer.mock(ProjectionProjects.ProjectionProjectRepository)({
      getById: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(TestLayer)("legacy persona runtime policy", (it) => {
  for (const personaId of ["builder", "critic", "publisher"] as const) {
    it.effect(`rejects ${personaId} without a snapshot and requires a fresh task`, () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicyV2;
        const now = yield* DateTime.now;
        const thread = {
          ...makeThread({ now, worktreePath: "/project-worktree" }),
          agentPersonaAssignment: {
            personaId,
            definitionVersion: 1,
            authorityPolicy: "read-only" as const,
            resolvedRoute: "primary" as const,
            resolvedDriver: ProviderDriverKind.make("codex"),
            resolvedModelSelection: modelSelection,
          },
        };
        const error = yield* policy.resolve({ thread, modelSelection }).pipe(Effect.flip);
        assert.include(String(error.cause), "Start a fresh task");
      }),
    );
  }
});
