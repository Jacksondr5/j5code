/**
 * The headers J5's delivery envelopes open with (`apps/server/src/j5/a2a/envelopes.v1.json`). An
 * envelope already names its sender, so upstream's sender line is left off a message that carries
 * one; `EnvelopeFormatter.test.ts` holds every envelope to this.
 */
const J5_DELIVERY_ENVELOPE_HEADER =
  /^\[(?:Cross-agent message from |Message from |Cross-agent messaging system notice: )/u;

export const carriesJ5DeliveryEnvelope = (text: string): boolean =>
  J5_DELIVERY_ENVELOPE_HEADER.test(text);
