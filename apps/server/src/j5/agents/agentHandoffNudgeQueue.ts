import type { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

export interface AgentHandoffNudge {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly personaId: string;
  readonly artifact: string;
  readonly path: string;
}

/**
 * Hands "ask the agent for its missing handoff" from the run-finalization observer, which
 * runs inside the orchestration runtime, to a worker that can reach ThreadManagement. The
 * single layer instance is shared by reference between both providers.
 */
export class AgentHandoffNudgeQueue extends Context.Service<
  AgentHandoffNudgeQueue,
  Queue.Queue<AgentHandoffNudge>
>()("t3/j5/agents/agentHandoffNudgeQueue") {}

export const layer = Layer.effect(AgentHandoffNudgeQueue, Queue.unbounded<AgentHandoffNudge>());
