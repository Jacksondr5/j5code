import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import { McpSchema } from "effect/ai";

/**
 * Whether a registration's `EnabledWhen` admits the client whose request this fiber serves, so
 * `tool_search` never names a tool that client is not offered, such as the link-only
 * `t3_thread_launch` (register D2, FORK.md case 4). Outside a request, nothing is admitted.
 */
export const visibleToCaller = (annotations: Context.Context<never>): boolean => {
  const enabledWhen = Context.getOrUndefined(annotations, McpSchema.EnabledWhen);
  if (enabledWhen === undefined) return true;
  const fiber = Fiber.getCurrent();
  const request = fiber && Context.getOrUndefined(fiber.context, McpSchema.McpRequestContext);
  return (
    request !== undefined &&
    enabledWhen({
      protocolVersion: request.protocolVersion,
      capabilities: request.clientCapabilities,
      ...(request.clientInfo === undefined ? {} : { clientInfo: request.clientInfo }),
    })
  );
};
