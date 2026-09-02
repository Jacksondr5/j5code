export interface ParticipantIdentityPresentation {
  readonly label: string;
  readonly tooltipParticipantId: string | null;
}

/** Archive established the truthful fallback: names when known, otherwise an explicit unnamed label. */
export function presentParticipantIdentity(input: {
  readonly participantId: string;
  readonly participantLabels: ReadonlyMap<string, string>;
  readonly annotateHumanInbox?: boolean;
}): ParticipantIdentityPresentation {
  const label = input.participantLabels.get(input.participantId);
  if (label === undefined) {
    return { label: "Unnamed participant", tooltipParticipantId: input.participantId };
  }
  return {
    label:
      input.annotateHumanInbox && input.participantId.startsWith("human:")
        ? `${label} (inbox)`
        : label,
    tooltipParticipantId: null,
  };
}
