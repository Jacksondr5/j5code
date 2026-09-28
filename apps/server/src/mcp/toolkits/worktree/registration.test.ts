import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DeviceService } from "../../../device/DeviceService.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ServerConfig from "../../../config.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { ProviderAdapterRegistryV2 } from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { A2ASendService } from "../../../j5/a2a/SendService.ts";
import { ParticipantPlacementService } from "../../../j5/a2a/PlacementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const StubServicesLive = Layer.mergeAll(
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(ProjectionStoreV2)({}),
  Layer.mock(ProjectionSnapshotQuery)({}),
  Layer.mock(DeviceService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(OrchestratorV2)({
    getShellSnapshot: () =>
      Effect.succeed({
        schemaVersion: 1,
        snapshotSequence: 0,
        projects: [],
        threads: [],
        archivedThreads: [],
      }),
  }),
  Layer.mock(A2ASendService)({ listParticipants: () => Effect.succeed([]) }),
  Layer.mock(ParticipantPlacementService)({ listParticipants: () => Effect.succeed([]) }),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
              openWorldHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const decodeRpcFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ error: Schema.Struct({ code: Schema.Number, message: Schema.String }) }),
);

const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);
const decodeToolCallPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        isError: Schema.optional(Schema.Boolean),
        content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
      }),
    }),
  ),
);

it.effect("production mcp layer lists worktree tools over http", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const routes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      yield* HttpRouter.serve(routes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed("environment-scratch" as never),
          }),
        ),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(StubServicesLive),
        Layer.build,
      );

      const registry = McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-scratch"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const credential = yield* registry;
      expect(credential).toBeDefined();

      const httpClient = yield* HttpClient.HttpClient;
      const unauthorizedResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"unauthorized","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(unauthorizedResponse.status).toBe(401);
      const foreignRegistry = yield* McpSessionRegistry.__testing.make({ now: () => 1 }).pipe(
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-other")),
          getDescriptor: Effect.die("unused foreign environment descriptor"),
        }),
      );
      const foreignCredential = yield* foreignRegistry.issue({
        threadId: ThreadId.make("thread-scratch"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const wrongEnvironmentResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: foreignCredential.config.authorizationHeader,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"list_participants","arguments":{}}}`,
          "application/json",
        ),
      });
      expect(wrongEnvironmentResponse.status).toBe(401);

      const auth = credential!.config.authorizationHeader;
      const initResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: auth,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers["mcp-session-id"];

      const listResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: auth,
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      const bodyText = yield* listResponse.text;
      const payload = yield* decodeToolsListPayload(bodyText.match(/\{.*\}/s)![0]);
      const tools = payload.result.tools;
      const toolNames = tools.map((tool) => tool.name);
      expect(toolNames).toContain("t3_worktree_handoff");
      expect(toolNames).toContain("t3_worktree_status");
      // The worktree registration merges alongside the other toolkits rather
      // than replacing them.
      expect(toolNames).toContain("preview_status");
      expect(toolNames).toContain("orchestrator_capabilities");
      expect(toolNames).toContain("schedule_task");
      expect(toolNames).toContain("t3_thread_list");
      expect(toolNames).toContain("t3_thread_read");
      // Blocking on another thread starves a participant of the notices it waits for.
      expect(toolNames).not.toContain("t3_thread_wait");
      // J5 re-declares delegate_task with a saved-agent parameter and keeps its status/cancel pair.
      expect(toolNames).toContain("delegate_task");
      expect(toolNames).toContain("task_status");
      expect(toolNames).toContain("task_cancel");
      for (const excluded of [
        "t3_thread_launch",
        "t3_project_create",
        "t3_project_update",
        "t3_project_delete",
        "t3_environment_preferences_update",
        "t3_queue_edit",
        "t3_queue_cancel",
        "t3_queue_reorder",
        "t3_queue_promote_to_steer",
        "create_threads",
        "t3_thread_start",
        "t3_thread_send",
        "t3_thread_interrupt",
      ]) {
        expect(toolNames).not.toContain(excluded);
      }
      // J5 uses the same authenticated transport and one shared registration
      // that later J5 milestones extend inside the fork-owned toolkit.
      expect(toolNames).toContain("send_message");
      expect(toolNames).toContain("list_participants");
      expect(toolNames.toSorted()).toEqual([
        "archive_crew",
        "clear_own_ask",
        "delegate_task",
        "delete_scheduled_task",
        "device_close",
        "device_list",
        "device_open",
        "device_screenshot",
        "join_squadron",
        "link_pull_request",
        "list_artifacts",
        "list_participants",
        "list_personas",
        "list_scheduled_tasks",
        "list_squadrons",
        "list_thread_pull_requests",
        "orchestrator_capabilities",
        "playbook_back",
        "playbook_cancel",
        "playbook_complete",
        "playbook_current",
        "playbook_list",
        "playbook_next",
        "playbook_reselect",
        "playbook_start",
        "preview_click",
        "preview_evaluate",
        "preview_navigate",
        "preview_open",
        "preview_press",
        "preview_recording_start",
        "preview_recording_stop",
        "preview_resize",
        "preview_scroll",
        "preview_set_appearance",
        "preview_snapshot",
        "preview_status",
        "preview_type",
        "preview_wait_for",
        "propose_crew",
        "read_artifact",
        "request_crew_member",
        "run_scheduled_task_now",
        "schedule_task",
        "send_message",
        "spawn_agent",
        "stop_agent",
        "stop_crew",
        "t3_attachment_discard",
        "t3_attachment_prepare_upload",
        "t3_environment_read",
        "t3_pending_request_list",
        "t3_pending_request_read",
        "t3_pending_request_respond",
        "t3_preview_close",
        "t3_preview_list",
        "t3_project_clone",
        "t3_project_list",
        "t3_project_read",
        "t3_queue_list",
        "t3_queue_read",
        "t3_thread_configuration",
        "t3_thread_configure",
        "t3_thread_fork",
        "t3_thread_list",
        "t3_thread_merge_back",
        "t3_thread_organize",
        "t3_thread_read",
        "t3_thread_search",
        "t3_thread_send_attachments",
        "t3_thread_transfers",
        "t3_thread_update",
        "t3_worktree_handoff",
        "t3_worktree_list",
        "t3_worktree_status",
        "task_cancel",
        "task_status",
        "unlink_pull_request",
        "update_scheduled_task",
        "write_artifact",
      ]);

      const restricted = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-without-browser"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        browserToolsAvailable: false,
      });
      expect(restricted).toBeDefined();
      const restrictedInit = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: restricted!.config.authorizationHeader,
        },
        body: HttpBody.text(
          encodeJson({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "restricted", version: "1" },
            },
          }),
          "application/json",
        ),
      });
      expect(restrictedInit.status).toBe(200);
      const restrictedSessionId = restrictedInit.headers["mcp-session-id"];
      const callRestricted = Effect.fn(function* (id: number, name: string) {
        const response = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: restricted!.config.authorizationHeader,
            "mcp-protocol-version": "2025-06-18",
            ...(restrictedSessionId ? { "mcp-session-id": restrictedSessionId } : {}),
          },
          body: HttpBody.text(
            encodeJson({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: {} },
            }),
            "application/json",
          ),
        });
        expect(response.status).toBe(200);
        const text = yield* response.text;
        return yield* decodeToolCallPayload(text.match(/\{.*\}/s)![0]);
      });
      for (const [index, name] of [
        "t3_thread_launch",
        "t3_project_create",
        "t3_project_update",
        "t3_project_delete",
        "t3_environment_preferences_update",
        "t3_queue_edit",
        "t3_queue_cancel",
        "t3_queue_reorder",
        "t3_queue_promote_to_steer",
      ].entries()) {
        const response = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: restricted!.config.authorizationHeader,
            "mcp-protocol-version": "2025-06-18",
            ...(restrictedSessionId ? { "mcp-session-id": restrictedSessionId } : {}),
          },
          body: HttpBody.text(
            encodeJson({
              jsonrpc: "2.0",
              id: 100 + index,
              method: "tools/call",
              params: { name, arguments: {} },
            }),
            "application/json",
          ),
        });
        const responseText = yield* response.text;
        const refused = yield* decodeRpcFailure(decodeJson(responseText.match(/\{.*\}/s)![0]));
        expect(refused.error.code).toBe(-32602);
        expect(refused.error.message).toContain(name);
      }
      const deniedPreview = yield* callRestricted(3, "preview_status");
      expect(deniedPreview.result.isError).toBe(true);
      expect(deniedPreview.result.content[0]?.text).toContain("preview");
      const allowedDirectory = yield* callRestricted(4, "list_participants");
      expect(allowedDirectory.result.isError).not.toBe(true);
      expect(decodeJson(allowedDirectory.result.content[0]!.text)).toEqual({ participants: [] });

      // The handoff tool mutates thread state, reaches the network (origin
      // fetch), and runs project setup scripts, so its MCP hints must not
      // promise a read-only, closed-world, non-destructive tool.
      const handoff = tools.find((tool) => tool.name === "t3_worktree_handoff");
      expect(handoff?.annotations?.readOnlyHint).toBe(false);
      expect(handoff?.annotations?.destructiveHint).toBe(true);
      expect(handoff?.annotations?.openWorldHint).toBe(true);
      const status = tools.find((tool) => tool.name === "t3_worktree_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);
      expect(status?.annotations?.destructiveHint).toBe(false);

      // MCP requires every tool input schema to be a top-level object schema.
      // A non-object schema (e.g. the anyOf produced by an empty
      // Schema.Struct({})) makes clients reject the entire server.
      for (const tool of tools) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "j5-mcp-registration-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  ),
);
