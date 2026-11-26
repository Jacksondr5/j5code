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
    `Follow the saved step prompt. Use j5_send_message to report back to ${input.ownerParticipantId} with your result and supporting evidence. The run owner advances the playbook.`,
  ].join("\n");
