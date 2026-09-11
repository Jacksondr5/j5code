import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  InboxIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { Textarea } from "../../components/ui/textarea";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { answerHumanExchange, listHumanInbox, type HumanInboxItem } from "./humanInboxClient";
import { notifyHumanInboxChanged } from "./humanInboxRefresh";
import { phaseLabel, statusPresentation } from "../workflow/presentation";
import { useWorkflowQuery, workflowListAtom } from "../workflow/queries";
import { useSquadronDirectory } from "../squadron/SquadronDirectory";

interface HumanInboxAnswerAttempt {
  readonly message: string;
  readonly clientRequestId: string;
}

type HumanInboxAnswers = Readonly<Record<string, string>>;

const urgencyPresentation = {
  blocking: { label: "Blocking", variant: "destructive" as const },
  soon: { label: "Soon", variant: "warning" as const },
  fyi: { label: "FYI", variant: "secondary" as const },
};

export const formatAnsweredAgeLabel = (elapsed: string) =>
  elapsed === "just now" ? "answered just now" : elapsed ? `answered ${elapsed} ago` : "answered";

export function captureHumanInboxAnswer(
  event: { readonly currentTarget: { readonly value: string } },
  exchangeId: string,
  setAnswers: (update: (current: HumanInboxAnswers) => HumanInboxAnswers) => void,
) {
  const value = event.currentTarget.value;
  setAnswers((current) => ({
    ...current,
    [exchangeId]: value,
  }));
}

export async function submitHumanInboxAnswer(input: {
  readonly item: HumanInboxItem;
  readonly message: string;
  readonly attempts: Map<string, HumanInboxAnswerAttempt>;
  readonly randomUUID: () => string;
  readonly send: (request: {
    readonly personId: string;
    readonly exchangeId: string;
    readonly message: string;
    readonly clientRequestId: string;
  }) => Promise<unknown>;
  readonly refresh: (personId: string) => Promise<void>;
  readonly notifyChanged: () => void;
  readonly onAccepted: () => void;
  readonly setPendingExchangeId: (exchangeId: string | null) => void;
  readonly setError: (message: string | null) => void;
}) {
  input.setPendingExchangeId(input.item.exchangeId);
  input.setError(null);
  try {
    try {
      const previousAttempt = input.attempts.get(input.item.exchangeId);
      const attempt =
        previousAttempt?.message === input.message
          ? previousAttempt
          : { message: input.message, clientRequestId: input.randomUUID() };
      input.attempts.set(input.item.exchangeId, attempt);
      await input.send({
        personId: input.item.personId,
        exchangeId: input.item.exchangeId,
        message: input.message,
        clientRequestId: attempt.clientRequestId,
      });
    } catch (cause) {
      input.setError(cause instanceof Error ? cause.message : "Could not deliver the answer.");
      return;
    }
    input.attempts.delete(input.item.exchangeId);
    input.notifyChanged();
    input.onAccepted();
    try {
      await input.refresh(input.item.personId);
    } catch {
      input.setError(
        "Answer delivered, but the inbox could not be refreshed. The list may be stale.",
      );
    }
  } finally {
    input.setPendingExchangeId(null);
  }
}

function OpenThreadButton({
  item,
  environmentAvailable,
  onOpen,
}: {
  readonly item: HumanInboxItem;
  readonly environmentAvailable: boolean;
  readonly onOpen: (item: HumanInboxItem) => void;
}) {
  const available = environmentAvailable && item.senderThreadId !== null;
  return (
    <Button
      className="w-fit gap-1.5"
      disabled={!available}
      onClick={() => onOpen(item)}
      size="sm"
      title={
        available
          ? undefined
          : item.senderThreadId === null
            ? "The sender is no longer in the active roster."
            : "No active environment is available."
      }
      type="button"
      variant="ghost"
    >
      Open thread
      <ArrowUpRightIcon aria-hidden className="size-3.5" />
    </Button>
  );
}

function OpenInboxItem({
  item,
  answer,
  answerText,
  environmentAvailable,
  pendingExchangeId,
  setAnswers,
  onOpenThread,
}: {
  readonly item: HumanInboxItem;
  readonly answer: (item: HumanInboxItem) => void;
  readonly answerText: string;
  readonly environmentAvailable: boolean;
  readonly pendingExchangeId: string | null;
  readonly setAnswers: (update: (current: HumanInboxAnswers) => HumanInboxAnswers) => void;
  readonly onOpenThread: (item: HumanInboxItem) => void;
}) {
  const urgency = urgencyPresentation[item.urgency];
  const openDuration = formatElapsedDurationLabel(item.openedAt);
  return (
    <li className="transition-colors hover:bg-muted/30">
      <details className="group/details">
        <summary className="flex cursor-pointer list-none items-start gap-3 p-4 outline-hidden marker:hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:gap-4 [&::-webkit-details-marker]:hidden">
          <Badge
            className="mt-0.5 uppercase tracking-wide font-medium"
            size="sm"
            variant={urgency.variant}
          >
            {urgency.label}
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="max-w-full truncate font-medium text-foreground/80">
                {item.senderId}
              </span>
              <span aria-hidden>·</span>
              <span className="truncate">{item.squadronName}</span>
              {openDuration ? (
                <>
                  <span aria-hidden>·</span>
                  <time className="tabular-nums" dateTime={item.openedAt}>
                    open {openDuration}
                  </time>
                </>
              ) : null}
            </div>
            <h2 className="mt-1.5 break-words text-pretty text-sm font-semibold leading-snug text-foreground">
              {item.intent}
            </h2>
          </div>
          <ChevronRightIcon
            aria-hidden
            className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open/details:rotate-90"
          />
        </summary>
        <div className="border-t border-border/50 px-4 pb-5 pt-4 sm:ms-20 sm:px-4 sm:pe-4">
          <p className="max-w-[72ch] whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
            {item.message}
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <Textarea
              aria-label={`Answer ${item.intent}`}
              className="min-h-24 resize-y text-base sm:text-sm"
              onChange={(event) => captureHumanInboxAnswer(event, item.exchangeId, setAnswers)}
              placeholder="Type the answer exactly as it should be delivered"
              value={answerText}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <OpenThreadButton
                environmentAvailable={environmentAvailable}
                item={item}
                onOpen={onOpenThread}
              />
              <Button
                disabled={pendingExchangeId !== null || answerText.length === 0}
                onClick={() => answer(item)}
                size="sm"
                type="button"
              >
                {pendingExchangeId === item.exchangeId ? "Delivering…" : "Answer"}
              </Button>
            </div>
          </div>
        </div>
      </details>
    </li>
  );
}

function AnsweredShelf({
  items,
  environmentAvailable,
  onOpenThread,
}: {
  readonly items: ReadonlyArray<HumanInboxItem>;
  readonly environmentAvailable: boolean;
  readonly onOpenThread: (item: HumanInboxItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <details className="group/shelf mt-8 border-t border-border/70 pt-6">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1.5 text-sm font-medium text-muted-foreground outline-hidden marker:hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-4 transition-transform duration-150 group-open/shelf:rotate-90"
        />
        <span>Answered</span>
        <Badge size="sm" variant="secondary" className="tabular-nums">
          {items.length}
        </Badge>
      </summary>
      <ol className="mt-3 divide-y divide-border/60 rounded-xl border border-border/70 bg-card/30 overflow-hidden shadow-xs">
        {items.map((item) => {
          const answeredDuration = item.terminalAt
            ? formatElapsedDurationLabel(item.terminalAt)
            : "";
          return (
            <li
              className="flex min-w-0 items-center justify-between gap-3 p-3.5 transition-colors hover:bg-muted/30"
              key={item.exchangeId}
            >
              <div className="flex min-w-0 items-start gap-3">
                <CheckCircle2Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium text-foreground/90">
                    {item.intent}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.senderId} · {item.squadronName}
                    {` · ${formatAnsweredAgeLabel(answeredDuration)}`}
                  </p>
                </div>
              </div>
              <OpenThreadButton
                environmentAvailable={environmentAvailable}
                item={item}
                onOpen={onOpenThread}
              />
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export function HumanInboxPage() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { squadrons } = useSquadronDirectory();
  const [personId, setPersonId] = useState<string | null>(null);
  const [items, setItems] = useState<ReadonlyArray<HumanInboxItem>>([]);
  const [answeredItems, setAnsweredItems] = useState<ReadonlyArray<HumanInboxItem>>([]);
  const workflowQuery = useWorkflowQuery(
    primaryEnvironmentId === null
      ? null
      : workflowListAtom({
          environmentId: primaryEnvironmentId,
          input: { squadronId: "", search: "", status: "waiting_approval", page: 0, pageSize: 100 },
        }),
  );
  const workflowItems = workflowQuery.data?.runs ?? [];
  const workflowCount = workflowQuery.data?.total ?? 0;
  const [answers, setAnswers] = useState<HumanInboxAnswers>({});
  const [pendingExchangeId, setPendingExchangeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerAttempts = useRef(new Map<string, HumanInboxAnswerAttempt>());

  const refresh = useCallback(async (requestedPersonId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const [openResponse, answeredResponse] = await Promise.all([
        listHumanInbox(requestedPersonId, "open"),
        listHumanInbox(requestedPersonId, "answered"),
      ]);
      setPersonId(openResponse.personId);
      setItems(openResponse.items);
      setAnsweredItems(answeredResponse.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the inbox.");
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const answer = async (item: HumanInboxItem) => {
    const message = answers[item.exchangeId] ?? "";
    if (message.length === 0) return;
    await submitHumanInboxAnswer({
      item,
      message,
      attempts: answerAttempts.current,
      randomUUID: () => window.crypto.randomUUID(),
      send: answerHumanExchange,
      refresh,
      notifyChanged: notifyHumanInboxChanged,
      onAccepted: () =>
        setAnswers((current) => {
          const next = { ...current };
          delete next[item.exchangeId];
          return next;
        }),
      setPendingExchangeId,
      setError,
    });
  };

  const openThread = useCallback(
    (item: HumanInboxItem) => {
      if (primaryEnvironmentId === null || item.senderThreadId === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(primaryEnvironmentId, ThreadId.make(item.senderThreadId)),
        ),
      });
    },
    [navigate, primaryEnvironmentId],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
            !isElectron && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            isElectron && "drag-region h-[52px]",
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="Inbox breadcrumb">
            <WorkspaceBreadcrumbItem current>Inbox</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 sm:py-10">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
              <div>
                <h1 className="text-balance text-2xl font-semibold tracking-tight">Inbox</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {loading && personId === null
                    ? "Loading questions waiting on you…"
                    : `${items.length + workflowCount} open ${items.length + workflowCount === 1 ? "item" : "items"}`}
                </p>
              </div>
              <Button
                aria-label="Refresh inbox"
                disabled={loading}
                onClick={() => void refresh(personId ?? undefined).catch(() => undefined)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <RefreshCwIcon aria-hidden className={cn("size-4", loading && "animate-spin")} />
                Refresh
              </Button>
            </div>

            {error ? (
              <div
                aria-live="polite"
                className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/8 px-4 py-3 text-sm text-destructive-foreground"
              >
                <span>{error}</span>
                <Button
                  onClick={() => void refresh(personId ?? undefined).catch(() => undefined)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </div>
            ) : null}

            {!loading && error === null && items.length === 0 && workflowCount === 0 ? (
              <div className="mt-12 flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 p-12 text-center">
                <span className="flex size-11 items-center justify-center rounded-full bg-success/10 text-success">
                  <InboxIcon aria-hidden className="size-5" />
                </span>
                <h2 className="mt-4 text-base font-medium text-foreground">
                  Nothing is waiting on you
                </h2>
                <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  New questions and playbook approvals will arrive here.
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-8">
                {workflowItems.length > 0 && (
                  <section aria-labelledby="workflow-approvals-heading">
                    <div className="flex items-center justify-between gap-2 pb-2.5">
                      <div className="flex items-center gap-2">
                        <h2
                          className="text-sm font-semibold tracking-tight text-foreground"
                          id="workflow-approvals-heading"
                        >
                          Playbook approvals
                        </h2>
                        <Badge size="sm" variant="secondary" className="tabular-nums">
                          {workflowCount}
                        </Badge>
                      </div>
                    </div>
                    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/40 shadow-xs">
                      <ol className="divide-y divide-border/60">
                        {workflowItems.map((item) => {
                          const elapsed = formatElapsedDurationLabel(item.updatedAt);
                          const squadron = squadrons.find((s) => s.squadron.id === item.squadronId);
                          const squadronName = squadron?.squadron.name;
                          return (
                            <li
                              className="flex flex-col gap-3 p-4 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
                              key={item.id}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                  <Badge
                                    size="sm"
                                    variant="warning"
                                    className="font-medium uppercase tracking-wide"
                                  >
                                    {statusPresentation[item.status]?.label ?? "Needs approval"}
                                  </Badge>
                                  <span className="font-medium text-foreground/80">
                                    {phaseLabel(item.phase)}
                                  </span>
                                  {squadronName ? (
                                    <>
                                      <span aria-hidden>·</span>
                                      <span className="truncate">{squadronName}</span>
                                    </>
                                  ) : null}
                                  {elapsed ? (
                                    <>
                                      <span aria-hidden>·</span>
                                      <time className="tabular-nums" dateTime={item.updatedAt}>
                                        {elapsed === "just now"
                                          ? "updated just now"
                                          : `waiting ${elapsed}`}
                                      </time>
                                    </>
                                  ) : null}
                                </div>
                                <p className="mt-1.5 break-words text-pretty text-sm font-semibold leading-snug text-foreground">
                                  {item.title}
                                </p>
                              </div>
                              <Button
                                render={
                                  <Link
                                    to="/runs"
                                    search={{
                                      runId: item.id,
                                      squadronId: item.squadronId,
                                      tab: "overview",
                                    }}
                                    hash="workflow-approval"
                                  />
                                }
                                size="sm"
                                variant="outline"
                                className="shrink-0 gap-1.5 self-start sm:self-center"
                              >
                                Review evidence
                                <ArrowUpRightIcon
                                  aria-hidden
                                  className="size-3.5 text-muted-foreground"
                                />
                              </Button>
                            </li>
                          );
                        })}
                      </ol>
                      {workflowCount > workflowItems.length && (
                        <div className="flex items-center justify-between border-t border-border/50 bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
                          <span>
                            Showing {workflowItems.length} of {workflowCount} playbook approvals.
                          </span>
                          <Link
                            to="/runs"
                            search={{ status: "waiting_approval" }}
                            className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                          >
                            Open Playbooks
                            <ArrowUpRightIcon aria-hidden className="size-3" />
                          </Link>
                        </div>
                      )}
                    </div>
                  </section>
                )}
                {items.length > 0 && (
                  <section aria-labelledby="agent-questions-heading">
                    <div className="flex items-center justify-between gap-2 pb-2.5">
                      <div className="flex items-center gap-2">
                        <h2
                          className="text-sm font-semibold tracking-tight text-foreground"
                          id="agent-questions-heading"
                        >
                          Agent questions
                        </h2>
                        <Badge size="sm" variant="secondary" className="tabular-nums">
                          {items.length}
                        </Badge>
                      </div>
                    </div>
                    <ol className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card/40 shadow-xs">
                      {items.map((item) => (
                        <OpenInboxItem
                          answer={answer}
                          answerText={answers[item.exchangeId] ?? ""}
                          environmentAvailable={primaryEnvironmentId !== null}
                          item={item}
                          key={item.exchangeId}
                          onOpenThread={openThread}
                          pendingExchangeId={pendingExchangeId}
                          setAnswers={setAnswers}
                        />
                      ))}
                    </ol>
                  </section>
                )}
              </div>
            )}

            <AnsweredShelf
              environmentAvailable={primaryEnvironmentId !== null}
              items={answeredItems}
              onOpenThread={openThread}
            />
          </main>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
