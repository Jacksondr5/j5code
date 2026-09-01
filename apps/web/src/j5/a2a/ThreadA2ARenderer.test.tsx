import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "~/types";
import {
  formatTimeSinceSent,
  J5_A2A_DELIVERY_MESSAGE_PREFIX,
  isThreadA2ADeliveryMessage,
  presentThreadA2AOutboundTool,
  presentThreadA2ADelivery,
  renderThreadA2AOutboundTool,
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

const closedInstruction =
  "The platform closed this exchange when this reply was sent. No further reply is required.";

const peerClosedRaw = [
  "[Cross-agent message from agent:delivery-sender in squadron squadron:alpha]",
  "",
  "Peer reply delivered verbatim.",
  "",
  closedInstruction,
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

const humanClosedRaw = [
  "[Message from human:viewer]",
  "",
  "Human reply delivered verbatim.",
  "",
  closedInstruction,
].join("\n");

const silenceRaw = [
  "[Cross-agent messaging system notice: turn-ended-no-reply]",
  "",
  "agent:counterpart's turn ended without replying on exchange:one. The latest delivered message was processed.",
  "",
  "This is a platform-authored delivery signal, not a peer reply.",
].join("\n");

describe("ThreadA2ADeliveryRenderer", () => {
  it("renders the peer exchange badge inline beside the sender without protocol metadata", () => {
    const source = message({ text: peerRaw });
    const parsed = presentThreadA2ADelivery({
      message: source,
      participantLabels: new Map([["agent:delivery-sender", "Alice"]]),
    });
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={source}
        participantLabels={new Map([["agent:delivery-sender", "Alice"]])}
        now={Date.parse(CREATED_AT) + 5 * 60_000}
      />,
    );

    expect(parsed).toMatchObject({
      kind: "peer",
      senderId: "agent:delivery-sender",
      senderLabel: "Alice",
      squadronId: "squadron:alpha",
      body: "Please verify the worker.",
      exchange: "expects-reply",
      exchangeId: "exchange:one",
      rawEnvelope: peerRaw,
    });
    expect(markup).toContain('data-j5-a2a-renderer="peer"');
    expect(markup).toContain("From");
    expect(markup).toContain("Alice");
    expect(markup).toContain("Expects reply");
    expect(markup).toContain(">5m<");
    expect(markup).toContain('dateTime="2026-08-29T12:00:00.000Z"');
    expect(markup).toContain("line-clamp-2");
    expect(markup).not.toContain("squadron:alpha");
    expect(markup).not.toContain("exchange:one");
    expect(markup).not.toContain("Show raw envelope");
    expect(parsed?.rawEnvelope).toBe(peerRaw);
  });

  it("falls back to the literal participant id before B6 supplies a label", () => {
    const parsed = presentThreadA2ADelivery({ message: message({ text: peerRaw }) });
    expect(parsed).toMatchObject({ kind: "peer", senderLabel: "agent:delivery-sender" });
  });

  it("renders no chip for a one-shot delivery whose role is not a measured reply", () => {
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer message={message({ text: peerPlainRaw })} />,
    );

    expect(markup).not.toContain("Reply");
    expect(markup).not.toContain("plain");
    expect(markup).not.toContain("closed");
  });

  it("renders the exact v13 peer reply as a closed exchange without reply instructions", () => {
    const source = message({ id: deliveryId("peer-closed"), text: peerClosedRaw });
    const presentation = presentThreadA2ADelivery({ message: source });
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentation).toMatchObject({
      kind: "peer",
      body: "Peer reply delivered verbatim.",
      exchange: "closed",
      exchangeId: null,
    });
    expect(markup).toContain("Closed your exchange");
    expect(markup).not.toContain("Expects reply");
    expect(markup).not.toContain(closedInstruction);
    expect(markup).not.toContain("send_message");
    expect(markup).not.toContain("Show raw envelope");
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

  it("renders the exact v13 human reply as a closed exchange without reply instructions", () => {
    const source = message({
      id: deliveryId("human-closed"),
      createdBy: "user",
      text: humanClosedRaw,
    });
    const presentation = presentThreadA2ADelivery({ message: source });
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer
        message={source}
        resolveViewerParticipantId={() => "human:viewer"}
      />,
    );

    expect(presentation).toMatchObject({
      kind: "human",
      senderId: "human:viewer",
      body: "Human reply delivered verbatim.",
      exchange: "closed",
    });
    expect(markup).toContain("You · via Inbox");
    expect(markup).toContain("Closed your exchange");
    expect(markup).not.toContain("Expects reply");
    expect(markup).not.toContain(closedInstruction);
    expect(markup).not.toContain("send_message");
    expect(markup).not.toContain("Show raw envelope");
  });

  it.each([
    [
      "peer",
      message({
        id: deliveryId("peer-future-closed"),
        text: peerClosedRaw.replace("No further reply is required.", "This exchange is complete."),
      }),
    ],
    [
      "human",
      message({
        id: deliveryId("human-future-closed"),
        createdBy: "user",
        text: humanClosedRaw.replace("No further reply is required.", "This exchange is complete."),
      }),
    ],
  ] as const)("raw-renders a future %s closed instruction instead of guessing", (_kind, source) => {
    const presentation = presentThreadA2ADelivery({ message: source });
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentation).toEqual({ kind: "raw", rawEnvelope: source.text });
    expect(markup).toContain('data-j5-a2a-renderer="raw"');
    expect(markup).toContain("Show raw envelope");
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

  it("renders a silence notice as a muted platform line without a raw expander", () => {
    const source = message({ id: deliveryId("silence"), createdBy: "system", text: silenceRaw });
    const markup = renderToStaticMarkup(
      <ThreadA2ADeliveryRenderer message={source} timestampLabel={TIMESTAMP_LABEL} />,
    );

    expect(markup).toContain('data-j5-a2a-renderer="silence"');
    expect(markup).toContain("agent:counterpart");
    expect(markup).toContain("turn ended without replying");
    expect(markup).toContain(TIMESTAMP_LABEL);
    expect(markup).not.toContain("Show raw envelope");
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
    ["peer", message({ text: peerRaw })],
    ["peer closed", message({ id: deliveryId("peer-closed-parsed"), text: peerClosedRaw })],
    ["human", message({ id: deliveryId("human-parsed"), createdBy: "user", text: humanRaw })],
    [
      "human closed",
      message({ id: deliveryId("human-closed-parsed"), createdBy: "user", text: humanClosedRaw }),
    ],
    [
      "silence",
      message({ id: deliveryId("silence-parsed"), createdBy: "system", text: silenceRaw }),
    ],
  ] as const)("keeps parsed %s cards free of raw-envelope expanders", (_kind, source) => {
    const markup = renderToStaticMarkup(<ThreadA2ADeliveryRenderer message={source} />);

    expect(presentThreadA2ADelivery({ message: source })?.kind).not.toBe("raw");
    expect(markup).not.toContain("Show raw envelope");
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
    expect(markup).toContain("Show raw envelope");
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

  it("formats sent time from the delivery record at a supplied clock instant", () => {
    const sentAt = "2026-08-29T12:00:00.000Z";
    expect(formatTimeSinceSent(sentAt, Date.parse(sentAt) + 59_000)).toBe("just now");
    expect(formatTimeSinceSent(sentAt, Date.parse(sentAt) + 5 * 60_000)).toBe("5m");
    expect(formatTimeSinceSent(sentAt, Date.parse(sentAt) + 3 * 60 * 60_000)).toBe("3h");
    expect(formatTimeSinceSent(sentAt, Date.parse(sentAt) + 2 * 24 * 60 * 60_000)).toBe("2d");
  });

  it("renders an accepted, completed J5 send as an awaiting-reply card", () => {
    const tool = {
      id: "tool:send-open",
      createdAt: CREATED_AT,
      toolLifecycleStatus: "completed",
      structuredPayload: {
        type: "dynamic_tool",
        toolName: "t3-code.send_message",
        input: { to: "agent:receiver", message: "Please check the deployment." },
        output: {
          messageId: "message:j5:a2a:send-open",
          exchangeId: "exchange:send-open",
          exchangeState: "open",
          joinedExistingExchange: false,
          durableAtSeq: 1,
        },
      },
    };
    const presentation = presentThreadA2AOutboundTool(tool);
    const markup = renderToStaticMarkup(renderThreadA2AOutboundTool(tool) ?? <p>generic</p>);

    expect(presentation).toMatchObject({
      kind: "sent",
      recipientId: "agent:receiver",
      body: "Please check the deployment.",
      exchangeId: "exchange:send-open",
      exchangeState: "open",
      isReply: false,
    });
    expect(markup).toContain('data-j5-a2a-renderer="sent"');
    expect(markup).toContain("To");
    expect(markup).toContain("agent:receiver");
    expect(markup).toContain("Awaiting reply");
    expect(markup).not.toContain("exchange:send-open");
  });

  it("renders an accepted closed exchange reply with the neutral Reply chip", () => {
    const tool = {
      id: "tool:reply-closed",
      createdAt: CREATED_AT,
      toolLifecycleStatus: "completed",
      structuredPayload: {
        type: "dynamic_tool",
        toolName: "mcp__t3-code__send_message",
        input: {
          to: "agent:sender",
          message: "Deployment verified.",
          exchange_id: "exchange:ask",
        },
        output: {
          messageId: "message:j5:a2a:reply-closed",
          exchangeId: "exchange:ask",
          exchangeState: "closed",
          joinedExistingExchange: false,
          durableAtSeq: 2,
        },
      },
    };
    const markup = renderToStaticMarkup(renderThreadA2AOutboundTool(tool) ?? <p>generic</p>);

    expect(markup).toContain('data-j5-a2a-renderer="sent"');
    expect(markup).toContain(">Reply<");
    expect(markup).not.toContain("Awaiting reply");
  });

  it("leaves a non-send dynamic tool untouched by the outbound delegate", () => {
    const tool = {
      id: "tool:list-participants",
      createdAt: CREATED_AT,
      toolLifecycleStatus: "completed",
      structuredPayload: {
        type: "dynamic_tool",
        toolName: "t3-code.list_participants",
        input: {},
        output: {},
      },
    };
    const rendered = renderThreadA2AOutboundTool(tool);
    const markup = renderToStaticMarkup(rendered ?? <p data-generic-work-row="true">generic</p>);

    expect(rendered).toBeNull();
    expect(markup).toContain('data-generic-work-row="true"');
    expect(markup).not.toContain("data-j5-a2a-renderer");
  });

  it("leaves a malformed send tool untouched rather than hiding or guessing", () => {
    const tool = {
      id: "tool:send-malformed",
      createdAt: CREATED_AT,
      toolLifecycleStatus: "completed",
      structuredPayload: {
        type: "dynamic_tool",
        toolName: "t3-code.send_message",
        input: { to: "agent:receiver", message: "Could be a send." },
        output: { messageId: "message:j5:a2a:malformed", exchangeState: "open" },
      },
    };
    const rendered = renderThreadA2AOutboundTool(tool);
    const markup = renderToStaticMarkup(rendered ?? <p data-generic-work-row="true">generic</p>);

    expect(rendered).toBeNull();
    expect(markup).toContain('data-generic-work-row="true"');
    expect(markup).not.toContain("data-j5-a2a-renderer");
  });
});
