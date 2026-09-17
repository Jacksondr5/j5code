import {
  SKILL_CATALOG_METHODS,
  SkillCatalogError,
  type SkillCatalogApplyInput,
  type SkillCatalogReadInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import type { ObserveRpcEffect } from "../agents/agentPersonaRpc.ts";
import { createSkillCatalog } from "./skillCatalog.ts";

const writes = Semaphore.makeUnsafe(1);
const failure = (cause: unknown) =>
  new SkillCatalogError({ message: cause instanceof Error ? cause.message : String(cause) });

export const makeSkillCatalogRpcHandlers = Effect.fn("j5.makeSkillCatalogRpcHandlers")(function* (
  observe: ObserveRpcEffect,
) {
  const catalog = createSkillCatalog({ platform: yield* HostProcessPlatform });
  return {
    [SKILL_CATALOG_METHODS.read]: (input: SkillCatalogReadInput) =>
      observe(
        SKILL_CATALOG_METHODS.read,
        Effect.tryPromise({
          try: () => catalog.read(input.folder),
          catch: failure,
        }),
      ),
    [SKILL_CATALOG_METHODS.apply]: (input: SkillCatalogApplyInput) =>
      observe(
        SKILL_CATALOG_METHODS.apply,
        writes.withPermit(
          Effect.uninterruptible(
            Effect.tryPromise({
              try: () => catalog.apply(input),
              catch: failure,
            }),
          ),
        ),
      ),
  };
});
