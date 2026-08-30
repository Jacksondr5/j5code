import config from "./envelopes.v1.json" with { type: "json" };

import type { SquadronId, ExchangeId, ParticipantId } from "./contracts.ts";

export const A2A_ENVELOPE_VERSION = config.version;
export const A2A_SEND_TOOL_DESCRIPTION = config.sendToolDescription;
export const A2A_LIST_TOOL_DESCRIPTION = config.listToolDescription;

const render = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{\{([^{}]+)\}\}/g, (placeholder, name: string) => values[name] ?? placeholder);

const deliveryInstruction = (input: {
  readonly senderId: ParticipantId;
  readonly exchangeId: ExchangeId | null;
}) =>
  input.exchangeId === null
    ? config.oneShotInstruction
    : render(config.replyInstruction, {
        senderId: input.senderId,
        exchangeId: input.exchangeId,
      });

export const formatPeerEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly originSquadronId: SquadronId;
  readonly exchangeId: ExchangeId | null;
  readonly message: string;
}): string =>
  render(config.peerMessage, {
    senderId: input.senderId,
    originSquadronId: input.originSquadronId,
    message: input.message,
    exchangeInstruction: deliveryInstruction(input),
  });

export const formatHumanEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly exchangeId: ExchangeId | null;
  readonly message: string;
}): string =>
  render(config.humanMessage, {
    senderId: input.senderId,
    message: input.message,
    exchangeInstruction: deliveryInstruction(input),
  });

/** A3 supplies notice derivation; A2 owns this channel's stable rendering shape. */
export const formatSilenceNoticeEnvelope = (input: {
  readonly noticeType: string;
  readonly message: string;
}): string =>
  render(config.silenceNotice, {
    noticeType: input.noticeType,
    message: input.message,
  });
