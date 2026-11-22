import {
  compareInboxItems,
  type HumanInboxAnswerAttempt,
  keepForPersonScopes,
  nextKeptItems,
  type PresentedHumanInboxItem,
  submitHumanInboxAnswer,
} from "@t3tools/client-runtime/j5/inbox";
import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { type HumanInboxResponse, scopedInboxItemKey } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import { useEffect, useMemo, useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { j5Environment } from "../state";
import { readyAnswerAttachments } from "./answerAttachmentDrafts";
import {
  clearAnswerDraft,
  pruneAnswerDrafts,
  setAnswerText,
  useAnswerDraftsLoaded,
  useAnswerTexts,
} from "./answerDrafts";
import { answeredInboxQueryAtom, inboxCountQueryAtom, openInboxQueryAtom } from "./inboxSources";

type Sources = J5ReadSources<HumanInboxResponse>;

/** How a kept item says it closed: who answered, once the answered list holds it (AC16, AC17). */
export interface ClosedItem {
  readonly answered: { readonly answeredBy: string | null | undefined } | null;
  readonly answeredReadSinceClose: boolean;
}

async function sendAnswer(
  environmentId: EnvironmentId,
  input: {
    readonly exchangeId: string;
    readonly message: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly clientRequestId: string;
  },
) {
  const result = await j5Environment.answerHumanExchange.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
}

async function refreshAfterAnswer(environmentId: EnvironmentId) {
  const results = await Promise.all(
    [openInboxQueryAtom(environmentId), answeredInboxQueryAtom(environmentId)].map((atom) => {
      appAtomRegistry.refresh(atom);
      return executeAtomQuery(appAtomRegistry, atom, { reportFailure: false });
    }),
  );
  const failed = results.find((result) => result._tag === "Failure");
  if (failed?._tag === "Failure") throw Cause.squash(failed.cause);
}

const notifyCountChanged = (environmentId: EnvironmentId) =>
  appAtomRegistry.refresh(inboxCountQueryAtom(environmentId));

/**
 * The Inbox's answers, as web keeps them: words are saved with the attachments until the server
 * takes the answer or a read shows the ask closed; an ask that closes while typed into stays (AC17);
 * a retry with the same words reuses its request id; another person's words are never shown.
 */
export function useInboxAnswers(input: {
  readonly openSources: Sources;
  readonly items: ReadonlyArray<PresentedHumanInboxItem>;
  readonly answeredSources: Sources;
  readonly answered: ReadonlyArray<PresentedHumanInboxItem>;
  /**
   * Drop saved answers whose ask closed. Only the Inbox does, as on web: it shows every server's
   * asks, so its kept items are all of them, where a Captain's pinned asks see one server's.
   */
  readonly pruneClosed?: boolean;
}) {
  const { openSources, items, answeredSources, answered, pruneClosed = false } = input;
  const savedAnswers = useAnswerTexts();
  const draftsLoaded = useAnswerDraftsLoaded();
  const personScopes = JSON.stringify(
    openSources.sources.map((source) => [source.environmentId, source.data?.personId ?? null]),
  );
  const answers = useMemo(() => {
    const keep = keepForPersonScopes(personScopes);
    const entries = Object.entries(savedAnswers).filter(([key]) => keep(key));
    return entries.length === Object.keys(savedAnswers).length
      ? savedAnswers
      : Object.fromEntries(entries);
  }, [savedAnswers, personScopes]);
  // An item that closed while the person was answering stays in place with their words. It is
  // kept in the render it closes in, so its row is never unmounted and drawn again closed;
  // `closedWith` is the answered list as it was then, to tell a later read of it.
  const [retention, setRetention] = useState(() => ({
    openSources,
    items,
    answers,
    kept: new Map() as ReadonlyMap<string, PresentedHumanInboxItem>,
    closedWith: new Map() as ReadonlyMap<string, Sources>,
  }));
  let { kept, closedWith } = retention;
  if (retention.openSources !== openSources || retention.answers !== answers) {
    kept = nextKeptItems({
      previous: retention.items,
      current: items,
      kept: retention.kept,
      answers,
      keyOf: scopedInboxItemKey,
    });
    closedWith = new Map(
      [...kept.keys()].map((key) => [key, retention.closedWith.get(key) ?? answeredSources]),
    );
    setRetention({ openSources, items, answers, kept, closedWith });
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saved answers outlive the screen, so a read showing their ask closed, here or while away, drops them.
  useEffect(() => {
    if (pruneClosed && draftsLoaded) pruneAnswerDrafts(openSources, new Set(kept.keys()));
  }, [pruneClosed, draftsLoaded, openSources, kept]);
  const shownItems = kept.size === 0 ? items : [...items, ...kept.values()].sort(compareInboxItems);
  const answeredByKey = new Map(answered.map((item) => [scopedInboxItemKey(item), item]));
  const closedOf = (item: PresentedHumanInboxItem): ClosedItem | undefined => {
    const key = scopedInboxItemKey(item);
    if (!kept.has(key)) return undefined;
    const answer = answeredByKey.get(key);
    const source = answeredSources.sources.find(
      (candidate) => candidate.environmentId === item.environmentId,
    );
    return {
      answered: answer === undefined ? null : { answeredBy: answer.answeredBy },
      answeredReadSinceClose:
        closedWith.get(key) !== answeredSources && source?.status === "ready" && !source.refreshing,
    };
  };

  // An ask that leaves the open list rereads that server's answered list, so a kept item learns
  // who answered, or that the agent withdrew it, as web's Inbox does.
  const previousOpenKeys = useRef(new Map<EnvironmentId, ReadonlySet<string>>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an ask leaving the open list rereads the answered list; it reacts to data arriving, not to a handler here.
  useEffect(() => {
    const next = new Map<EnvironmentId, ReadonlySet<string>>();
    for (const source of openSources.sources) {
      if (source.data === null) continue;
      const keys = new Set(
        source.data.items.map((item) =>
          scopedInboxItemKey({ ...item, environmentId: source.environmentId }),
        ),
      );
      const previous = previousOpenKeys.current.get(source.environmentId);
      if (
        source.status === "ready" &&
        previous !== undefined &&
        [...previous].some((key) => !keys.has(key))
      ) {
        appAtomRegistry.refresh(answeredInboxQueryAtom(source.environmentId));
      }
      next.set(source.environmentId, keys);
    }
    previousOpenKeys.current = next;
  }, [openSources]);

  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // The words being sent stay in the box until the re-read takes the card away. The draft itself
  // is cleared on acceptance, so the closing ask is not kept as one answered elsewhere (AC17).
  const [sentText, setSentText] = useState<string | null>(null);
  // An error belongs to the ask that was being answered: on a phone it is shown by that ask's
  // answer box, which is where the person is looking.
  const [error, setError] = useState<{ readonly key: string; readonly message: string } | null>(
    null,
  );
  const attempts = useRef(new Map<string, HumanInboxAnswerAttempt>());

  const answer = async (item: PresentedHumanInboxItem) => {
    const itemKey = scopedInboxItemKey(item);
    const message = answers[itemKey] ?? "";
    if (message.length === 0 || !item.sourceReady) return;
    const ready = readyAnswerAttachments(item);
    if ("blocked" in ready) {
      setError({ key: itemKey, message: ready.blocked });
      return;
    }
    const keep = keepForPersonScopes(personScopes);
    for (const key of attempts.current.keys()) if (!keep(key)) attempts.current.delete(key);
    setSentText(message);
    await submitHumanInboxAnswer({
      item,
      message,
      attachments: ready.attachments,
      attempts: attempts.current,
      randomUUID: uuidv4,
      send: sendAnswer,
      // Called once the server took the answer. Its attachments, like its words, stay on the card
      // until the re-read takes the card away.
      refresh: (environmentId) =>
        refreshAfterAnswer(environmentId).finally(() => clearAnswerDraft(item)),
      notifyChanged: notifyCountChanged,
      onAccepted: () => setAnswerText(item, ""),
      setPendingExchangeId: setPendingKey,
      setError: (message) => setError(message === null ? null : { key: itemKey, message }),
    });
  };

  return {
    shownItems,
    closedOf,
    answerText: (item: PresentedHumanInboxItem) => {
      const key = scopedInboxItemKey(item);
      return answers[key] ?? (key === pendingKey ? (sentText ?? "") : "");
    },
    setAnswerText,
    answer,
    pendingKey,
    errorFor: (item: PresentedHumanInboxItem) =>
      error !== null && error.key === scopedInboxItemKey(item) ? error.message : null,
  };
}
