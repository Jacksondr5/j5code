/** One header line per field; a title with a line break must not start a field of its own. */
const field = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The prompt must not be able to end its block and continue as platform voice, nor open a
 * header of its own, the same way `CrewSeatFinishNotifier` guards seat replies.
 */
const promptBody = (prompt: string) =>
  prompt
    .replace(/<\/step_prompt>/g, "<\\/step_prompt>")
    .replace(/<j5_playbook_step>/g, "<\\j5_playbook_step>");

/** The platform notice that hands the named agent the step its playbook run just landed on. */
export const crewStepNoticeText = (input: {
  readonly playbookName: string;
  readonly playbookTitle: string;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly position: number;
  readonly total: number;
  readonly ownerParticipantId: string;
  readonly prompt: string;
}) =>
  [
    "<j5_playbook_step>",
    `playbook: ${field(input.playbookName)} | ${field(input.playbookTitle)}`,
    `step: ${field(input.stepId)} | ${field(input.stepTitle)}`,
    `position: ${input.position} of ${input.total}`,
    `owner_participant_id: ${input.ownerParticipantId}`,
    "</j5_playbook_step>",
    "<step_prompt>",
    promptBody(input.prompt),
    "</step_prompt>",
    `You hold this step. Do it now, then report back to ${input.ownerParticipantId} with j5_send_message, including what you did and the evidence. The owner advances the playbook; you don't call its movement tools.`,
  ].join("\n");
