import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { ScopedSquadronRef } from "@t3tools/contracts/j5";

export interface SquadronChoice {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly name: string;
}

export interface SquadronDraftState<TContent = unknown> {
  readonly squadronId: string | null;
  readonly frozenAtFirstSend: boolean;
  readonly content: TContent;
}

/** The sidebar can set ambient context, but it must never manufacture a choice. */
export const resolveSquadronScope = (
  choices: ReadonlyArray<SquadronChoice>,
  selected: ScopedSquadronRef | null,
) =>
  choices.find(
    (choice) =>
      choice.id === selected?.squadronId && choice.environmentId === selected.environmentId,
  ) ?? null;

/** Selected scope admits only that Squadron's immutable, known Registrar homes. */
export const filterThreadsForSquadronScope = <
  T extends { readonly id: string; readonly environmentId: EnvironmentId },
>(
  threads: ReadonlyArray<T>,
  scope: SquadronChoice | null,
  homesByThreadId: ReadonlyMap<
    string,
    | { readonly kind: "known"; readonly squadron: { readonly id: string } }
    | { readonly kind: "unknown" }
  >,
) => {
  if (scope === null) return [...threads];
  return threads.filter((thread) => {
    const home = homesByThreadId.get(
      scopedThreadKey(scopeThreadRef(thread.environmentId, ThreadId.make(thread.id))),
    );
    return (
      thread.environmentId === scope.environmentId &&
      home?.kind === "known" &&
      home.squadron.id === scope.id
    );
  });
};

/** Changing the pre-send chip is scoped state only; the typed draft stays intact. */
export const selectSquadronForDraft = <TContent>(
  state: SquadronDraftState<TContent>,
  squadronId: string,
): SquadronDraftState<TContent> => (state.frozenAtFirstSend ? state : { ...state, squadronId });

export const freezeSquadronForFirstSend = <TContent>(
  state: SquadronDraftState<TContent>,
): SquadronDraftState<TContent> => ({ ...state, frozenAtFirstSend: true });

/** Keep the immutable Registrar choice visible after this draft's first send. */
export const shouldShowSquadronDraftChip = (input: {
  readonly isFirstMessage: boolean;
  readonly frozenAtFirstSend: boolean;
}) => input.isFirstMessage || input.frozenAtFirstSend;

export interface DurableSquadronHome {
  readonly id: string;
  readonly name: string;
}

/** A persisted Registrar home outranks mutable draft and ambient context. */
export const resolveEffectiveSquadronId = (input: {
  readonly durableHome: DurableSquadronHome | null;
  readonly draftSquadronId: string | null;
  readonly ambientSquadronId: string | null;
}) => input.durableHome?.id ?? input.draftSquadronId ?? input.ambientSquadronId;

/** A Registrar home is the durable, immutable source for an existing thread. */
export const resolveSquadronDraftChipState = (input: {
  readonly durableHome: DurableSquadronHome | null;
  readonly draft: Pick<SquadronDraftState, "frozenAtFirstSend" | "squadronId">;
  readonly isFirstMessage: boolean;
}) => {
  if (input.durableHome !== null) {
    return { visible: true, frozen: true, squadronId: input.durableHome.id } as const;
  }
  return {
    visible: shouldShowSquadronDraftChip({
      isFirstMessage: input.isFirstMessage,
      frozenAtFirstSend: input.draft.frozenAtFirstSend,
    }),
    frozen: input.draft.frozenAtFirstSend,
    squadronId: input.draft.squadronId,
  } as const;
};
