import type { ChatMessage } from "~/types";
import type { ReactNode } from "react";

/**
 * `deliveryMessageId` in the server A2A transport is deliberately stable across
 * retries. The upstream composition seam requires this exact prefix and a user
 * role; envelope-looking text alone is never A2A UI.
 */
export const J5_A2A_DELIVERY_MESSAGE_PREFIX = "message:j5:a2a:delivery:";

const PLAIN_DELIVERY_INSTRUCTION =
  "No reply is required. Use send_message without exchange_id only if a new message is needed.";
const REPLY_DELIVERY_INSTRUCTION_SUFFIX =
  '", message="...") to close the exchange. Follow-ups from the asker carrying this id join the same exchange.';
const HUMAN_DELIVERY_MARKER =
  "\n\nThis person is not watching this chat. They see only what you send back on this exchange.\n\n";
const SILENCE_DELIVERY_SUFFIX =
  "\n\nThis is a platform-authored delivery signal, not a peer reply.";

export interface ThreadA2ADeliveryCompositionInput {
  readonly message: ChatMessage;
  /**
   * Preformatted by the surrounding timeline. This renderer deliberately has
   * no clock or formatter so its notice dialect always matches that timeline.
   */
  readonly timestampLabel?: string | undefined;
  /**
   * Optional B6 read result. Until B6 supplies it, the participant id itself
   * is the intentional, non-invented display label.
   */
  readonly participantLabels?: ReadonlyMap<string, string> | undefined;
  /** The caller supplies this only when it can prove the authenticated viewer. */
  readonly resolveViewerParticipantId?: (() => string | null) | undefined;
}

export type ThreadA2ADeliveryPresentation =
  | {
      readonly kind: "peer";
      readonly rawEnvelope: string;
      readonly senderId: string;
      readonly senderLabel: string;
      readonly squadronId: string;
      readonly body: string;
      readonly exchange: "expects-reply" | "plain";
    }
  | {
      readonly kind: "human";
      readonly rawEnvelope: string;
      readonly senderId: string;
      readonly body: string;
    }
  | {
      readonly kind: "silence";
      readonly rawEnvelope: string;
      readonly summary: string;
    }
  | {
      readonly kind: "raw";
      readonly rawEnvelope: string;
    };

/**
 * Transport identity is intentionally the only composition gate. Creator and
 * source values describe a known delivery after it enters this renderer; they
 * must not make a delivery disappear from the raw fallback.
 */
export function isThreadA2ADeliveryMessage(message: ChatMessage): boolean {
  return message.role === "user" && String(message.id).startsWith(J5_A2A_DELIVERY_MESSAGE_PREFIX);
}

function parseKnownInstruction(input: {
  readonly senderId: string;
  readonly instruction: string;
}): "expects-reply" | "plain" | null {
  if (input.instruction === PLAIN_DELIVERY_INSTRUCTION) return "plain";

  const replyPrefix = `Reply once with send_message(to="${input.senderId}", exchange_id="`;
  if (!input.instruction.startsWith(replyPrefix)) return null;
  const exchangeIdAndSuffix = input.instruction.slice(replyPrefix.length);
  const separatorIndex = exchangeIdAndSuffix.indexOf(REPLY_DELIVERY_INSTRUCTION_SUFFIX);
  if (separatorIndex <= 0) return null;
  if (
    exchangeIdAndSuffix.slice(separatorIndex + REPLY_DELIVERY_INSTRUCTION_SUFFIX.length).length !==
    0
  ) {
    return null;
  }
  return "expects-reply";
}

function parsePeerEnvelope(rawEnvelope: string) {
  const header = /^\[Cross-agent message from ([^\]\n]+) in squadron ([^\]\n]+)\]\n\n/.exec(
    rawEnvelope,
  );
  if (!header) return null;

  const senderId = header[1]!;
  const squadronId = header[2]!;
  const content = rawEnvelope.slice(header[0].length);
  const divider = content.lastIndexOf("\n\n");
  if (divider <= 0) return null;
  const body = content.slice(0, divider);
  const exchange = parseKnownInstruction({
    senderId,
    instruction: content.slice(divider + 2),
  });
  return exchange === null ? null : { senderId, squadronId, body, exchange };
}

function parseHumanEnvelope(rawEnvelope: string) {
  // #11 c487cf8's exact template. The older v6 literal header remains raw.
  const header = /^\[Message from ([^\]\n]+)\]\n\n/.exec(rawEnvelope);
  if (!header) return null;

  const senderId = header[1]!;
  const content = rawEnvelope.slice(header[0].length);
  const markerIndex = content.lastIndexOf(HUMAN_DELIVERY_MARKER);
  if (markerIndex <= 0) return null;
  const body = content.slice(0, markerIndex);
  const instruction = content.slice(markerIndex + HUMAN_DELIVERY_MARKER.length);
  return parseKnownInstruction({ senderId, instruction }) === null ? null : { senderId, body };
}

function counterpartSummary(counterpartId: string, suffix: string): string | null {
  const counterpart = counterpartId.trim();
  return counterpart ? `${counterpart}${suffix}` : null;
}

function parseSilenceSummary(noticeType: string, body: string): string | null {
  if (noticeType === "turn-ended-no-reply") {
    const neverProcessed = /^(.+?) did not start a turn for the delivered message on [^.]+\.$/.exec(
      body,
    );
    if (neverProcessed)
      return counterpartSummary(
        neverProcessed[1]!,
        " did not start a turn for the delivered message",
      );

    const processed =
      /^(.+?)'s turn ended without replying on [^.]+\. The latest delivered message was processed\.$/.exec(
        body,
      );
    return processed ? counterpartSummary(processed[1]!, "'s turn ended without replying") : null;
  }

  if (noticeType === "errored") {
    const match = /^(.+?) errored without replying on .+: .+$/.exec(body);
    return match ? counterpartSummary(match[1]!, " errored without replying") : null;
  }

  if (noticeType === "stopped/cancelled") {
    const match = /^(.+?) was (stopped|cancelled) without replying on [^.]+\. .+$/.exec(body);
    return match ? counterpartSummary(match[1]!, ` was ${match[2]} without replying`) : null;
  }

  if (noticeType === "awaiting-human") {
    const match = /^(.+?) is awaiting the human on .+ \(.+\)\.$/.exec(body);
    return match ? counterpartSummary(match[1]!, " is awaiting the human") : null;
  }

  if (noticeType === "blocked-on-peer") {
    const match = /^(.+?) is blocked on (.+?) via .+\.$/.exec(body);
    return match ? counterpartSummary(match[1]!, ` is blocked on ${match[2]!.trim()}`) : null;
  }

  return null;
}

function parseSilenceEnvelope(rawEnvelope: string) {
  const header = /^\[Cross-agent messaging system notice: ([^\]\n]+)\]\n\n/.exec(rawEnvelope);
  if (!header || !rawEnvelope.endsWith(SILENCE_DELIVERY_SUFFIX)) return null;
  const body = rawEnvelope.slice(header[0].length, -SILENCE_DELIVERY_SUFFIX.length);
  const noticeType = header[1]!;
  const summary = parseSilenceSummary(noticeType, body);
  return summary === null ? null : { summary };
}

/**
 * Strictly recognizes the current delivery templates. The transport currently
 * does not serialize its numeric envelope version into the text, so a changed
 * template is intentionally treated as unrecognized and shown raw.
 */
export function presentThreadA2ADelivery(
  input: ThreadA2ADeliveryCompositionInput,
): ThreadA2ADeliveryPresentation | null {
  const { message } = input;
  if (!isThreadA2ADeliveryMessage(message)) return null;

  if (message.createdBy === "agent") {
    const peer = parsePeerEnvelope(message.text);
    if (peer) {
      return {
        kind: "peer",
        rawEnvelope: message.text,
        senderId: peer.senderId,
        senderLabel: input.participantLabels?.get(peer.senderId) ?? peer.senderId,
        squadronId: peer.squadronId,
        body: peer.body,
        exchange: peer.exchange,
      };
    }
  } else if (message.createdBy === "user") {
    const human = parseHumanEnvelope(message.text);
    if (human) {
      return {
        kind: "human",
        rawEnvelope: message.text,
        senderId: human.senderId,
        body: human.body,
      };
    }
  } else if (message.createdBy === "system") {
    const silence = parseSilenceEnvelope(message.text);
    if (silence) {
      return {
        kind: "silence",
        rawEnvelope: message.text,
        summary: silence.summary,
      };
    }
  }

  return { kind: "raw", rawEnvelope: message.text };
}

function RawEnvelopeExpander({
  rawEnvelope,
  open = false,
}: {
  readonly rawEnvelope: string;
  readonly open?: boolean;
}) {
  return (
    <details
      className="mt-2 rounded-md border border-border/60 bg-background/55"
      open={open || undefined}
    >
      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
        Show raw envelope
      </summary>
      <pre className="overflow-x-auto border-t border-border/50 p-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {rawEnvelope}
      </pre>
    </details>
  );
}

/**
 * The upstream user-row seam calls this function directly. It deliberately
 * returns null for non-A2A messages so the existing renderer owns that path.
 */
export function renderThreadA2ADelivery(props: ThreadA2ADeliveryCompositionInput): ReactNode {
  const presentation = presentThreadA2ADelivery(props);
  if (presentation === null) return null;

  if (presentation.kind === "peer") {
    return (
      <section
        className="rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5"
        data-j5-a2a-renderer="peer"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="font-medium">{presentation.senderLabel}</span>
          <span className="text-muted-foreground">{presentation.squadronId}</span>
          <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {presentation.exchange === "expects-reply" ? "expects your reply" : "plain"}
          </span>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm">{presentation.body}</p>
        <RawEnvelopeExpander rawEnvelope={presentation.rawEnvelope} />
      </section>
    );
  }

  if (presentation.kind === "human") {
    const viewerParticipantId = props.resolveViewerParticipantId?.() ?? null;
    const attribution =
      viewerParticipantId !== null && viewerParticipantId === presentation.senderId
        ? "You · via Inbox"
        : `Via Inbox · ${presentation.senderId}`;
    return (
      <section className="rounded-lg bg-accent px-3 py-2.5" data-j5-a2a-renderer="human">
        <p className="text-xs font-medium text-muted-foreground">{attribution}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{presentation.body}</p>
      </section>
    );
  }

  if (presentation.kind === "silence") {
    return (
      <section className="text-xs text-muted-foreground" data-j5-a2a-renderer="silence">
        <span data-j5-a2a-silence-summary>
          ⚠ {presentation.summary}
          {props.timestampLabel ? ` · ${props.timestampLabel}` : null}
        </span>
        <RawEnvelopeExpander rawEnvelope={presentation.rawEnvelope} />
      </section>
    );
  }

  return (
    <section
      className="rounded-md border border-border/60 bg-muted/20 p-2.5"
      data-j5-a2a-renderer="raw"
    >
      <p className="text-xs font-medium text-muted-foreground">Raw A2A delivery</p>
      <RawEnvelopeExpander rawEnvelope={presentation.rawEnvelope} open />
    </section>
  );
}

/** Standalone component form for focused tests and future J5-owned surfaces. */
export function ThreadA2ADeliveryRenderer(props: ThreadA2ADeliveryCompositionInput) {
  return renderThreadA2ADelivery(props);
}
