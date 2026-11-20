import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";

/** Keep the original sender and schedule across queues, native steers, retries and launches. */
export function messageProvenance(
  input: Pick<
    OrchestrationV2ConversationMessage,
    "scheduledTaskId" | "scheduledTaskPrompt" | "playbookOrigin" | "senderThreadId" | "senderRunId"
  >,
) {
  return {
    ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
    ...(input.scheduledTaskPrompt === undefined
      ? {}
      : { scheduledTaskPrompt: input.scheduledTaskPrompt }),
    ...(input.playbookOrigin === undefined ? {} : { playbookOrigin: input.playbookOrigin }),
    ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
    ...(input.senderRunId === undefined ? {} : { senderRunId: input.senderRunId }),
  };
}
