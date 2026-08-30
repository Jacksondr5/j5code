import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "~/types";
import {
  J5_A2A_DELIVERY_MESSAGE_PREFIX,
  isThreadA2ADeliveryMessage,
  presentThreadA2ADelivery,
  renderThreadA2ADelivery,
  ThreadA2ADeliveryRenderer,
} from "./ThreadA2ARenderer";

const CREATED_AT = "2026-08-29T12:00:00.000Z";
const TIMESTAMP_LABEL = "Today, 8:00 AM";
const deliveryId = (suffix: string) => MessageId.make(`${J5_A2A_DELIVERY_MESSAGE_PREFIX}${suffix}`);

function message(input: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: deliveryId("peer"),
    role: "user",
    text: "",
    runId: null,
    streaming: false,
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input,
  };
}

const peerRaw = [
  "[Cross-agent message from agent:delivery-sender in squadron squadron:alpha]",
  "",
  "Please verify the worker.",
  "",
  'Reply once with send_message(to="agent:delivery-sender", exchange_id="exchange:one", message="...") to close the exchange. Follow-ups from the asker carrying this id join the same exchange.',
].join("\n");

const peerPlainRaw = [
  "[Cross-agent message from agent:delivery-sender in squadron squadron:alpha]",
  "",
  "Nothing further is needed.",
  "",
  "No reply is required. Use send_message without exchange_id only if a new message is needed.",
].join("\n");

const humanRaw = [
  "[Message from human:viewer]",
  "",
  "Please prioritize the alert.",
  "",
  "This person is not watching this chat. They see only what you send back on this exchange.",
  "",
  'Reply once with send_message(to="human:viewer", exchange_id="exchange:human", message="...") to close the exchange. Follow-ups from the asker carrying this id join the same exchange.',
].join("\n");

const silenceRaw = [
  "[Cross-agent messaging system notice: turn-ended-no-reply]",
  "",
  "agent:counterpart's turn ended without replying on exchange:one. The latest delivered message was processed.",
  "",
  "This is a platform-authored delivery signal, not a peer reply.",
].join("\n");

describe("ThreadA2ADeliveryRenderer", () => {
  it("renders a peer block with an exchange chip and byte-preserved raw envelope", () => {
    const source = message({ text: peerRaw });
    const parsed = presentThreadA2ADelivery({
      message: source,
      participantLabels: new Map([["agent:delivery-sender", "Alice"]]),
    });
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={source}
        participantLabels={new Map([["agent:delivery-sender", "Alice"]])}
      />,
    );

    expect(parsed).toMatchObject({
      kind: "peer",
      senderId: "agent:delivery-sender",
      senderLabel: "Alice",
      squadronId: "squadron:alpha",
      body: "Please verify the worker.",
      exchange: "expects-reply",
      rawEnvelope: peerRaw,
    });
    expect(markup).toContain('data-j5-a2a-renderer="peer"');
    expect(markup).toContain("expects your reply");
    expect(markup).toContain("Show raw envelope");
    expect(parsed?.rawEnvelope).toBe(peerRaw);
  });

  it("falls back to the literal participant id before B6 supplies a label", () => {
    const parsed = presentThreadA2ADelivery({ message: message({ text: peerRaw }) });
    expect(parsed).toMatchObject({ kind: "peer", senderLabel: "agent:delivery-sender" });
  });

  it("renders only the plain exchange state when no reply is expected", () => {
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer message={message({ text: peerPlainRaw })} />,
    );

    expect(markup).toContain(">plain<");
    expect(markup).not.toContain("closed");
  });

  it("renders a #11 human inbox reply with a literal id until local identity is proven", () => {
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={message({ id: deliveryId("human"), createdBy: "user", text: humanRaw })}
      />,
    );

    expect(markup).toContain('data-j5-a2a-renderer="human"');
    expect(markup).toContain("Via Inbox · human:viewer");
    expect(markup).toContain("Please prioritize the alert.");
  });

  it("uses You only when the caller proves the viewer matches the sender", () => {
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={message({ id: deliveryId("human-local"), createdBy: "user", text: humanRaw })}
        resolveViewerParticipantId={() => "human:viewer"}
      />,
    );

    expect(markup).toContain("You · via Inbox");
  });

  it("raw-renders the older v6 human template instead of treating it as #11", () => {
    const raw = [
      "[Message from the human]",
      "",
      "Legacy human delivery.",
      "",
      "The human is not watching this chat. They see only what you send back on this exchange.",
      "",
      "No reply is required. Use send_message without exchange_id only if a new message is needed.",
    ].join("\n");

    expect(
      presentThreadA2ADelivery({
        message: message({ id: deliveryId("human-v6"), createdBy: "user", text: raw }),
      }),
    ).toEqual({ kind: "raw", rawEnvelope: raw });
  });

  it("renders a silence notice as a muted, expandable platform line", () => {
    const source = message({ id: deliveryId("silence"), createdBy: "system", text: silenceRaw });
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer message={source} timestampLabel={TIMESTAMP_LABEL} />,
    );

    expect(markup).toContain('data-j5-a2a-renderer="silence"');
    expect(markup).toContain("agent:counterpart");
    expect(markup).toContain("turn ended without replying");
    expect(markup).toContain(TIMESTAMP_LABEL);
    expect(markup).toContain("Show raw envelope");
    expect(presentThreadA2ADelivery({ message: source })).toMatchObject({
      kind: "silence",
      summary: "agent:counterpart's turn ended without replying",
      rawEnvelope: silenceRaw,
    });
    const summary = markup.match(/<span data-j5-a2a-silence-summary="true">(.*?)<\/span>/)?.[1];
    expect(summary).toBeDefined();
    expect(summary).not.toContain("turn-ended-no-reply");
    expect(summary).not.toContain(CREATED_AT);
  });

  it.each([
    [
      "errored",
      "agent:counterpart errored without replying on exchange:one: socket closed",
      "agent:counterpart errored without replying",
    ],
    [
      "stopped/cancelled",
      "agent:counterpart was interrupted without replying on exchange:one. The participant was interrupted.",
      "agent:counterpart was interrupted without replying",
    ],
    [
      "stopped/cancelled",
      "agent:counterpart was cancelled without replying on exchange:one. The participant was cancelled.",
      "agent:counterpart was cancelled without replying",
    ],
    [
      "stopped/cancelled",
      "agent:counterpart was rolled_back without replying on exchange:one. The participant was rolled back.",
      "agent:counterpart was rolled_back without replying",
    ],
    [
      "awaiting-human",
      "agent:counterpart is awaiting the human on exchange:human (awaiting-human).",
      "agent:counterpart is awaiting the human",
    ],
    [
      "blocked-on-peer",
      "agent:counterpart is blocked on agent:peer via exchange:peer.",
      "agent:counterpart is blocked on agent:peer",
    ],
  ])("maps known %s detector text to a truthful human summary", (noticeType, body, summary) => {
    const raw = [
      `[Cross-agent messaging system notice: ${noticeType}]`,
      "",
      body,
      "",
      "This is a platform-authored delivery signal, not a peer reply.",
    ].join("\n");

    expect(
      presentThreadA2ADelivery({
        message: message({
          id: deliveryId(`silence-${noticeType}`),
          createdBy: "system",
          text: raw,
        }),
      }),
    ).toMatchObject({ kind: "silence", summary, rawEnvelope: raw });
  });

  it("raw-renders an unrecognized silence body rather than guessing its counterpart", () => {
    const raw = [
      "[Cross-agent messaging system notice: turn-ended-no-reply]",
      "",
      "Future detector wording without a structural counterpart.",
      "",
      "This is a platform-authored delivery signal, not a peer reply.",
    ].join("\n");
    const source = message({ id: deliveryId("silence-future"), createdBy: "system", text: raw });
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentThreadA2ADelivery({ message: source })).toEqual({
      kind: "raw",
      rawEnvelope: raw,
    });
    expect(markup).toContain(raw);
    expect(markup).toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  });

  it("raw-renders a stopped/cancelled body outside the production lifecycle forms", () => {
    const raw = [
      "[Cross-agent messaging system notice: stopped/cancelled]",
      "",
      "agent:counterpart was stopped without replying on exchange:one. The participant was stopped.",
      "",
      "This is a platform-authored delivery signal, not a peer reply.",
    ].join("\n");
    const source = message({
      id: deliveryId("silence-stopped-mismatch"),
      createdBy: "system",
      text: raw,
    });

    expect(presentThreadA2ADelivery({ message: source })).toEqual({
      kind: "raw",
      rawEnvelope: raw,
    });
  });

  it("raw-renders an unknown silence type instead of exposing its slug", () => {
    const raw = [
      "[Cross-agent messaging system notice: future-detector-v7]",
      "",
      "agent:counterpart's turn ended without replying on exchange:one. The latest delivered message was processed.",
      "",
      "This is a platform-authored delivery signal, not a peer reply.",
    ].join("\n");
    const source = message({
      id: deliveryId("silence-type-future"),
      createdBy: "system",
      text: raw,
    });

    expect(presentThreadA2ADelivery({ message: source })).toEqual({
      kind: "raw",
      rawEnvelope: raw,
    });
  });

  it("raw-renders a future or malformed delivery instead of hiding it", () => {
    const raw =
      "[Cross-agent message from agent:delivery-sender in squadron squadron:alpha]\n\nFuture envelope v7";
    const source = message({ text: raw });
    const presentation = presentThreadA2ADelivery({ message: source });
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentation).toEqual({ kind: "raw", rawEnvelope: raw });
    expect(markup).toContain('data-j5-a2a-renderer="raw"');
    expect(markup).toContain(raw);
    expect(markup).toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  });

  it("uses only user role and the exact delivery prefix as its composition gate", () => {
    const { createdBy: _discardedCreator, ...unknownCreator } = message({
      creationSource: "provider",
    });
    expect(isThreadA2ADeliveryMessage(unknownCreator)).toBe(true);
    expect(presentThreadA2ADelivery({ message: unknownCreator })).toEqual({
      kind: "raw",
      rawEnvelope: "",
    });
    expect(isThreadA2ADeliveryMessage(message({ role: "assistant" }))).toBe(false);
    expect(isThreadA2ADeliveryMessage(message({ id: MessageId.make("message:ordinary") }))).toBe(
      false,
    );
  });

  it.each([
    "message:mcp:provider-session:thread-send:delivery",
    "message:delegated-task:parent:child",
    "scheduled-task-message:task:run",
  ])("returns null so generic rendering owns non-A2A %s messages", (id) => {
    const nativeMcpMessage = message({
      id: MessageId.make(id),
      createdBy: "agent",
      creationSource: "mcp",
      text: peerRaw,
    });
    const delegated = renderThreadA2ADelivery({ message: nativeMcpMessage });
    const markup = renderToStaticMarkup(
      delegated ?? <p data-generic-user-row="true">generic user row</p>,
    );

    expect(isThreadA2ADeliveryMessage(nativeMcpMessage)).toBe(false);
    expect(delegated).toBeNull();
    expect(markup).toContain('data-generic-user-row="true"');
    expect(markup).not.toContain("data-j5-a2a-renderer");
  });
});
