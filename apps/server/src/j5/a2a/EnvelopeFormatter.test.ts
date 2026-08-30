import { assert, it } from "@effect/vitest";

import {
  A2A_ENVELOPE_VERSION,
  A2A_LIST_TOOL_DESCRIPTION,
  A2A_SEND_TOOL_DESCRIPTION,
  formatHumanEnvelope,
  formatPeerEnvelope,
  formatSilenceNoticeEnvelope,
} from "./EnvelopeFormatter.ts";
import { SquadronId, ExchangeId, ParticipantId } from "./contracts.ts";

it("renders the versioned peer envelope with exact reply semantics", () => {
  const rendered = formatPeerEnvelope({
    senderId: ParticipantId.make("agent:sender"),
    originSquadronId: SquadronId.make("squadron:origin"),
    exchangeId: ExchangeId.make("exchange:one"),
    message: "Please verify the worker.",
  });

  assert.equal(A2A_ENVELOPE_VERSION, 7);
  assert.include(rendered, "Cross-agent message");
  assert.notMatch(rendered, /\b(?:J5|A2A)\b/);
  assert.include(rendered, "agent:sender");
  assert.include(rendered, "squadron:origin");
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

it("does not interpret caller text as an envelope template", () => {
  const message = "Preserve this literal token: {{exchangeInstruction}}";
  const rendered = formatPeerEnvelope({
    senderId: ParticipantId.make("agent:sender"),
    originSquadronId: SquadronId.make("squadron:origin"),
    exchangeId: ExchangeId.make("exchange:one"),
    message,
  });

  assert.include(rendered, message);
  assert.equal(rendered.match(/send_message\(/g)?.length, 1);
});

it("tells agents that human-origin exchanges require an explicit tool reply", () => {
  const rendered = formatHumanEnvelope({
    senderId: ParticipantId.make("human:formatter-person"),
    exchangeId: ExchangeId.make("exchange:human"),
    message: "Please report status.",
  });

  assert.include(rendered, "[Message from human:formatter-person]");
  assert.include(rendered, "This person is not watching this chat");
  assert.include(rendered, 'exchange_id="exchange:human"');
  assert.include(A2A_SEND_TOOL_DESCRIPTION, "returns after the sender ledger commit");
  assert.include(A2A_SEND_TOOL_DESCRIPTION, "Durably send one message");
  assert.include(A2A_LIST_TOOL_DESCRIPTION, "List reachable message recipients");
  for (const description of [A2A_SEND_TOOL_DESCRIPTION, A2A_LIST_TOOL_DESCRIPTION]) {
    assert.include(description, "native thread without a registered home squadron");
    assert.include(description, "wrapper-spawned agent");
    assert.include(description, "controlled test seeding");
    assert.include(description, "home-squadron registrar + A6 creation integrations follow-up");
    assert.notMatch(description, /ask the user|product workflow|list_participants again/i);
  }
  assert.notMatch(
    [rendered, A2A_SEND_TOOL_DESCRIPTION, A2A_LIST_TOOL_DESCRIPTION].join("\n"),
    /\b(?:J5|A2A)\b/,
  );
});
