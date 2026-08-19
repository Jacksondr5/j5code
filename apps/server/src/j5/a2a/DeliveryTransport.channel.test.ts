import { assert, it } from "@effect/vitest";

import { type AgentDeliveryInput, formatAgentDeliveryEnvelope } from "./DeliveryTransport.ts";
import { formatSilenceNoticeEnvelope } from "./EnvelopeFormatter.ts";
import { SquadronId, ExchangeId, LedgerMessageId, ParticipantId } from "./contracts.ts";

const delivery = {
  originSquadronId: SquadronId.make("squadron:channel"),
  receiverSquadronId: SquadronId.make("squadron:channel"),
  messageId: LedgerMessageId.make("message:channel"),
  senderId: ParticipantId.make("agent:channel:sender"),
  receiverId: ParticipantId.make("agent:channel:receiver"),
  exchangeId: ExchangeId.make("exchange:channel"),
  message: "POISON_IF_PEER_WRAPPED",
  envelopeChannel: "peer",
} satisfies AgentDeliveryInput;

it("routes a silence notice through the existing system envelope without peer wrapping", () => {
  const silenceEnvelope = formatSilenceNoticeEnvelope({
    noticeType: "turn-ended-no-reply",
    message: delivery.message,
  });
  const rendered = formatAgentDeliveryEnvelope({
    ...delivery,
    message: silenceEnvelope,
    envelopeChannel: "silence_notice",
  });

  assert.equal(rendered, silenceEnvelope);
  assert.notInclude(rendered, "[Cross-agent message from");
  assert.include(rendered, "platform-authored delivery signal");
});

it("fails closed for an unknown persisted delivery envelope channel", () => {
  assert.throws(
    () =>
      formatAgentDeliveryEnvelope({
        ...delivery,
        envelopeChannel: "poisoned-channel" as AgentDeliveryInput["envelopeChannel"],
      }),
    /Unsupported A2A delivery envelope channel/,
  );
});
