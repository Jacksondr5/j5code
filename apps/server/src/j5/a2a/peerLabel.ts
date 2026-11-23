import { PEER_SENDER_LABEL_MAX_CHARS } from "@t3tools/contracts/j5";

/**
 * A server name a peer reported for itself, made safe to show in agent-facing
 * text: it lands in envelope headers and platform notices, so square brackets
 * go and any run of whitespace or control characters becomes one space, then
 * it is capped. Undefined when nothing is left.
 */
export const reportedLabel = (label: string | undefined): string | undefined => {
  const clean = label
    ?.replace(/[[\]]/g, "")
    .replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .slice(0, PEER_SENDER_LABEL_MAX_CHARS)
    .trim();
  return clean === undefined || clean.length === 0 ? undefined : clean;
};
