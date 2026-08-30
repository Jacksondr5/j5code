import { assert, it } from "@effect/vitest";

import {
  A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION,
  A2A_ENVELOPE_VERSION,
  A2A_LIST_TOOL_DESCRIPTION,
  A2A_SEND_TOOL_DESCRIPTION,
  formatClosedHumanEnvelope,
  formatClosedPeerEnvelope,
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

  assert.equal(A2A_ENVELOPE_VERSION, 13);
  assert.include(rendered, "Cross-agent message");
  assert.notMatch(rendered, /\b(?:J5|A2A)\b/);
  assert.include(rendered, "agent:sender");
  assert.include(rendered, "squadron:origin");
  assert.include(rendered, "Please verify the worker.");
  assert.include(rendered, 'send_message(to="agent:sender", exchange_id="exchange:one"');
  assert.include(rendered, "Reply once");
  assert.notInclude(rendered, "{{");
});


it("renders reply closures without another reply instruction for either channel", () => {
  const peerMessage = "Peer reply bytes\n  stay exact.  ";
  const humanMessage = "  Human reply bytes\nremain exact. ";
  const peer = formatClosedPeerEnvelope({
    senderId: ParticipantId.make("agent:replying-peer"),
    originSquadronId: SquadronId.make("squadron:replying-peer"),
    message: peerMessage,
  });
  const human = formatClosedHumanEnvelope({
    senderId: ParticipantId.make("human:replying-person"),
    message: humanMessage,
  });

  assert.include(peer, peerMessage);
  assert.include(human, humanMessage);
  for (const rendered of [peer, human]) {
    assert.include(rendered, "The platform closed this exchange when this reply was sent.");
    assert.include(rendered, "No further reply is required.");
    assert.notInclude(rendered, "send_message(");
    assert.notInclude(rendered, "Use send_message without exchange_id");
    assert.notInclude(rendered, "{{");
  }
  assert.notInclude(human, "This person is not watching this chat");
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
    "Send one durable message to another agent or the human. Three uses: a plain send when you don't need a reply; an ask — set expect_reply=true with a one-line intent, opening an exchange the receiver owes a reply to; a reply — include the exchange_id from the ask you are answering, which closes that exchange. Use this tool only for participants already returned by list_participants; when creating a Peer Agent, put any reply expectation in spawn_agent's brief instead of sending a follow-up ask. Set urgency only when asking the human. Returns once the message is committed; delivery continues asynchronously — carry on with your work, and the reply arrives later as an incoming message. Reuse client_request_id to retry the same send safely. This tool is unavailable to a native thread without a registered home squadron.",
  );
  assert.include(A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION, "Withdraw an ask you sent");
  assert.include(A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION, "sender-cleared");
  assert.include(A2A_CLEAR_OWN_ASK_TOOL_DESCRIPTION, "client_request_id");
  assert.equal(
    A2A_LIST_TOOL_DESCRIPTION,
    "Your address book: the participants around you — agents and the human — with the display name to recognize them by, the participant_id to address them with, and what each accepts (messages, exchanges, urgency). When you're told to message someone by name or role, resolve them here first. Your own row is marked self=true; it cannot receive messages or open exchanges from you — use schedule_task if you need a future trigger for yourself. Native threads that never received a Squadron home do not appear here and cannot be messaged. The roster changes — after you spawn an agent, or when a participant retires, call this again instead of reusing a stale listing.",
  );
  for (const clause of [
    "Your own row is marked self=true",
    "use schedule_task if you need a future trigger for yourself",
    "Native threads that never received a Squadron home do not appear here and cannot be messaged.",
    "The roster changes — after you spawn an agent, or when a participant retires, call this again instead of reusing a stale listing.",
  ]) {
    assert.include(A2A_LIST_TOOL_DESCRIPTION, clause);
  }
  assert.include(A2A_SEND_TOOL_DESCRIPTION, "native thread without a registered home squadron");
  for (const description of [A2A_SEND_TOOL_DESCRIPTION, A2A_LIST_TOOL_DESCRIPTION]) {
    assert.notInclude(description, "wrapper-spawned");
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
