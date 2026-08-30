export interface SquadronChoice {
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
  selectedId: string | null,
) => choices.find((choice) => choice.id === selectedId) ?? null;

/** Changing the pre-send chip is scoped state only; the typed draft stays intact. */
export const selectSquadronForDraft = <TContent>(
  state: SquadronDraftState<TContent>,
  squadronId: string,
): SquadronDraftState<TContent> => (state.frozenAtFirstSend ? state : { ...state, squadronId });

export const freezeSquadronForFirstSend = <TContent>(
  state: SquadronDraftState<TContent>,
): SquadronDraftState<TContent> => ({ ...state, frozenAtFirstSend: true });
