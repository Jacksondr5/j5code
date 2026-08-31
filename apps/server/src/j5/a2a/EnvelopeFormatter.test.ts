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

  assert.equal(A2A_ENVELOPE_VERSION, 9);
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
  assert.equal(
    A2A_SEND_TOOL_DESCRIPTION,
    "Send one durable message to another agent or the human. Three uses: a plain send when you don't need a reply; an ask — set expect_reply=true with a one-line intent, opening an exchange the receiver owes a reply to; a reply — include the exchange_id from the ask you are answering, which closes that exchange. Use this tool only for participants already returned by list_participants; when creating a Peer Agent, put any reply expectation in spawn_agent's brief instead of sending a follow-up ask. Set urgency only when asking the human. Returns once the message is committed; delivery continues asynchronously — carry on with your work, and the reply arrives later as an incoming message. Reuse client_request_id to retry the same send safely. This tool is unavailable to a native thread without a registered home squadron. Participation currently requires a wrapper-spawned agent that already has a home squadron or controlled test seeding; native user-created home provisioning is deferred to the home-squadron registrar + A6 creation integrations follow-up.",
  );
  assert.equal(
    A2A_LIST_TOOL_DESCRIPTION,
    "Your address book: every participant row available to you — agents and the human — with a display name when known, a participant id to address, and capabilities showing whether it accepts messages, exchanges, or urgency. Your own row is marked self=true; it cannot receive messages or open exchanges from you. Use schedule_task if you need a future trigger for yourself. When you're told to message someone by name or role, resolve them here first. This tool is unavailable to a native thread without a registered home squadron. Participation currently requires a wrapper-spawned agent that already has a home squadron or controlled test seeding; native user-created home provisioning is deferred to the home-squadron registrar + A6 creation integrations follow-up.",
  );
  for (const description of [A2A_SEND_TOOL_DESCRIPTION, A2A_LIST_TOOL_DESCRIPTION]) {
    assert.include(description, "native thread without a registered home squadron");
    assert.include(description, "wrapper-spawned agent");
    assert.include(description, "controlled test seeding");
  }
  assert.include(A2A_SEND_TOOL_DESCRIPTION, "participants already returned by list_participants");
  assert.include(A2A_SEND_TOOL_DESCRIPTION, "reply expectation in spawn_agent's brief");
  assert.notMatch(
    A2A_LIST_TOOL_DESCRIPTION,
    /consult.*(?:spawn|archive)|(?:spawn|archive).*changes/i,
  );
  assert.notMatch(
    [rendered, A2A_SEND_TOOL_DESCRIPTION, A2A_LIST_TOOL_DESCRIPTION].join("\n"),
    /\b(?:J5|A2A)\b/,
  );
});
