import * as CodexErrors from "effect-codex-app-server/errors";
import * as Schema from "effect/Schema";

const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

/**
 * Whether Codex answered `thread/resume` saying the native conversation no longer exists (the
 * thread is unknown, or its rollout file is gone). Only then may a turn start a fresh native
 * conversation; every other resume failure fails the run (FORK.md, "Native resume").
 */
export function isCodexResumeThreadMissing(error: unknown): boolean {
  if (!isCodexAppServerRequestError(error) || error.operation !== "receive-response") return false;
  const message = error.errorMessage.toLowerCase();
  return message.startsWith("thread not found:") || message.includes("no rollout found");
}
