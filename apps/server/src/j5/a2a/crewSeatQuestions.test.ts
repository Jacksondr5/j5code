import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  buildCodexTurnStartParams,
  codexThreadRuntimeParams,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import { CREW_SEAT_QUESTION_INSTRUCTIONS, J5_CODEX_CREW_SEAT_CONFIG } from "./crewSeatQuestions.ts";
import { withCrewSeatQuestions } from "./crewSeatRuntime.ts";

const basePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const seatPolicy = withCrewSeatQuestions(basePolicy);

describe("Crew seat question tools on Codex", () => {
  it("turns request_user_input off in a seat's thread config and nowhere else", () => {
    const threadId = ThreadId.make("thread-codex-crew-seat");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-codex-crew-seat"),
      threadId,
      providerSessionId: "mcp-session-codex-crew-seat",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      browserToolsAvailable: true,
    });
    try {
      const seat = codexThreadRuntimeParams({ threadId, runtimePolicy: seatPolicy }).config;
      assert.strictEqual(seat?.["features.default_mode_request_user_input"], false);
      assert.strictEqual(seat?.["tools.experimental_request_user_input.enabled"], false);
      assert.property(seat, "mcp_servers");

      const captain = codexThreadRuntimeParams({ threadId, runtimePolicy: basePolicy }).config;
      for (const key of Object.keys(J5_CODEX_CREW_SEAT_CONFIG)) assert.notProperty(captain, key);
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it.effect("puts the ask-your-Captain rule after Codex's ask-the-user text", () =>
    Effect.gen(function* () {
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-crew-seat",
        codexInput: [{ type: "text", text: "review the change" }],
        runtimePolicy: seatPolicy,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
        hasT3Mcp: true,
      });
      const developer = params.collaborationMode?.settings.developer_instructions ?? "";
      const askUser = developer.indexOf("ask the user directly");
      assert.isAtLeast(askUser, 0);
      assert.isAbove(developer.indexOf(CREW_SEAT_QUESTION_INSTRUCTIONS), askUser);
    }),
  );
});
