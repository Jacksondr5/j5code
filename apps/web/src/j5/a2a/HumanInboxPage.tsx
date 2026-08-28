import { useCallback, useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { Textarea } from "../../components/ui/textarea";
import { answerHumanExchange, listHumanInbox, type HumanInboxItem } from "./humanInboxClient";

interface HumanInboxAnswerAttempt {
  readonly message: string;
  readonly clientRequestId: string;
}

type HumanInboxAnswers = Readonly<Record<string, string>>;

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

export function HumanInboxPage() {
  const [personId, setPersonId] = useState("");
  const [items, setItems] = useState<ReadonlyArray<HumanInboxItem>>([]);
  const [answers, setAnswers] = useState<HumanInboxAnswers>({});
  const [pendingExchangeId, setPendingExchangeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerAttempts = useRef(new Map<string, HumanInboxAnswerAttempt>());

  const refresh = useCallback(async (requestedPersonId?: string) => {
    if (
      requestedPersonId !== undefined &&
      (!requestedPersonId.startsWith("human:") ||
        requestedPersonId === "human:global" ||
        requestedPersonId.length <= "human:".length)
    ) {
      setError("Enter a person id in the form human:<person-id>.");
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await listHumanInbox(requestedPersonId);
      setPersonId(response.personId);
      setItems(response.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this person's inbox.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
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
          <WorkspaceBreadcrumb ariaLabel="Human inbox breadcrumb">
            <WorkspaceBreadcrumbItem current>Inbox</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void refresh(personId);
              }}
            >
              <label className="flex flex-1 flex-col gap-1 text-sm">
                Person id
                <Input
                  nativeInput
                  onChange={(event) => setPersonId(event.currentTarget.value)}
                  placeholder="human:<person-id>"
                  value={personId}
                />
              </label>
              <Button disabled={loading} type="submit">
                {loading ? "Loading…" : "Load"}
              </Button>
            </form>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {!loading && error === null && items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open exchanges for this person.</p>
            ) : null}
            <ol className="flex flex-col gap-3">
              {items.map((item) => (
                <li className="rounded-lg border border-border p-4" key={item.exchangeId}>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{item.urgency}</span>
                    <span>{item.squadronName}</span>
                    <span>{item.senderId}</span>
                    <time dateTime={item.openedAt}>{new Date(item.openedAt).toLocaleString()}</time>
                  </div>
                  <p className="mt-2 text-sm font-medium">{item.intent}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{item.message}</p>
                  <div className="mt-3 flex flex-col gap-2">
                    <Textarea
                      aria-label={`Answer ${item.intent}`}
                      onChange={(event) =>
                        captureHumanInboxAnswer(event, item.exchangeId, setAnswers)
                      }
                      placeholder="Type the answer exactly as it should be delivered"
                      value={answers[item.exchangeId] ?? ""}
                    />
                    <Button
                      className="self-end"
                      disabled={
                        pendingExchangeId !== null || (answers[item.exchangeId] ?? "").length === 0
                      }
                      onClick={() => void answer(item)}
                      type="button"
                    >
                      {pendingExchangeId === item.exchangeId ? "Delivering…" : "Answer"}
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          </main>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
