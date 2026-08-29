import { Tool, Toolkit } from "effect/unstable/ai";
import * as Schema from "effect/Schema";

import { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { A2A_LIST_TOOL_DESCRIPTION, A2A_SEND_TOOL_DESCRIPTION } from "../EnvelopeFormatter.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { PlacementCascadeRow, PlacementCascadeService } from "../PlacementCascadeService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import {
  ExchangeId,
  ParticipantDirectoryRow,
  ParticipantId,
  SendMessageResult,
  SquadronId,
  Urgency,
} from "../contracts.ts";
import { ParticipantProvenanceView } from "../placementContracts.ts";

export const J5McpFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type J5McpFailure = typeof J5McpFailure.Type;

export const J5SendMessageInput = Schema.Struct({
  to: ParticipantId,
  message: Schema.String.check(Schema.isNonEmpty()),
  client_request_id: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  expect_reply: Schema.optional(Schema.Boolean),
  exchange_id: Schema.optional(ExchangeId),
  intent: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  urgency: Schema.optional(Urgency),
});
export type J5SendMessageInput = typeof J5SendMessageInput.Type;

export const J5ParticipantDirectoryRow = Schema.Struct({
  ...ParticipantDirectoryRow.fields,
  threadId: Schema.NullOr(ThreadId),
  provenance: ParticipantProvenanceView,
  placementParentId: Schema.NullOr(ParticipantId),
});

export const J5ListParticipantsResult = Schema.Struct({
  participants: Schema.Array(J5ParticipantDirectoryRow),
});

export const J5PlacementCascadeInput = Schema.Struct({
  client_request_id: Schema.String.check(Schema.isNonEmpty()),
  squadron_id: SquadronId,
  participant_id: ParticipantId,
});

export const J5PlacementCascadeResult = Schema.Struct({
  results: Schema.Array(PlacementCascadeRow),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  A2ADeliveryWorker,
  Crypto.Crypto,
];

const placementDependencies = [
  ...dependencies,
  ParticipantPlacementService,
  PlacementCascadeService,
];

export const J5SendMessageTool = Tool.make("send_message", {
  description: A2A_SEND_TOOL_DESCRIPTION,
  parameters: J5SendMessageInput,
  success: SendMessageResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send a cross-agent message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5ListParticipantsTool = Tool.make("list_participants", {
  description: A2A_LIST_TOOL_DESCRIPTION,
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

export const J5StopAgentTool = Tool.make("stop_agent", {
  description:
    "Stop one J5 participant and every agent below it in the mutable placement tree, leaves first. The caller must be a current member of squadron_id. Cascade never follows provenance: a fork placed beside its source is not stopped with that source.",
  parameters: J5PlacementCascadeInput,
  success: J5PlacementCascadeResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: placementDependencies,
})
  .annotate(Tool.Title, "Stop a J5 placement subtree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const J5ArchiveAgentTool = Tool.make("archive_agent", {
  description:
    "Archive one J5 participant and every agent below it in the mutable placement tree, leaves first. The caller must be a current member of squadron_id. Cascade never follows provenance: a fork placed beside its source is not archived with that source.",
  parameters: J5PlacementCascadeInput,
  success: J5PlacementCascadeResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies: placementDependencies,
})
  .annotate(Tool.Title, "Archive a J5 placement subtree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

/** Shared J5 toolkit bootstrap. Later J5 milestones append their tools here. */
export const J5Toolkit = Toolkit.make(
  J5SendMessageTool,
  J5ListParticipantsTool,
  J5StopAgentTool,
  J5ArchiveAgentTool,
);
