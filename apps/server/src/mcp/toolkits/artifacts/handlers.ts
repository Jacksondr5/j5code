import * as Effect from "effect/Effect";

import { ArtifactMcpService } from "../../ArtifactMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ArtifactToolkit } from "./tools.ts";

const handlers = {
  list_artifacts: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ArtifactMcpService;
      return yield* service.list(scope);
    }),
  read_artifact: ({ path }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ArtifactMcpService;
      return yield* service.read(scope, path);
    }),
  write_artifact: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ArtifactMcpService;
      return yield* service.write(scope, input);
    }),
} satisfies Parameters<typeof ArtifactToolkit.toLayer>[0];

export const ArtifactToolkitHandlersLive = ArtifactToolkit.toLayer(handlers);
