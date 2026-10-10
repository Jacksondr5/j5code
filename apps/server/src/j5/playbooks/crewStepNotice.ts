/** One header line per field; a title with a line break must not start a field of its own. */
const field = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The prompt must not be able to end its block and continue as platform voice, nor open a
 * header of its own, the same way `CrewSeatFinishNotifier` guards handoff bodies.
 */
const promptBody = (prompt: string) =>
  prompt
    .replace(/<\/step_prompt>/g, "<\\/step_prompt>")
    .replace(/<j5_playbook_step>/g, "<\\j5_playbook_step>");

/** The platform notice that hands a Crew seat the step its playbook run just landed on. */
export const crewStepNoticeText = (input: {
  readonly playbookName: string;
  readonly playbookTitle: string;
  readonly crewInstanceId: string;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly position: number;
  readonly total: number;
  readonly captainParticipantId: string;
  readonly prompt: string;
}) =>
  [
    "<j5_playbook_step>",
    `playbook: ${field(input.playbookName)} | ${field(input.playbookTitle)}`,
    `crew_instance_id: ${input.crewInstanceId}`,
    `step: ${field(input.stepId)} | ${field(input.stepTitle)}`,
    `position: ${input.position} of ${input.total}`,
    `captain_participant_id: ${input.captainParticipantId}`,
    "</j5_playbook_step>",
    "<step_prompt>",
    promptBody(input.prompt),
    "</step_prompt>",
    "Do this step now. When it's done, report back to your Captain with j5_send_message, including what you did and the evidence. The Captain advances the playbook; you don't call playbook tools.",
  ].join("\n");
