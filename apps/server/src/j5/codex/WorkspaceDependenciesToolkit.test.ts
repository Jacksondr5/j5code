import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { vi } from "vite-plus/test";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { loadWorkspaceDependencies, WorkspaceDependenciesError } from "./WorkspaceDependencies.ts";
import { WorkspaceDependenciesRegistrationLive } from "./WorkspaceDependenciesToolkit.ts";

vi.mock("./WorkspaceDependencies.ts", async (original) => ({
  ...(await original<typeof import("./WorkspaceDependencies.ts")>()),
  loadWorkspaceDependencies: vi.fn(),
}));
const invocation = {
  environmentId: EnvironmentId.make("test-environment"),
  threadId: ThreadId.make("test-thread"),
  providerSessionId: "test-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["artifacts"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = WorkspaceDependenciesRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(NodeServices.layer),
);
const call = (scope = invocation) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools[0]?.tool.inputSchema).toMatchObject({ type: "object" });
    return yield* server
      .callTool({ name: "load_workspace_dependencies", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  }).pipe(Effect.provide(TestLayer));

it.effect("returns runtime paths through the registered MCP tool", () =>
  Effect.gen(function* () {
    const paths = {
      RUNTIME_NODE: "/runtime/node",
      RUNTIME_NODE_MODULES: "/runtime/modules",
      RUNTIME_BIN_DIR: "/runtime/bin",
      RUNTIME_PYTHON: "/runtime/python",
      bundleVersion: "test",
      artifactToolVersion: "test",
    };
    vi.mocked(loadWorkspaceDependencies).mockReturnValue(Effect.succeed(paths));
    const result = yield* call();
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(paths);
  }),
);
it.effect("reports missing installation as an MCP tool error", () =>
  Effect.gen(function* () {
    vi.mocked(loadWorkspaceDependencies).mockReturnValue(
      Effect.fail(new WorkspaceDependenciesError({ message: "missing runtime.json" })),
    );
    const result = yield* call();
    expect(result.isError).toBe(true);
    expect(
      result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
    ).toContain("missing runtime.json");
  }),
);
it.effect("denies credentials without artifact capability before filesystem access", () =>
  Effect.gen(function* () {
    vi.mocked(loadWorkspaceDependencies).mockClear();
    const result = yield* call({ ...invocation, capabilities: new Set() });
    expect(result.isError).toBe(true);
    expect(
      result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
    ).toContain("does not grant artifact capabilities");
    expect(loadWorkspaceDependencies).not.toHaveBeenCalled();
  }),
);
