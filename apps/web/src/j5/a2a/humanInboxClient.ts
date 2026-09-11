import type { EnvironmentId } from "@t3tools/contracts";
import type { AnswerHumanExchangeRequest } from "@t3tools/contracts/j5";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { j5Environment } from "../state";

export type {
  HumanInboxItem,
  HumanInboxResponse,
  ScopedHumanInboxItem,
} from "@t3tools/contracts/j5";
export {
  J5HttpError as HumanInboxHttpError,
  listHumanInbox as listHumanInboxEffect,
} from "@t3tools/client-runtime/j5/http";

export async function listHumanInbox(
  environmentId: EnvironmentId,
  personId?: string,
  status: "open" | "answered" = "open",
) {
  const result = await executeAtomQuery(
    appAtomRegistry,
    j5Environment.inbox({
      environmentId,
      input: { status, ...(personId === undefined ? {} : { personId }) },
    }),
  );
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

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
