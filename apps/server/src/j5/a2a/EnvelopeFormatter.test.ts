import { assert, it } from "@effect/vitest";

import {
  A2A_ENVELOPE_VERSION,
  A2A_JOIN_TOOL_DESCRIPTION,
  A2A_LIST_TOOL_DESCRIPTION,
  A2A_SEND_TOOL_DESCRIPTION,
  formatEpicSwitchWarning,
  formatHumanEnvelope,
  formatPeerEnvelope,
} from "./EnvelopeFormatter.ts";
import { EpicId, ExchangeId, ParticipantId } from "./contracts.ts";

it("renders the versioned peer envelope with exact reply semantics", () => {
  const rendered = formatPeerEnvelope({
    senderId: ParticipantId.make("agent:sender"),
    originEpicId: EpicId.make("epic:origin"),
    exchangeId: ExchangeId.make("exchange:one"),
    message: "Please verify the worker.",
  });

  assert.equal(A2A_ENVELOPE_VERSION, 2);
  assert.include(rendered, "agent:sender");
  assert.include(rendered, "epic:origin");
  assert.include(rendered, "Please verify the worker.");
  assert.include(rendered, 'send_message(to="agent:sender", exchange_id="exchange:one"');
  assert.include(rendered, "Reply once");
  assert.notInclude(rendered, "{{");
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

it("tells agents that human-origin exchanges require an explicit tool reply", () => {
  const rendered = formatHumanEnvelope({
    senderId: ParticipantId.make("human:global"),
    exchangeId: ExchangeId.make("exchange:human"),
    message: "Please report status.",
  });

  assert.include(rendered, "The human is not watching this chat");
  assert.include(rendered, 'exchange_id="exchange:human"');
  assert.include(A2A_SEND_TOOL_DESCRIPTION, "returns after the sender ledger commit");
  assert.include(A2A_LIST_TOOL_DESCRIPTION, "reachable J5 A2A participants");
  assert.include(A2A_JOIN_TOOL_DESCRIPTION, "authenticated thread");
  assert.include(A2A_JOIN_TOOL_DESCRIPTION, "open exchange ID and peer");
});
