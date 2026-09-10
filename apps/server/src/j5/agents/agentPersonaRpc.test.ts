import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  J5_AGENT_PERSONA_WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";

describe("agent persona RPC scopes", () => {
  it("requires operate access to import, edit, toggle, or remove persona definitions", () => {
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.editImportedAgentPersona)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.removeAgentPersona)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.restoreSourceAgentPersona)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.removeSourceAgentPersona)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(
      requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.setImportedAgentPersonaEnabled),
    ).toBe(AuthOrchestrationOperateScope);
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.getAgentPersonaCatalog)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.importAgentPersonas)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(J5_AGENT_PERSONA_WS_METHODS.removeImportedAgentPersona)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
});
