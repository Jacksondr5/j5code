import { Tool, Toolkit } from "effect/unstable/ai";
import * as Schema from "effect/Schema";

import {
  OrchestrationV2RunStatus,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ArchiveAgentService } from "../ArchiveAgentService.ts";
import {
  A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION,
  A2A_LIST_TOOL_DESCRIPTION,
  A2A_SEND_TOOL_DESCRIPTION,
} from "../EnvelopeFormatter.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import { SquadronJoinService } from "../SquadronJoinService.ts";
import { SquadronProjectReferences } from "../SquadronProjectReferences.ts";
import {
  AgentParticipant,
  ClearOwnAskResult,
  ExchangeId,
  HumanParticipant,
  ParticipantId,
  SendMessageResult,
  SquadronId,
  Urgency,
} from "../contracts.ts";
import {
  ForkedFromParticipantProvenance,
  SpawnedByParticipantProvenance,
  UnknownParticipantProvenance,
} from "../placementContracts.ts";

export const J5McpFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type J5McpFailure = typeof J5McpFailure.Type;

export const J5SendMessageInput = Schema.Struct({
  to: ParticipantId,
  message: Schema.String.check(Schema.isNonEmpty()),
  client_request_id: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isNonEmpty()))),
  expect_reply: Schema.optional(Schema.NullOr(Schema.Boolean)),
  exchange_id: Schema.optional(Schema.NullOr(ExchangeId)),
  intent: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isNonEmpty()))),
  urgency: Schema.optional(Schema.NullOr(Urgency)),
});
export type J5SendMessageInput = typeof J5SendMessageInput.Type;

export const J5ClearOwnAskInput = Schema.Struct({
  exchange_id: ExchangeId,
  client_request_id: Schema.String.check(Schema.isNonEmpty()),
});
export type J5ClearOwnAskInput = typeof J5ClearOwnAskInput.Type;

const J5AgentParticipant = Schema.Struct({
  kind: AgentParticipant.fields.kind,
  id: AgentParticipant.fields.id,
  thread_id: AgentParticipant.fields.threadId,
});

const J5Participant = Schema.Union([J5AgentParticipant, HumanParticipant]);

export const J5ParticipantProvenanceView = Schema.Union([
  Schema.Struct({
    kind: SpawnedByParticipantProvenance.fields.kind,
    spawned_by_participant_id: SpawnedByParticipantProvenance.fields.spawnedByParticipantId,
    source: SpawnedByParticipantProvenance.fields.source,
  }),
  Schema.Struct({
    kind: ForkedFromParticipantProvenance.fields.kind,
    source_participant_id: ForkedFromParticipantProvenance.fields.sourceParticipantId,
    source: ForkedFromParticipantProvenance.fields.source,
  }),
  UnknownParticipantProvenance,
  Schema.Struct({ kind: Schema.Literal("unrecorded") }),
  Schema.Struct({ kind: Schema.Literal("not-applicable") }),
]);
export type J5ParticipantProvenanceView = typeof J5ParticipantProvenanceView.Type;

export const J5ParticipantDirectoryRow = Schema.Struct({
  squadron_id: SquadronId,
  participant_id: ParticipantId,
  participant: J5Participant,
  self: Schema.Boolean,
  archived: Schema.Boolean,
  can_receive_message: Schema.Boolean,
  can_open_exchange: Schema.Boolean,
  accepts_urgency: Schema.Boolean,
  thread_id: Schema.NullOr(ThreadId),
  provenance: J5ParticipantProvenanceView,
  placement_parent_id: Schema.NullOr(ParticipantId),
  display_name: Schema.NullOr(Schema.String),
});
export type J5ParticipantDirectoryRow = typeof J5ParticipantDirectoryRow.Type;

export const J5ListParticipantsResult = Schema.Struct({
  participants: Schema.Array(J5ParticipantDirectoryRow),
});

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());

export const J5SpawnAgentInput = Schema.Struct({
  brief: NonEmptyString,
  title: Schema.optional(NonEmptyString),
  provider: ProviderInstanceId,
  model: NonEmptyString,
  reasoning: NonEmptyString,
  client_request_id: Schema.optional(NonEmptyString),
});
export type J5SpawnAgentInput = typeof J5SpawnAgentInput.Type;

export const J5SpawnAgentResult = Schema.Struct({
  participant_id: ParticipantId,
  thread_id: ThreadId,
  squadron_id: SquadronId,
  placement: Schema.Struct({
    placement_parent_id: ParticipantId,
    provenance: Schema.Struct({
      kind: Schema.Literal("spawned-by"),
      spawned_by_participant_id: ParticipantId,
      source: Schema.Literal("j5_spawn"),
    }),
  }),
});

export const J5StopAgentInput = Schema.Struct({
  client_request_id: Schema.optional(NonEmptyString),
  squadron_id: SquadronId,
  participant_id: ParticipantId,
});
export type J5StopAgentInput = typeof J5StopAgentInput.Type;

export const J5StopAgentResult = Schema.Literals(["interrupt_requested", "already_idle"]);

export const J5ArchiveAgentInput = Schema.Struct({
  client_request_id: Schema.optional(NonEmptyString),
  squadron_id: SquadronId,
  participant_id: ParticipantId,
  confirmation_token: Schema.optional(NonEmptyString),
});
export type J5ArchiveAgentInput = typeof J5ArchiveAgentInput.Type;

export const J5ArchiveAgentResult = Schema.Literals(["archived", "already_archived"]);

export const J5ArchiveAgentOpenExchangeFact = Schema.Struct({
  exchange_id: ExchangeId,
  direction: Schema.Literals(["inbound", "outbound"]),
  reply_obligation: Schema.Literals(["participant-owes-reply", "counterparty-owes-reply"]),
  counterparty_id: ParticipantId,
  intent: Schema.String,
  urgency: Schema.NullOr(Urgency),
  opened_at: Schema.String,
});

export const J5ArchiveAgentRunningTurnFact = Schema.Struct({
  run_id: RunId,
  status: OrchestrationV2RunStatus,
});

export const J5ArchiveAgentFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  open_exchanges: Schema.optional(Schema.Array(J5ArchiveAgentOpenExchangeFact)),
  running_turn: Schema.optional(Schema.NullOr(J5ArchiveAgentRunningTurnFact)),
  confirmation_token: Schema.optional(Schema.NullOr(Schema.String)),
  interrupt_requested: Schema.optional(Schema.Boolean),
  thread_archive_committed: Schema.optional(Schema.Boolean),
  participant_retired: Schema.optional(Schema.Boolean),
  participant_archived: Schema.optional(Schema.Boolean),
  pending_exchange_ids: Schema.optional(Schema.Array(ExchangeId)),
});
export type J5ArchiveAgentFailure = typeof J5ArchiveAgentFailure.Type;

export const J5JoinSquadronInput = Schema.Struct({
  squadron_id: SquadronId,
  client_request_id: Schema.optional(NonEmptyString),
});
export type J5JoinSquadronInput = typeof J5JoinSquadronInput.Type;

export const J5JoinSquadronResult = Schema.Struct({
  squadron_id: SquadronId,
  participant_id: ParticipantId,
  thread_id: ThreadId,
  placement: Schema.Struct({
    placement_parent_id: Schema.NullOr(ParticipantId),
    provenance: J5ParticipantProvenanceView,
  }),
});
export type J5JoinSquadronResult = typeof J5JoinSquadronResult.Type;

export const J5SquadronDirectoryRow = Schema.Struct({
  squadron_id: SquadronId,
  name: Schema.String,
  project_ids: Schema.Array(ProjectId),
});

export const J5ListSquadronsResult = Schema.Struct({
  caller_project_id: Schema.NullOr(ProjectId),
  squadrons: Schema.Array(J5SquadronDirectoryRow),
});
export type J5ListSquadronsResult = typeof J5ListSquadronsResult.Type;

export const J5_JOIN_SQUADRON_DESCRIPTION =
  "Join a Squadron when your thread has no Squadron home yet. Pass the exact squadron_id, taken from list_squadrons; that Squadron must reference your thread's project. Your thread, conversation, worktree, and running work stay exactly as they are. Calling it again for the Squadron you already belong to returns your existing registration. Reuse client_request_id to retry safely. Warning: you cannot switch Squadrons once you're assigned, be sure you're joining the right one.";

export const J5_LIST_SQUADRONS_DESCRIPTION =
  "The Squadron directory for this environment: every Squadron's squadron_id, name, and the project ids it references, plus your own thread's project id so you can see which Squadron can home you. Use it to obtain the exact squadron_id before join_squadron. Read-only.";

export const J5_SPAWN_AGENT_DESCRIPTION =
  "Spawn a Peer Agent: a full-citizen teammate with its own top-level thread, starting on your brief as its first turn. It joins your Squadron, is placed under you, and records you as its immutable spawner; it is addressable the moment this returns. In your brief, tell the new agent what it should do first and whether it should reply to you. Choose provider, model, and reasoning for the work in the brief — see orchestrator_capabilities for what's available. Reuse client_request_id to retry the same spawn safely.";

export const J5_STOP_AGENT_DESCRIPTION =
  "Stop one Peer Agent: interrupts its running turn now. The agent remains, stays readable, and can be messaged again later — stopping halts work, it retires nothing. Requires your current squadron_id. Reuse client_request_id to retry safely.";

export const J5_ARCHIVE_AGENT_DESCRIPTION =
  "Archive one Peer Agent reversibly. Unarchive restores the same identity, but does not reopen Exchanges or replay cancelled messages. A clean archive — no open exchanges, no running turn — completes immediately. Otherwise the call refuses and lists exactly what archiving ends — the asks that will close, the turn that will stop — along with a confirmation_token; call again with that token to proceed. The archived agent leaves the active roster; its ledger and conversation stay readable forever. Requires your current squadron_id. Reuse client_request_id to retry safely.";

const sendDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  A2AHomeRegistrar,
  A2ADeliveryWorker,
  Crypto.Crypto,
  OrchestratorV2,
];

const placementDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  ParticipantPlacementService,
  OrchestratorV2,
];

const spawnDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  Crypto.Crypto,
  A2AHomeRegistrar,
  A2ALedger,
  SpawnCompositionService,
  ThreadManagementService,
  OrchestratorMcpService,
];

const joinDependencies = [
  McpInvocationContext.McpInvocationContext,
  Crypto.Crypto,
  SquadronJoinService,
  ThreadManagementService,
];

const listSquadronsDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ALedger,
  SquadronProjectReferences,
  ThreadManagementService,
];

const stopDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  Crypto.Crypto,
  ParticipantPlacementService,
  ThreadManagementService,
];

const archiveDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  Crypto.Crypto,
  A2ALedger,
  ParticipantPlacementService,
  ArchiveAgentService,
];

export const J5SendMessageTool = Tool.make("send_message", {
  description: A2A_SEND_TOOL_DESCRIPTION,
  parameters: J5SendMessageInput,
  success: SendMessageResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: sendDependencies,
})
  .annotate(Tool.Title, "Send a cross-agent message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5ListParticipantsTool = Tool.make("list_participants", {
  description: A2A_LIST_TOOL_DESCRIPTION,
  parameters: Schema.Struct({ include_archived: Schema.optional(Schema.Boolean) }),
  success: J5ListParticipantsResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: placementDependencies,
})
  .annotate(Tool.Title, "List cross-agent messaging participants")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const J5SpawnAgentTool = Tool.make("spawn_agent", {
  description: J5_SPAWN_AGENT_DESCRIPTION,
  parameters: J5SpawnAgentInput,
  success: J5SpawnAgentResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: spawnDependencies,
})
  .annotate(Tool.Title, "Spawn a Peer Agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5JoinSquadronTool = Tool.make("join_squadron", {
  description: J5_JOIN_SQUADRON_DESCRIPTION,
  parameters: J5JoinSquadronInput,
  success: J5JoinSquadronResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: joinDependencies,
})
  .annotate(Tool.Title, "Join a Squadron")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const J5ListSquadronsTool = Tool.make("list_squadrons", {
  description: J5_LIST_SQUADRONS_DESCRIPTION,
  success: J5ListSquadronsResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: listSquadronsDependencies,
})
  .annotate(Tool.Title, "List Squadrons")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const J5StopAgentTool = Tool.make("stop_agent", {
  description: J5_STOP_AGENT_DESCRIPTION,
  parameters: J5StopAgentInput,
  success: J5StopAgentResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: stopDependencies,
})
  .annotate(Tool.Title, "Stop one Peer Agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const J5ArchiveAgentTool = Tool.make("archive_agent", {
  description: J5_ARCHIVE_AGENT_DESCRIPTION,
  parameters: J5ArchiveAgentInput,
  success: J5ArchiveAgentResult,
  failure: J5ArchiveAgentFailure,
  failureMode: "return",
  dependencies: archiveDependencies,
})
  .annotate(Tool.Title, "Archive one Peer Agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const J5ClearOwnAskTool = Tool.make("clear_own_ask", {
  description: A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION,
  parameters: J5ClearOwnAskInput,
  success: ClearOwnAskResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, A2ASendService],
})
  .annotate(Tool.Title, "Withdraw your open ask")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Shared J5 toolkit bootstrap. Later J5 milestones append their tools here. */
export const J5Toolkit = Toolkit.make(
  J5SendMessageTool,
  J5ListParticipantsTool,
  J5ListSquadronsTool,
  J5JoinSquadronTool,
  J5SpawnAgentTool,
  J5StopAgentTool,
  J5ArchiveAgentTool,
  J5ClearOwnAskTool,
);
