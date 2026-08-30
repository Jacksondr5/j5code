export interface SquadronChoice {
  readonly id: string;
  readonly name: string;
  readonly projectIds: ReadonlyArray<string>;
}

export interface SquadronDraftState<TContent = unknown> {
  readonly squadronId: string | null;
  readonly frozenAtFirstSend: boolean;
  readonly content: TContent;
}

/** The sidebar can set ambient context, but it must never manufacture a choice. */
export const resolveSquadronScope = (
  choices: ReadonlyArray<SquadronChoice>,
  selectedId: string | null,
) => choices.find((choice) => choice.id === selectedId) ?? null;

/** Sidebar scoping is a view filter over the selected Squadron's explicit folder references. */
export const filterThreadsForSquadronScope = <T extends { readonly projectId: string }>(
  threads: ReadonlyArray<T>,
  scope: SquadronChoice | null,
) => {
  if (scope === null) return [...threads];
  const projectIds = new Set(scope.projectIds);
  return threads.filter((thread) => projectIds.has(thread.projectId));
};

/** Changing the pre-send chip is scoped state only; the typed draft stays intact. */
export const selectSquadronForDraft = <TContent>(
  state: SquadronDraftState<TContent>,
  squadronId: string,
): SquadronDraftState<TContent> => (state.frozenAtFirstSend ? state : { ...state, squadronId });

export const freezeSquadronForFirstSend = <TContent>(
  state: SquadronDraftState<TContent>,
): SquadronDraftState<TContent> => ({ ...state, frozenAtFirstSend: true });
