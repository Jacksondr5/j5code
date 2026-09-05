import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { layer, ScheduledTaskService } from "./ScheduledTaskService.ts";

const projectId = ProjectId.make("project:scheduled-task-visible-error");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

it.effect(
  "persists an unbound scheduled-new-thread Squadron refusal as a visible task error",
  () => {
    const threadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
      sendToThread: () => Effect.die("bound task dispatch is unused by this measurement"),
    });
    const scheduledTasks = layer.pipe(
      Layer.provideMerge(threadManagement),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const service = yield* ScheduledTaskService;
      for (const [label, storedCreation] of [
        ["user-default", {}],
        ["mcp-agent", { createdBy: "agent" as const, creationSource: "mcp" as const }],
      ] as const) {
        const { task } = yield* service.upsert({
          commandId: CommandId.make(`command:scheduled-task:${label}`),
          title: `Scheduled ${label}`,
          prompt: "Run this scheduled task.",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId,
          threadId: null,
          workspaceStrategy: { type: "root" },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          ...storedCreation,
        });
        const result = yield* service.runNow({ id: task.id });
        const expected = label === "user-default" ? ["user", "web"] : ["agent", "mcp"];
        assert.deepStrictEqual([result.task.createdBy, result.task.creationSource], expected);
        assert.equal(result.task.lastRunStatus, "failed");
        assert.match(
          result.task.lastRunError ?? "",
          /Scheduled new-thread execution is unsupported/i,
        );
      }
    }).pipe(Effect.provide(scheduledTasks));
  },
);
