import type { ThreadSearchAuthor } from "@t3tools/contracts/j5";

/**
 * Who a Cmd+K message hit is from, as its label reads: an agent, the reader, or another person by
 * the name the server tells. A user-role hit the server names no one for keeps upstream's "You".
 */
export function threadSearchMatchLabel(match: {
  readonly source: "user" | "assistant";
  readonly author?: ThreadSearchAuthor | undefined;
}): string {
  if (match.source === "assistant") return "Agent";
  if (match.author?._tag === "person") return match.author.name ?? "Someone";
  return "You";
}
