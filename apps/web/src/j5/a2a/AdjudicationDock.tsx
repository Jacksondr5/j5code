import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { ChevronRightIcon } from "lucide-react";
import { useRef, useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { ComposerBanner } from "../../components/chat/ComposerBanner";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { useCrewMembership } from "../crew/CrewMembershipsClient";
import { j5Environment, openInboxQueryAtom } from "../state";
import {
  adjudicationAsks,
  commandsACrew,
  hasMoreThanExcerpt,
  isAskAlreadyClosed,
  pickShownAsk,
} from "@t3tools/client-runtime/j5/adjudication-dock";
import {
  AnswerAttachButton,
  AnswerAttachmentList,
  answerAttachmentInputHandlers,
  useAnswerAttachmentSupport,
  useAnswerAttachments,
} from "./AnswerAttachments";
import { J5RecordPanel } from "./J5RecordPanel";
import { OwnerAskAction } from "./OwnerAskAction";
import { answerHumanExchange, type HumanInboxItem } from "./humanInboxClient";
import { inboxAnswerDrafts, inboxAnswerText, setInboxAnswerText } from "./inboxAnswerDrafts";
import { useComposerDraftStore } from "../../composerDraftStore";
import { scopedInboxItemKey } from "@t3tools/contracts/j5";
import { notifyHumanInboxChanged } from "./humanInboxRefresh";

const urgencyBadge = {
  blocking: { label: "Blocking", variant: "destructive" },
  soon: { label: "Soon", variant: "warning" },
  fyi: { label: "FYI", variant: "secondary" },
} as const;

/**
 * A Captain's open asks to the person, pinned above its composer the way a Crew proposal is.
 * They are the Inbox's own asks, read from the same list and answered through the same command,
 * so answering here or there closes the one exchange and the other view follows the read-change
 * feed (Crews: adjudication request).
 */
export function AdjudicationDock(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | null | undefined;
}) {
  const { environmentId, threadId } = props;
  const captain = commandsACrew(
    useCrewMembership(
      environmentId === undefined || threadId == null
        ? undefined
        : scopeThreadRef(environmentId, threadId),
    ),
  );
  const query = useEnvironmentQuery(
    captain && environmentId !== undefined ? openInboxQueryAtom(environmentId) : null,
  );
  const mayAnswer = useAtomValue(
    j5Environment.answerHumanExchange.permissionAtom(environmentId ?? null),
  );
  // The same saved draft the Inbox page shows for this ask, so words typed in either place stay.
  const drafts = inboxAnswerDrafts(useComposerDraftStore((state) => state.draftsByThreadKey));
  const keyOf = (item: HumanInboxItem) =>
    environmentId === undefined ? "" : scopedInboxItemKey({ ...item, environmentId });
  const wordsOf = (item: HumanInboxItem) => {
    const draft = drafts.get(keyOf(item));
    return draft === undefined ? "" : inboxAnswerText(draft);
  };
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<ReadonlyArray<HumanInboxItem>>([]);
  const attempt = useRef<{
    exchangeId: string;
    message: string;
    attachmentIds: string;
    clientRequestId: string;
  } | null>(null);
  const attachments = useAnswerAttachments();
  const support = useAnswerAttachmentSupport(environmentId);

  const asks = adjudicationAsks({
    items: query.data?.items ?? [],
    refused,
    threadId,
    hasWords: (exchangeId) => {
      const item = [...(query.data?.items ?? []), ...refused].find(
        (candidate) => candidate.exchangeId === exchangeId,
      );
      return item !== undefined && wordsOf(item) !== "";
    },
  });
  const view = pickShownAsk(asks, picked);
  if (!captain || !mayAnswer || environmentId === undefined || view === null) return null;
  const { shown, others, next: nextAsk } = view;
  const isOpen = (query.data?.items ?? []).some((item) => item.exchangeId === shown.exchangeId);
  const answerKey = keyOf(shown);
  const message = wordsOf(shown);
  const urgency = urgencyBadge[shown.urgency];
  const openFor = formatElapsedDurationLabel(shown.openedAt);
  const threadRef = threadId == null ? undefined : scopeThreadRef(environmentId, threadId);

  const readiness = attachments.ready(answerKey, environmentId);
  const waitingOn = "blocked" in readiness ? readiness.blocked : null;
  const addFiles =
    support === null || !isOpen || pending
      ? null
      : (files: ReadonlyArray<File>) =>
          attachments.add(answerKey, environmentId, support.maxFileBytes, files);
  const answerId = `adjudication-answer-${encodeURIComponent(shown.exchangeId)}`;

  const answer = async () => {
    if (message === "" || "blocked" in readiness) return;
    const attachmentIds = readiness.attachments.map((attachment) => attachment.id).join("\n");
    // A retry of the same words and files reuses its request id, so a lost reply cannot answer twice.
    const request =
      attempt.current?.exchangeId === shown.exchangeId &&
      attempt.current.message === message &&
      attempt.current.attachmentIds === attachmentIds
        ? attempt.current
        : { exchangeId: shown.exchangeId, message, attachmentIds, clientRequestId: randomUUID() };
    attempt.current = request;
    setPending(true);
    setError(null);
    try {
      await answerHumanExchange(environmentId, {
        exchangeId: request.exchangeId,
        message: request.message,
        ...(readiness.attachments.length === 0 ? {} : { attachments: readiness.attachments }),
        clientRequestId: request.clientRequestId,
      });
      attempt.current = null;
      attachments.delivered(answerKey);
      notifyHumanInboxChanged(environmentId);
      query.refresh();
    } catch (cause) {
      if (isAskAlreadyClosed(cause)) {
        setRefused((current) => [...current, shown]);
        query.refresh();
      } else {
        setError(cause instanceof Error ? cause.message : "Could not deliver the answer.");
      }
    }
    setPending(false);
  };

  const questionText = (text: string) => (
    <div className={expanded.has(shown.exchangeId) ? "text-sm" : "line-clamp-3 text-sm"}>
      <ChatMarkdown
        cwd={undefined}
        environmentId={environmentId}
        lineBreaks={shouldPreserveAssistantLineBreaks(text)}
        text={text}
        threadRef={threadRef}
      />
    </div>
  );
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-testid="adjudication-dock">
        <div className="flex flex-col gap-2 px-2 py-1">
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span>Question for you</span>
            {openFor ? <span>· open {openFor}</span> : null}
            <Badge variant={urgency.variant}>
              <span className="uppercase tracking-wide">{urgency.label}</span>
            </Badge>
          </div>
          <h3 className="text-sm font-semibold leading-snug text-foreground">{shown.intent}</h3>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {questionText(shown.message)}
            {shown.escalation === undefined ? null : (
              <J5RecordPanel text={shown.escalation.summary} />
            )}
            {shown.personaDraft === undefined ? null : (
              <J5RecordPanel text={shown.personaDraft.summary} />
            )}
            {shown.followUps?.map((followUp) => (
              <div className="flex flex-col gap-1" key={followUp.messageId}>
                <p className="text-xs font-medium text-muted-foreground">Follow-up</p>
                {questionText(followUp.message)}
              </div>
            ))}
          </div>
          {hasMoreThanExcerpt(shown.message) ||
          shown.followUps?.some((followUp) => hasMoreThanExcerpt(followUp.message)) ? (
            <Button
              className="w-fit"
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (!next.delete(shown.exchangeId)) next.add(shown.exchangeId);
                  return next;
                })
              }
              size="xs"
              type="button"
              variant="ghost"
            >
              {expanded.has(shown.exchangeId) ? "Show less" : "Show full question"}
            </Button>
          ) : null}
          <Textarea
            aria-label={`Answer ${shown.intent}`}
            className="min-h-9"
            id={answerId}
            onChange={(event) => setInboxAnswerText(answerKey, event.currentTarget.value)}
            placeholder="Type the answer exactly as it should be delivered"
            value={message}
            {...(addFiles === null ? {} : answerAttachmentInputHandlers(addFiles))}
          />
          <AnswerAttachmentList
            answerKey={answerKey}
            attachments={attachments.list(answerKey)}
            environmentId={environmentId}
            error={attachments.error(answerKey)}
            onRemove={pending ? null : (id) => attachments.remove(answerKey, id)}
          />
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            {addFiles === null ? null : (
              <AnswerAttachButton
                focusAnswer={() => document.getElementById(answerId)?.focus()}
                onFiles={addFiles}
              />
            )}
            {isOpen ? (
              <OwnerAskAction
                // One instance per ask, so an error or request id never carries to the next.
                key={shown.exchangeId}
                disabled={pending}
                environmentId={environmentId}
                item={shown}
                onDone={query.refresh}
                size="sm"
              />
            ) : null}
            {isOpen ? (
              <Button
                disabled={pending || message === "" || waitingOn !== null}
                onClick={() => void answer()}
                size="sm"
                title={waitingOn ?? undefined}
                type="button"
              >
                {pending ? "Delivering…" : "Answer"}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground" data-j5-adjudication="closed">
                Already answered
              </p>
            )}
          </div>
          {nextAsk !== null ? (
            <Button
              className="w-full justify-start"
              onClick={() => setPicked(nextAsk.exchangeId)}
              type="button"
              variant="outline"
            >
              <span className="shrink-0">
                {others.length} more {others.length === 1 ? "question" : "questions"}
              </span>
              <span className="min-w-0 flex-1 truncate text-start text-muted-foreground">
                · {nextAsk.intent}
              </span>
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
            </Button>
          ) : null}
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
