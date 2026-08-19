import { assert, it } from "@effect/vitest";

import {
  A2A_ENVELOPE_VERSION,
  A2A_JOIN_TOOL_DESCRIPTION,
  A2A_LIST_TOOL_DESCRIPTION,
  A2A_SEND_TOOL_DESCRIPTION,
  formatEpicSwitchWarning,
  formatHumanEnvelope,
  formatPeerEnvelope,
  formatSilenceNoticeEnvelope,
} from "./EnvelopeFormatter.ts";
import { EpicId, ExchangeId, ParticipantId } from "./contracts.ts";

it("renders the versioned peer envelope with exact reply semantics", () => {
  const rendered = formatPeerEnvelope({
    senderId: ParticipantId.make("agent:sender"),
    originEpicId: EpicId.make("epic:origin"),
    exchangeId: ExchangeId.make("exchange:one"),
    message: "Please verify the worker.",
  });

  assert.equal(A2A_ENVELOPE_VERSION, 3);
  assert.include(rendered, "Cross-agent message");
  assert.notMatch(rendered, /\b(?:J5|A2A)\b/);
  assert.include(rendered, "agent:sender");
  assert.include(rendered, "epic:origin");
  assert.include(rendered, "Please verify the worker.");
  assert.include(rendered, 'send_message(to="agent:sender", exchange_id="exchange:one"');
  assert.include(rendered, "Reply once");
  assert.notInclude(rendered, "{{");
});

it("labels platform-authored silence without internal product branding", () => {
  const rendered = formatSilenceNoticeEnvelope({
    noticeType: "peer unavailable",
    message: "No reply was delivered.",
  });

  assert.include(rendered, "Cross-agent messaging system notice: peer unavailable");
  assert.include(rendered, "platform-authored delivery signal");
  assert.notMatch(rendered, /\b(?:J5|A2A)\b/);
});

it("renders epic-switch warnings with the abandoned exchange and peer", () => {
  const rendered = formatEpicSwitchWarning({
    epicId: EpicId.make("epic:previous"),
    exchangeId: ExchangeId.make("exchange:abandoned"),
    peerId: ParticipantId.make("agent:waiting-peer"),
  });

  assert.include(rendered, "epic:previous");
  assert.include(rendered, "exchange:abandoned");
  assert.include(rendered, "agent:waiting-peer");
  assert.include(rendered, "not cancelled or transferred");
  assert.notInclude(rendered, "{{");
});

it("does not interpret caller text as an envelope template", () => {
  const message = "Preserve this literal token: {{exchangeInstruction}}";
  const rendered = formatPeerEnvelope({
    senderId: ParticipantId.make("agent:sender"),
    originEpicId: EpicId.make("epic:origin"),
    exchangeId: ExchangeId.make("exchange:one"),
    message,
  });

  assert.include(rendered, message);
  assert.equal(rendered.match(/send_message\(/g)?.length, 1);
});

it("tells agents that human-origin exchanges require an explicit tool reply", () => {
  const rendered = formatHumanEnvelope({
    senderId: ParticipantId.make("human:global"),
    exchangeId: ExchangeId.make("exchange:human"),
    message: "Please report status.",
  });

  assert.include(rendered, "The human is not watching this chat");
  assert.include(rendered, 'exchange_id="exchange:human"');
  assert.include(A2A_SEND_TOOL_DESCRIPTION, "returns after the sender ledger commit");
  assert.include(A2A_SEND_TOOL_DESCRIPTION, "cross-agent message");
  assert.include(A2A_LIST_TOOL_DESCRIPTION, "cross-agent messaging participants");
  assert.include(A2A_JOIN_TOOL_DESCRIPTION, "authenticated thread");
  assert.include(A2A_JOIN_TOOL_DESCRIPTION, "open exchange ID and peer");
  assert.notMatch(
    [A2A_SEND_TOOL_DESCRIPTION, A2A_LIST_TOOL_DESCRIPTION, A2A_JOIN_TOOL_DESCRIPTION].join("\n"),
    /\b(?:J5|A2A)\b/,
  );
});
