import { type OrchestrationV2AppThread, type ProjectId } from "@t3tools/contracts";
import type { PlaybookRequiredPersonas } from "@t3tools/contracts/j5";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { describeRouteAttempts, findAgentPersonaDefinition } from "../agents/agentPersonaLaunch.ts";
import type { createAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";
import {
  agentAccessOf,
  agentPersonaAccessLimit,
  resolveCallerAccess,
} from "../agents/agentPersonaPick.ts";
import { translateAgentPersonaProviderPolicy } from "../agents/agentPersonaProviderPolicy.ts";
import { resolveAgentPersonaRoute } from "../agents/agentPersonaRouting.ts";
import { CrewMemberModels } from "../agents/crewMemberModels.ts";

type Status = (typeof PlaybookRequiredPersonas.Type)[number];
type Library = ReturnType<typeof createAgentPersonaLibrary>;

export const assessRequiredPersonas = Effect.fn("Playbooks.assessRequiredPersonas")(function* (
  ids: ReadonlyArray<string>,
  library: Library,
  registry: ProviderRegistry["Service"],
  models: CrewMemberModels["Service"],
  owner?: Pick<OrchestrationV2AppThread, "runtimeMode" | "agentPersonaAssignment"> & {
    readonly projectId: ProjectId;
  },
) {
  if (ids.length === 0)
    return { statuses: [] as ReadonlyArray<Status>, picks: [] as ReadonlyArray<string> };
  const catalog = yield* Effect.result(library.catalog());
  if (catalog._tag === "Failure") {
    return {
      statuses: ids.map((persona): Status => ({
        persona,
        status: "unavailable",
        code: "library_unreadable",
        reason: `The persona library cannot be read: ${catalog.failure.message}`,
      })),
      picks: [],
    };
  }
  const cachedLibrary = { ...library, catalog: () => Effect.succeed(catalog.success) };
  const providers = yield* registry.getProviders;
  const now = yield* Clock.currentTimeMillis;
  const limit = owner === undefined ? undefined : yield* resolveCallerAccess({ thread: owner });
  const eligibility = owner === undefined ? undefined : yield* models.eligibility(owner.projectId);
  const pickLimits =
    limit === undefined || eligibility === undefined
      ? undefined
      : {
          eligible: eligibility,
          accessAbove: agentPersonaAccessLimit(limit, (authority, driver) =>
            agentAccessOf(translateAgentPersonaProviderPolicy(authority, driver)),
          ),
        };
  const picks: string[] = [];
  const statuses = yield* Effect.forEach(ids, (persona) =>
    Effect.gen(function* (): Effect.fn.Return<Status> {
      const found = yield* Effect.result(findAgentPersonaDefinition(persona, cachedLibrary));
      if (found._tag === "Failure")
        return {
          persona,
          status: "unavailable",
          code: found.failure.code ?? "persona_not_found",
          reason: found.failure.message,
        };
      const definition = found.success;
      const args = { personaId: persona, definition, providers, now };
      const unrestricted = resolveAgentPersonaRoute(args);
      if (unrestricted.status === "unavailable")
        return {
          persona,
          status: "unavailable",
          code: "models_exhausted",
          reason: describeRouteAttempts(unrestricted.attempts, providers),
        };
      if (pickLimits !== undefined) {
        const limited = resolveAgentPersonaRoute({ ...args, limits: pickLimits });
        const attempts =
          limited.status === "unavailable" ? limited.attempts : (limited.entries ?? []);
        const blocked = attempts.flatMap((attempt) => {
          const failures = attempt.failures.filter(
            ({ code }) => code === "model-not-eligible" || code === "access-above-caller",
          );
          return failures.length === 0 ? [] : [{ ...attempt, failures }];
        });
        if (blocked.length > 0) {
          picks.push(persona);
          return { persona, status: "limited", limits: describeRouteAttempts(blocked, providers) };
        }
      }
      return { persona, status: "available" };
    }),
  );
  return { statuses, picks };
});
