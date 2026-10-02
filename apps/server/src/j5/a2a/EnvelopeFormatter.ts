import config from "./envelopes.v1.json" with { type: "json" };

import type { SquadronId, ExchangeId, ParticipantId } from "./contracts.ts";

export const A2A_ENVELOPE_VERSION = config.version;
export const A2A_SEND_TOOL_DESCRIPTION = config.sendToolDescription;
export const A2A_LIST_TOOL_DESCRIPTION = config.listToolDescription;
export const A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION = config.clearOwnAskToolDescription;

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

/** A sender on a peer server is named with the server it lives on; a local sender's line is unchanged. */
const senderServer = (serverName: string | undefined) =>
  serverName === undefined ? "" : render(config.senderServer, { serverName });

export const formatPeerEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly originSquadronId: SquadronId;
  readonly exchangeId: ExchangeId | null;
  readonly message: string;
  readonly senderServerName?: string;
}): string =>
  render(config.peerMessage, {
    senderId: input.senderId,
    originSquadronId: input.originSquadronId,
    senderServer: senderServer(input.senderServerName),
    message: input.message,
    exchangeInstruction: deliveryInstruction(input),
  });

/** A machine sender never opens an exchange, so its envelope carries no reply instruction. */
export const formatMachineEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly originSquadronId: SquadronId;
  readonly message: string;
}): string =>
  render(config.machineMessage, {
    senderId: input.senderId,
    originSquadronId: input.originSquadronId,
    message: input.message,
    machineInstruction: config.machineInstruction,
  });

export const formatClosedPeerEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly originSquadronId: SquadronId;
  readonly message: string;
  readonly senderServerName?: string;
}): string =>
  render(config.peerClosedMessage, {
    senderId: input.senderId,
    originSquadronId: input.originSquadronId,
    senderServer: senderServer(input.senderServerName),
    message: input.message,
    closedExchangeInstruction: config.closedExchangeInstruction,
  });

/** A person's only ledger message is the inbox answer that closes an exchange. */
export const formatClosedHumanEnvelope = (input: {
  readonly senderId: ParticipantId;
  readonly message: string;
}): string =>
  render(config.humanClosedMessage, {
    senderId: input.senderId,
    message: input.message,
    closedExchangeInstruction: config.closedExchangeInstruction,
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

/** Told to a sender whose message will wait behind the receiver's running turn. */
export const formatReceiverBacklogNotice = (input: {
  readonly receiverId: ParticipantId;
  readonly waiting: number;
  readonly fromYou: number;
}): string =>
  render(config.receiverBacklogNotice, {
    receiverId: input.receiverId,
    waiting: String(input.waiting),
    fromYou: String(input.fromYou),
  });
