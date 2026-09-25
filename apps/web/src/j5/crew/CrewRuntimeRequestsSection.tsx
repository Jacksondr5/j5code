import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { notifyHumanInboxChanged } from "../a2a/humanInboxRefresh";
import type { ScopedCrewRuntimeRequest } from "./crewRuntimeRequests.logic";
import { refreshCrewRuntimeRequests, respondCrewRuntimeRequest } from "./crewRuntimeRequestsClient";

const itemKey = (request: ScopedCrewRuntimeRequest) =>
  `${request.environmentId}:${request.threadId}:${request.requestId}`;

/** The composer's defaults (`ComposerPendingApprovalActions`), so both places offer the same choices. */
const DEFAULT_APPROVAL_CHOICES: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
];

/** The provider's advertised choices, or the composer's defaults when it advertised none. */
const approvalChoices = (
  options: ReadonlyArray<ProviderApprovalOption> | null,
): ReadonlyArray<{ readonly decision: ProviderApprovalDecision; readonly label: string }> =>
  options ?? DEFAULT_APPROVAL_CHOICES;

const REQUEST_KIND_LABEL: Record<string, string> = {
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change files",
  "mcp-elicitation": "Tool request",
};

/**
 * Provider approvals and questions from Crew Captains and seats, answered here instead of in their
 * threads (Crews AC9). An answer that lost a race with another device is refused by the server and
 * the message says so; either way the item re-reads and leaves once it has resolved.
 */
export function CrewRuntimeRequestsSection(props: {
  readonly requests: ReadonlyArray<ScopedCrewRuntimeRequest>;
  readonly onOpenThread: (request: ScopedCrewRuntimeRequest) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Record<string, PendingUserInputDraftAnswer>>>(
    {},
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (props.requests.length === 0) return null;

  const submit = async (
    request: ScopedCrewRuntimeRequest,
    answer: { decision: ProviderApprovalDecision } | { answers: Record<string, string | string[]> },
  ) => {
    const key = itemKey(request);
    setBusyKey(key);
    setError(null);
    try {
      await respondCrewRuntimeRequest(request.environmentId, {
        threadId: request.threadId,
        requestId: request.requestId,
        ...answer,
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not answer the request.");
    } finally {
      notifyHumanInboxChanged(request.environmentId);
      await refreshCrewRuntimeRequests(request.environmentId).catch(() => undefined);
      setBusyKey(null);
    }
  };

  return (
    <section aria-label="Crew agent requests" className="mt-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Crew agent requests
      </h2>
      {error ? (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="space-y-4">
        {props.requests.map((request) => {
          const key = itemKey(request);
          const busy = busyKey === key;
          const answerable = request.responseCapability !== "not_resumable";
          const draft = drafts[key] ?? {};
          return (
            <li key={key} className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{request.crewName}</span>
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {request.seat ?? "Captain"}
                </Badge>
                <button
                  type="button"
                  className="min-w-0 truncate text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => props.onOpenThread(request)}
                >
                  {request.threadTitle}
                </button>
              </div>
              {request.request.kind === "approval" ? (
                <div className="mt-2 space-y-2">
                  <p className="text-muted-foreground">
                    {request.request.appName ??
                      REQUEST_KIND_LABEL[request.request.requestKind] ??
                      "Approval"}
                  </p>
                  {request.request.detail ? (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">
                      {request.request.detail}
                    </pre>
                  ) : null}
                  {answerable ? (
                    <div className="flex flex-wrap gap-2">
                      {approvalChoices(request.request.options).map((choice) => (
                        <Button
                          key={choice.decision}
                          disabled={busy}
                          onClick={() => void submit(request, { decision: choice.decision })}
                          size="sm"
                          type="button"
                          variant={
                            choice.decision === "decline" || choice.decision === "cancel"
                              ? "outline"
                              : "default"
                          }
                        >
                          {choice.label}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-2 space-y-3">
                  {request.request.questions.map((question) => {
                    const answer = draft[question.id];
                    return (
                      <fieldset key={question.id} className="space-y-1.5">
                        <legend className="font-medium">{question.header}</legend>
                        <p className="text-muted-foreground">{question.question}</p>
                        <div className="flex flex-wrap gap-2">
                          {question.options.map((option) => {
                            const value = option.value ?? option.label;
                            const selected = answer?.selectedOptionValues?.includes(value) ?? false;
                            return (
                              <Button
                                key={value}
                                aria-pressed={selected}
                                disabled={busy || !answerable}
                                onClick={() =>
                                  setDrafts((current) => ({
                                    ...current,
                                    [key]: {
                                      ...current[key],
                                      [question.id]: togglePendingUserInputOptionSelection(
                                        question,
                                        current[key]?.[question.id],
                                        value,
                                      ),
                                    },
                                  }))
                                }
                                size="sm"
                                title={option.description}
                                type="button"
                                variant={selected ? "default" : "outline"}
                              >
                                {option.label}
                              </Button>
                            );
                          })}
                        </div>
                        {question.allowCustomAnswer === false ? null : (
                          <Input
                            aria-label={`Your answer to ${question.header}`}
                            disabled={busy || !answerable}
                            onChange={(event) => {
                              const text = event.currentTarget.value;
                              setDrafts((current) => ({
                                ...current,
                                [key]: {
                                  ...current[key],
                                  [question.id]: setPendingUserInputCustomAnswer(
                                    current[key]?.[question.id],
                                    text,
                                  ),
                                },
                              }));
                            }}
                            placeholder="Or type an answer"
                            value={answer?.customAnswer ?? ""}
                          />
                        )}
                      </fieldset>
                    );
                  })}
                  {answerable ? (
                    <Button
                      disabled={
                        busy ||
                        buildPendingUserInputAnswers(
                          request.request.questions.map((question) => ({
                            ...question,
                            multiSelect: question.multiSelect ?? false,
                          })),
                          draft,
                        ) === null
                      }
                      onClick={() => {
                        if (request.request.kind !== "user_input") return;
                        const answers = buildPendingUserInputAnswers(
                          request.request.questions.map((question) => ({
                            ...question,
                            multiSelect: question.multiSelect ?? false,
                          })),
                          draft,
                        );
                        if (answers !== null) void submit(request, { answers });
                      }}
                      size="sm"
                      type="button"
                    >
                      Send answer
                    </Button>
                  ) : null}
                </div>
              )}
              {answerable ? null : (
                <p className="mt-2 text-muted-foreground">
                  This request can no longer be answered. Open the thread to see where it stopped.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
