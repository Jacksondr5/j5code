import { assert, it } from "@effect/vitest";

import { formatClosedPeerEnvelope, formatPeerEnvelope } from "./EnvelopeFormatter.ts";
import { ExchangeId, LedgerProjectId, ParticipantId } from "./contracts.ts";
import { splitDeliveryEnvelope } from "./queuedEdits.ts";

const senderId = ParticipantId.make("agent:j5:a2a:thread:sender");
const originProjectId = LedgerProjectId.make("project:edits");

it("cuts every peer envelope around its body, blank lines and brackets in the body included", () => {
  const body = "First paragraph.\n\n[agent:j5:a2a:thread:sender] quoted]\n\nLast paragraph.";
  for (const text of [
    formatPeerEnvelope({
      senderId,
      originProjectId,
      originProjectTitle: "Edits",
      exchangeId: ExchangeId.make("exchange:edits"),
      message: body,
    }),
    formatPeerEnvelope({ senderId, originProjectId, exchangeId: null, message: body }),
    formatClosedPeerEnvelope({ senderId, originProjectId, message: body }),
  ]) {
    const envelope = splitDeliveryEnvelope(text, senderId);
    assert.equal(envelope?.body, body);
    assert.equal(`${envelope?.prefix}${body}${envelope?.suffix}`, text);
  }
});

it("keeps a line a shared conversation put above the header, and refuses a rewritten header", () => {
  const envelope = formatPeerEnvelope({
    senderId,
    originProjectId,
    exchangeId: null,
    message: "Body",
  });
  const stamped = `[Message from Sam (owner)]\n\n${envelope}`;
  const header = envelope.slice(0, envelope.indexOf("\n\n") + 2);
  assert.deepEqual(splitDeliveryEnvelope(stamped, senderId), {
    prefix: `[Message from Sam (owner)]\n\n${header}`,
    body: "Body",
    suffix: envelope.slice(header.length + "Body".length),
  });
  assert.isUndefined(splitDeliveryEnvelope("Body only, the envelope removed", senderId));
  assert.isUndefined(
    splitDeliveryEnvelope(envelope.replace(senderId, "agent:someone-else"), senderId),
  );
});
