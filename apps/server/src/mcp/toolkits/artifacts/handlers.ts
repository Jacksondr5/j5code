import * as Effect from "effect/Effect";

import { ArtifactMcpService } from "../../ArtifactMcpService.ts";
import { McpInvocationContext, requireThreadScope } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ArtifactToolkit } from "./tools.ts";

/** Artifacts belong to the calling thread's project, so every tool here needs a thread caller. */
const callerScope = McpInvocationContext.pipe(
  Effect.flatMap((scope) => requireThreadScope(scope, "An artifact tool")),
);

const handlers = {
  j5_list_artifacts: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const service = yield* ArtifactMcpService;
      return yield* service.list(scope);
    }),
  ),
  j5_read_artifact: McpToolAccess.readsAsCaller(({ path }) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const service = yield* ArtifactMcpService;
      return yield* service.read(scope, path);
    }),
  ),
  j5_write_artifact: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* callerScope;
      const service = yield* ArtifactMcpService;
      return yield* service.write(scope, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ArtifactToolkit.tools>;

export const layer = McpToolAccess.toLayer(ArtifactToolkit, handlers);
