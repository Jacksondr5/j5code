import config from "./envelopes.v1.json" with { type: "json" };

import type { EpicId, ExchangeId, ParticipantId } from "./contracts.ts";

export const A2A_ENVELOPE_VERSION = config.version;
export const A2A_SEND_TOOL_DESCRIPTION = config.sendToolDescription;
export const A2A_LIST_TOOL_DESCRIPTION = config.listToolDescription;
export const A2A_JOIN_TOOL_DESCRIPTION = config.joinToolDescription;

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

export const formatEpicSwitchWarning = (input: {
  readonly epicId: EpicId;
  readonly exchangeId: ExchangeId;
  readonly peerId: ParticipantId;
}): string =>
  render(config.epicSwitchWarning, {
    epicId: input.epicId,
    exchangeId: input.exchangeId,
    peerId: input.peerId,
  });

export const formatPeerEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly originEpicId: EpicId;
  readonly exchangeId: ExchangeId | null;
  readonly message: string;
}): string =>
  render(config.peerMessage, {
    senderId: input.senderId,
    originEpicId: input.originEpicId,
    message: input.message,
    exchangeInstruction: deliveryInstruction(input),
  });

export const formatHumanEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly exchangeId: ExchangeId | null;
  readonly message: string;
}): string =>
  render(config.humanMessage, {
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
