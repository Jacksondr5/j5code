import { Tool, Toolkit } from "effect/unstable/ai";
import * as Schema from "effect/Schema";

import * as Crypto from "effect/Crypto";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import {
  A2A_JOIN_TOOL_DESCRIPTION,
  A2A_LIST_TOOL_DESCRIPTION,
  A2A_SEND_TOOL_DESCRIPTION,
} from "../EnvelopeFormatter.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AEpicBootstrap } from "../EpicBootstrapService.ts";
import { A2ASendService } from "../SendService.ts";
import {
  EpicId,
  ExchangeId,
  JoinEpicResult,
  ParticipantDirectoryRow,
  ParticipantId,
  SendMessageResult,
  Urgency,
} from "../contracts.ts";

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

export const J5ListParticipantsResult = Schema.Struct({
  participants: Schema.Array(ParticipantDirectoryRow),
});

export const J5JoinEpicInput = Schema.Struct({
  epic_id: Schema.optional(EpicId),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  A2ASendService,
  A2ADeliveryWorker,
  A2AEpicBootstrap,
  Crypto.Crypto,
];

export const J5SendMessageTool = Tool.make("send_message", {
  description: A2A_SEND_TOOL_DESCRIPTION,
  parameters: J5SendMessageInput,
  success: SendMessageResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send a J5 A2A message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const J5ListParticipantsTool = Tool.make("list_participants", {
  description: A2A_LIST_TOOL_DESCRIPTION,
  success: J5ListParticipantsResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List J5 A2A participants")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const J5JoinEpicTool = Tool.make("join_epic", {
  description: A2A_JOIN_TOOL_DESCRIPTION,
  parameters: J5JoinEpicInput,
  success: JoinEpicResult,
  failure: J5McpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Join a J5 epic")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Shared J5 toolkit bootstrap. Later J5 milestones append their tools here. */
export const J5Toolkit = Toolkit.make(J5SendMessageTool, J5ListParticipantsTool, J5JoinEpicTool);
