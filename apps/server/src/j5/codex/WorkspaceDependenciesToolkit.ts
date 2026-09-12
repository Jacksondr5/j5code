import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import {
  loadWorkspaceDependencies,
  WorkspaceDependencies,
  WorkspaceDependenciesError,
} from "./WorkspaceDependencies.ts";

export const WorkspaceDependenciesToolkit = Toolkit.make(
  Tool.make("load_workspace_dependencies", {
    description:
      "Get the installed OpenAI primary runtime paths on this J5 server for Presentations, Spreadsheets and Documents skills. Returns RUNTIME_NODE, RUNTIME_NODE_MODULES, RUNTIME_BIN_DIR and RUNTIME_PYTHON after validating the bundle. This J5 adapter only reads an existing installation; it does not download dependencies, change the shell environment, or provide artifact template tools. Use the returned executables and paths explicitly.",
    success: WorkspaceDependencies,
    failure: WorkspaceDependenciesError,
    dependencies: [McpInvocationContext, FileSystem.FileSystem, Path.Path],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);

const handlers = WorkspaceDependenciesToolkit.toLayer({
  load_workspace_dependencies: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      if (!scope.capabilities.has("artifacts")) {
        return yield* new WorkspaceDependenciesError({
          message: "This MCP credential does not grant artifact capabilities.",
        });
      }
      return yield* loadWorkspaceDependencies().pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceDependenciesError({
              message: `Installed OpenAI runtime unavailable: ${error.message}. Install or repair the primary runtime on this server host, or set J5CODE_PRIMARY_RUNTIME_DIR to its absolute bundle directory.`,
            }),
        ),
      );
    }),
});

export const WorkspaceDependenciesRegistrationLive = McpServer.toolkit(
  WorkspaceDependenciesToolkit,
).pipe(Layer.provide(handlers));
