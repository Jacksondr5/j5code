import type { EnvironmentId } from "@t3tools/contracts";
import type {
  AllowPersonaOnceRequest,
  AnswerHumanExchangeRequest,
  SavePersonaDraftRequest,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export type {
  HumanInboxItem,
  HumanInboxResponse,
  ScopedHumanInboxItem,
} from "@t3tools/contracts/j5";

export async function answerHumanExchange(
  environmentId: EnvironmentId,
  input: AnswerHumanExchangeRequest,
) {
  const result = await j5Environment.answerHumanExchange.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** The Owner's "Allow this once" on an ask escalating a blocked persona. */
export async function allowPersonaOnce(
  environmentId: EnvironmentId,
  input: AllowPersonaOnceRequest,
) {
  const result = await j5Environment.allowPersonaOnce.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** The Owner's "Save persona" on an ask carrying an agent's persona draft. */
export async function savePersonaDraft(
  environmentId: EnvironmentId,
  input: SavePersonaDraftRequest,
) {
  const result = await j5Environment.savePersonaDraft.run(appAtomRegistry, {
    environmentId,
    input,
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
