import { createAgentPersonaEnvironmentAtoms } from "@t3tools/client-runtime/j5/agent-persona-atoms";

import { connectionAtomRuntime } from "../../connection/runtime";

export const agentPersonaEnvironment = createAgentPersonaEnvironmentAtoms(connectionAtomRuntime);
