import { assert, describe, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ArtifactWorkspace } from "../j5/artifacts/ArtifactWorkspace.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ArtifactMcpService, layer } from "./ArtifactMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const projectId = ProjectId.make("project:artifact-mcp");
const threadId = ThreadId.make("thread:artifact-mcp");
const scope = (capabilities: McpInvocationScope["capabilities"]): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:artifact-mcp"),
  threadId,
  providerSessionId: "provider-session:artifact-mcp",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

describe("ArtifactMcpService", () => {
  it.effect("shares project artifacts with every thread-scoped provider", () => {
    const list = vi.fn(() =>
      Effect.succeed([{ path: "plan.md", byteLength: 7, modifiedAt: null }]),
    );
    const read = vi.fn(
      ({ relativePath }: { readonly projectId: ProjectId; readonly relativePath: string }) =>
        Effect.succeed({
          path: relativePath,
          byteLength: 7,
          encoding: "utf8" as const,
          content: "# Plan\n",
        }),
    );
    const write = vi.fn(
      (input: {
        readonly projectId: ProjectId;
        readonly relativePath: string;
        readonly content: string;
      }) => Effect.succeed({ path: input.relativePath, byteLength: 13, modifiedAt: null }),
    );
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadManagementService)({
        getThreadProjection: () =>
          Effect.succeed({
            thread: { projectId, deletedAt: null },
          } as OrchestrationV2ThreadProjection),
      }),
      Layer.mock(ArtifactWorkspace)({ list, read, write }),
    );

    return Effect.gen(function* () {
      const service = yield* ArtifactMcpService;
      const invocation = scope(new Set(["artifacts"]));

      assert.deepStrictEqual(yield* service.list(invocation), {
        entries: [{ path: "plan.md", byteLength: 7, modifiedAt: null }],
      });
      assert.equal((yield* service.read(invocation, "plan.md")).content, "# Plan\n");
      assert.deepStrictEqual(
        yield* service.write(invocation, { path: "diagrams/flow.svg", content: "<svg></svg>" }),
        {
          artifact: { path: "diagrams/flow.svg", byteLength: 13, modifiedAt: null },
          logicalPath: "artifacts/diagrams/flow.svg",
        },
      );

      assert.deepStrictEqual(list.mock.calls, [[projectId]]);
      assert.deepStrictEqual(read.mock.calls, [[{ projectId, relativePath: "plan.md" }]]);
      assert.deepStrictEqual(write.mock.calls, [
        [{ projectId, relativePath: "diagrams/flow.svg", content: "<svg></svg>" }],
      ]);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(dependencies))));
  });

  it.effect("rejects credentials without artifact access", () => {
    const getThreadProjection = vi.fn(() => Effect.die("should not load"));
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadManagementService)({ getThreadProjection }),
      Layer.mock(ArtifactWorkspace)({}),
    );

    return Effect.gen(function* () {
      const service = yield* ArtifactMcpService;
      const error = yield* service.list(scope(new Set(["orchestration"]))).pipe(Effect.flip);
      assert.equal(error.code, "capability_denied");
      assert.equal(getThreadProjection.mock.calls.length, 0);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(dependencies))));
  });
});
