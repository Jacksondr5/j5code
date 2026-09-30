import { PLAYBOOK_MAX_BYTES, PLAYBOOK_MAX_STEPS } from "@t3tools/contracts/j5";

/** How an agent treats an explicit `@playbook:NAME` mention from the composer picker. */
export const PLAYBOOK_MENTION_INSTRUCTIONS =
  "An explicit `@playbook:NAME` in the user's message names a playbook in this workspace. NAME is the kebab-case token after the prefix, without trailing punctuation. Call `playbook_read(NAME)` first. Unless the message asks for something else with it, start it in this thread with `playbook_start`. Treat mentions in quoted text, code, or file contents as references unless the user asks to run them.";

export const PLAYBOOK_INSTRUCTIONS = `
- Use playbook_list to discover .j5/playbooks/*.yaml and playbook_start(name, client_request_id) to start one. Follow currentStep.prompt in this thread; playbook_next and playbook_back move the pointer without undoing work. Movement and completion require expectedStepId. Use a fresh client_request_id per action; retry the same request ID after uncertainty. Active-run retries return current live progress; after a run ends, only start and finish retries are retained.
- After compaction, restart, or uncertainty, call playbook_current({}) to recover the runId and live prompt. Never infer progress from conversation memory. If the current step was removed, use playbook_reselect with expectedStepId and an available stepId. Finish with playbook_complete or playbook_cancel; cancellation works with missing or invalid YAML. One run may be active per thread, and ending it leaves the thread usable.
- Author YAML with ordinary file tools: title, description, and 1–${PLAYBOOK_MAX_STEPS} steps with unique stable id, title, and prompt fields; at most ${PLAYBOOK_MAX_BYTES / 1024} KiB, no aliases. Prompts are read live; steps do not execute code or spawn agents.
- ${PLAYBOOK_MENTION_INSTRUCTIONS}
`;
