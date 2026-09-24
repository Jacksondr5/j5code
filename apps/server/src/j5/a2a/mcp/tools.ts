import { Tool, Toolkit } from "effect/unstable/ai";
import * as Schema from "effect/Schema";

import {
  AgentPersonaId,
  ModelSelection,
  OrchestrationV2RunStatus,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import { ArchiveCrewService } from "../ArchiveCrewService.ts";
import {
  CREW_NAME_MAX_CHARS,
  CREW_NAME_PATTERN,
  CREW_REASON_MAX_CHARS,
  CREW_SEAT_CAP,
  CREW_SEAT_NAME_PATTERN,
  CREW_TEXT_MAX_CHARS,
} from "../crewLimits.ts";
import { CrewProposalService } from "../CrewProposalService.ts";
import { CrewStopService } from "../CrewStopService.ts";
import {
  A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION,
  A2A_LIST_TOOL_DESCRIPTION,
  A2A_SEND_TOOL_DESCRIPTION,
} from "../EnvelopeFormatter.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { PeerDirectory } from "../PeerDirectory.ts";
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
  MachineParticipant,
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

const J5Participant = Schema.Union([J5AgentParticipant, HumanParticipant, MachineParticipant]);

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
  /** The Squadron's name beside its id; on the self row, the Squadron the caller belongs to. */
  squadron_name: Schema.NullOr(Schema.String),
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
  /** Peer servers whose address books could not be read: their agents are absent, not gone. No server is named. */
  unread_peer_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());

export const J5SpawnAgentInput = Schema.Struct({
  brief: NonEmptyString,
  title: Schema.optional(NonEmptyString),
  persona: Schema.optional(
    AgentPersonaId.annotate({
      description:
        "Persona id from list_personas. The spawn runs with that persona's instructions and runtime policy, and provider, model, and reasoning must be one of its declared routes.",
    }),
  ),
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

export const J5ListAgentsResult = Schema.Struct({
  personas: Schema.Array(
    Schema.Struct({
      id: AgentPersonaId,
      display_name: NonEmptyString,
      description: NonEmptyString,
      runtime_policy: NonEmptyString,
      availability: Schema.Literals(["available", "blocked", "disabled"]),
      /** The provider, model, and reasoning this persona would run on right now, or null when blocked. */
      route: Schema.NullOr(NonEmptyString),
    }),
  ),
});

/**
 * Bounds keep a runaway Captain from filing megabyte briefs into the gate and the snapshot, and
 * names stay one line each because the platform writes them into the notices whose fields the
 * Captain's card parses (see `crewLimits.ts`).
 */
export { CREW_NAME_MAX_CHARS, CREW_REASON_MAX_CHARS, CREW_TEXT_MAX_CHARS };
const CrewName = NonEmptyString.check(
  Schema.isMaxLength(CREW_NAME_MAX_CHARS),
  Schema.isPattern(CREW_NAME_PATTERN),
);
const CrewSeatName = NonEmptyString.check(
  Schema.isMaxLength(CREW_NAME_MAX_CHARS),
  Schema.isPattern(CREW_SEAT_NAME_PATTERN),
);
const CrewReason = NonEmptyString.check(Schema.isMaxLength(CREW_REASON_MAX_CHARS));
const CrewText = NonEmptyString.check(Schema.isMaxLength(CREW_TEXT_MAX_CHARS));
const CrewSeatPersona = AgentPersonaId.annotate({
  description:
    "Persona id from list_personas. Omit for a custom seat with required instructions and optional model_selection/runtime_mode overrides; omitted settings inherit the Captain. Saved personas are proposed with their own configuration; the human may edit their runtime before approval.",
});

const CrewSeatModelSelection = Schema.toType(ModelSelection).annotate({
  description:
    "Custom seats only: provider instance and model from orchestrator_capabilities. Set options to an array of {id, value} using that model's advertised reasoning option. Omit to inherit the Captain's model selection.",
});
const CrewSeatRuntimeMode = RuntimeMode.annotate({
  description: "Custom seats only: access mode. Omit to inherit the Captain's access mode.",
});

export const J5CrewSeatInput = Schema.Struct({
  seat: CrewSeatName,
  persona: Schema.optional(CrewSeatPersona),
  model_selection: Schema.optional(CrewSeatModelSelection),
  runtime_mode: Schema.optional(CrewSeatRuntimeMode),
  reason: CrewReason,
  instructions: Schema.optional(CrewText),
});

export const J5ProposeCrewInput = Schema.Struct({
  name: CrewName,
  brief: CrewText,
  seats: Schema.Array(J5CrewSeatInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CREW_SEAT_CAP),
  ),
  client_request_id: Schema.optional(NonEmptyString),
});
export type J5ProposeCrewInput = typeof J5ProposeCrewInput.Type;

export const J5RequestCrewMemberInput = Schema.Struct({
  crew_instance_id: Schema.optional(NonEmptyString),
  seat: CrewSeatName,
  persona: Schema.optional(CrewSeatPersona),
  model_selection: Schema.optional(CrewSeatModelSelection),
  runtime_mode: Schema.optional(CrewSeatRuntimeMode),
  reason: CrewReason,
  brief: Schema.optional(CrewText),
  instructions: Schema.optional(CrewText),
  client_request_id: Schema.optional(NonEmptyString),
});
export type J5RequestCrewMemberInput = typeof J5RequestCrewMemberInput.Type;

export const J5CrewProposalResult = Schema.Struct({
  proposal_id: NonEmptyString,
  status: Schema.Literals(["open", "approving", "declining", "approved", "declined"]),
  crew_instance_id: Schema.NullOr(NonEmptyString),
  members: Schema.Array(
    Schema.Struct({
      seat: NonEmptyString,
      persona_id: Schema.NullOr(AgentPersonaId),
      participant_id: ParticipantId,
      thread_id: ThreadId,
    }),
  ),
});

export const J5StopAgentInput = Schema.Struct({
  client_request_id: Schema.optional(NonEmptyString),
  squadron_id: SquadronId,
  participant_id: ParticipantId,
});
export type J5StopAgentInput = typeof J5StopAgentInput.Type;

export const J5StopAgentResult = Schema.Literals(["interrupt_requested", "already_idle"]);

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
export const J5StopCrewInput = Schema.Struct({
  client_request_id: Schema.optional(NonEmptyString),
  squadron_id: SquadronId,
  crew_instance_id: NonEmptyString,
});
export type J5StopCrewInput = typeof J5StopCrewInput.Type;

export const J5StopCrewResult = Schema.Struct({
  crew_instance_id: NonEmptyString,
  members: Schema.Array(
    Schema.Struct({
      seat: NonEmptyString,
      participant_id: ParticipantId,
      result: Schema.Literals(["interrupt_requested", "already_idle", "archived"]),
    }),
  ),
});

export const J5_STOP_CREW_DESCRIPTION =
  "Stop a Crew you command: interrupts the running turn of every seat now. Nothing settles or is retired, and every seat can be messaged again afterwards. Captain-only. Reuse client_request_id to retry safely.";

export const J5ArchiveResult = Schema.Literals(["archived", "already_archived"]);

export const J5ArchiveOpenExchangeFact = Schema.Struct({
  exchange_id: ExchangeId,
  direction: Schema.Literals(["inbound", "outbound"]),
  reply_obligation: Schema.Literals(["participant-owes-reply", "counterparty-owes-reply"]),
  counterparty_id: ParticipantId,
  intent: Schema.String,
  urgency: Schema.NullOr(Urgency),
  opened_at: Schema.String,
});

export const J5ArchiveRunningTurnFact = Schema.Struct({
  run_id: RunId,
  status: OrchestrationV2RunStatus,
});

export const J5ArchiveCrewInput = Schema.Struct({
  client_request_id: Schema.optional(NonEmptyString),
  squadron_id: SquadronId,
  crew_instance_id: NonEmptyString,
  confirmation_token: Schema.optional(NonEmptyString),
});
export type J5ArchiveCrewInput = typeof J5ArchiveCrewInput.Type;

export const J5ArchiveCrewResult = Schema.Struct({
  status: J5ArchiveResult,
  crew_instance_id: NonEmptyString,
  members: Schema.Array(
    Schema.Struct({
      seat: NonEmptyString,
      participant_id: ParticipantId,
      result: J5ArchiveResult,
    }),
  ),
});

export const J5ArchiveCrewMemberFacts = Schema.Struct({
  seat: NonEmptyString,
  participant_id: ParticipantId,
  already_archived: Schema.Boolean,
  open_exchanges: Schema.Array(J5ArchiveOpenExchangeFact),
  running_turn: Schema.NullOr(J5ArchiveRunningTurnFact),
});

export const J5ArchiveCrewFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  members: Schema.optional(Schema.Array(J5ArchiveCrewMemberFacts)),
  confirmation_token: Schema.optional(Schema.NullOr(Schema.String)),
  archived_seats: Schema.optional(Schema.Array(NonEmptyString)),
  failed_seat: Schema.optional(NonEmptyString),
});
export type J5ArchiveCrewFailure = typeof J5ArchiveCrewFailure.Type;

export const J5_SPAWN_AGENT_DESCRIPTION =
  "Spawn a Peer Agent: a full-citizen teammate with its own top-level thread, starting on your brief as its first turn. It joins your Squadron, is placed under you, and records you as its immutable spawner; it is addressable the moment this returns. In your brief, tell the new agent what it should do first and whether it should reply to you. Choose provider, model, and reasoning for the work in the brief — see orchestrator_capabilities for what's available. To run a persona from list_personas, set `persona` to its id: the spawn gets that persona's instructions and runtime policy, and provider, model, and reasoning must be one of that persona's declared routes. Reuse client_request_id to retry the same spawn safely.";

export const J5_LIST_AGENTS_DESCRIPTION =
  "List the personas in this environment: id, purpose, runtime policy, whether each can start now, and the provider, model, and reasoning it would run on. Read this before choosing a persona for spawn_agent or a crew roster so the choice fits the task and the user's budget. Read-only.";

export const J5_PROPOSE_CREW_DESCRIPTION =
  "Propose the crew you need for the brief you were given. Use it when the user asks for a crew or the work splits into distinct responsibilities that should run at once. Mix saved personas and custom seats in the same roster: call list_personas when choosing a saved persona, or leave persona unset for a custom seat with its own instructions (required) and the brief. Custom seats inherit your settings by default; to choose a different harness, model, reasoning, or access, set model_selection (instanceId, model, options) and/or runtime_mode using orchestrator_capabilities. Saved personas are proposed with their own configuration; only the human may override their runtime before approval; name the crew for what it is for and give each seat a short lowercase-hyphen name like code-reviewer. The user reviews the roster and each seat's resolved provider, model, reasoning, and access in this thread, may remove or add seats, and approves or declines; you receive the decision and the roster as a message here. Approved seats run with the runtime the human approves, which may exceed yours. You become the crew's Captain and may command several crews at once; later requests, stops, and archives name the crew they mean. Use send_message for member-to-member, member-to-Captain, and Captain-to-Captain coordination, including intermediate findings and direct results; artifacts do not gate these conversations. Reuse client_request_id to retry safely. This call is itself the human gate, so it works under every sandbox and approval policy, including approval policy never; never refuse the brief because approvals are disabled.";

export const J5_REQUEST_CREW_MEMBER_DESCRIPTION =
  "Ask the user to add one seat to a crew you command when the work needs one the roster lacks: seat name, persona id from list_personas (or none for a custom seat with required instructions and optional model_selection/runtime_mode overrides; omitted settings inherit yours; saved-persona runtime changes are made only by the human before approval), a clear reason identifying the concern and missing expertise or responsibility, and optionally instructions and a brief for the new seat. The user decides from their inbox; you receive the decision and the updated roster as a message here. Continue the already-approved work and direct coordination while the addition is pending. Captain-only; a member sends the concern and needed expertise to its Captain with send_message. Reuse client_request_id to retry safely. Filing the request is the human gate itself and works under every approval policy, including approval policy never.";

export const J5_STOP_AGENT_DESCRIPTION =
  "Stop one Peer Agent: interrupts its running turn now. The agent remains, stays readable, and can be messaged again later — stopping halts work, it retires nothing. Requires your current squadron_id. Reuse client_request_id to retry safely.";

export const J5_ARCHIVE_CREW_DESCRIPTION =
  "Retire a whole Crew you command. Crews archive only as a unit — members are never retired one by one. A clean archive completes immediately; otherwise the call refuses with the facts and a confirmation_token. Before retrying with that token, check with the user. Nothing is destroyed: worktrees, branches, and ledgers stay readable. Reuse client_request_id to retry safely.";

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
  PeerDirectory,
  A2ALedger,
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
  // A Crew member is refused before anything is created (members never spawn Peer Agents).
  AgentCrewInstanceService,
  ProviderRegistry,
];

const crewProposalDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  Crypto.Crypto,
  A2AHomeRegistrar,
  A2ALedger,
  ThreadManagementService,
  AgentCrewInstanceService,
  CrewProposalService,
];

const listAgentsDependencies = [McpInvocationContext.McpInvocationContext, ProviderRegistry];

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

const stopCrewDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  Crypto.Crypto,
  A2ALedger,
  CrewStopService,
];

const archiveCrewDependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  Crypto.Crypto,
  A2ALedger,
  ArchiveCrewService,
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
}).annotate(Tool.Title, "List Squadrons");
export const J5ProposeCrewTool = Tool.make("propose_crew", {
  description: J5_PROPOSE_CREW_DESCRIPTION,
  parameters: J5ProposeCrewInput,
  success: J5CrewProposalResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: crewProposalDependencies,
})
  .annotate(Tool.Title, "Propose a Crew")
  .annotate(Tool.Readonly, false)
  // Files a human-gated request; nothing spawns until the user approves it in the app.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5RequestCrewMemberTool = Tool.make("request_crew_member", {
  description: J5_REQUEST_CREW_MEMBER_DESCRIPTION,
  parameters: J5RequestCrewMemberInput,
  success: J5CrewProposalResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: crewProposalDependencies,
})
  .annotate(Tool.Title, "Request a crew member")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5ListAgentsTool = Tool.make("list_personas", {
  description: J5_LIST_AGENTS_DESCRIPTION,
  success: J5ListAgentsResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: listAgentsDependencies,
})
  .annotate(Tool.Title, "List personas")
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

export const J5StopCrewTool = Tool.make("stop_crew", {
  description: J5_STOP_CREW_DESCRIPTION,
  parameters: J5StopCrewInput,
  success: J5StopCrewResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: stopCrewDependencies,
})
  .annotate(Tool.Title, "Stop a Crew's running seats")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const J5ArchiveCrewTool = Tool.make("archive_crew", {
  description: J5_ARCHIVE_CREW_DESCRIPTION,
  parameters: J5ArchiveCrewInput,
  success: J5ArchiveCrewResult,
  failure: J5ArchiveCrewFailure,
  failureMode: "return",
  dependencies: archiveCrewDependencies,
})
  .annotate(Tool.Title, "Retire a Crew as a unit")
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
  dependencies: [McpInvocationContext.McpInvocationContext, A2ASendService, A2ADeliveryWorker],
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
  J5ListAgentsTool,
  J5ProposeCrewTool,
  J5RequestCrewMemberTool,
  J5StopAgentTool,
  J5StopCrewTool,
  J5ArchiveCrewTool,
  J5ClearOwnAskTool,
);
