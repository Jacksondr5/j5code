import type { ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import {
  crewMemberModelRefusal,
  crewMemberReasoningRefusal,
  crewMemberSelectionLevel,
  eligibleCrewMemberLevelsForModel,
  eligibleCrewMemberModels,
  isCrewMemberLevelChecked,
  isCrewMemberModelChecked,
} from "@t3tools/contracts/j5";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";

/** A model outside the project's "Models for custom members" list, with what to use instead. */
export class CrewMemberModelNotEligibleError extends Schema.TaggedError<CrewMemberModelNotEligibleError>()(
  "CrewMemberModelNotEligibleError",
  {
    projectId: Schema.String,
    projectTitle: Schema.String,
    instanceId: Schema.String,
    model: Schema.String,
    eligible: Schema.Array(
      Schema.Struct({ instanceId: Schema.String, model: Schema.String, name: Schema.String }),
    ),
  },
) {
  override get message(): string {
    return crewMemberModelRefusal({
      selection: this,
      projectTitle: this.projectTitle,
      eligible: this.eligible,
    });
  }
}

/** A reasoning level outside the project's list for custom members, with what the model offers. */
export class CrewMemberReasoningNotEligibleError extends Schema.TaggedError<CrewMemberReasoningNotEligibleError>()(
  "CrewMemberReasoningNotEligibleError",
  {
    projectId: Schema.String,
    projectTitle: Schema.String,
    instanceId: Schema.String,
    model: Schema.String,
    level: Schema.String,
    eligible: Schema.Array(Schema.Struct({ level: Schema.String, label: Schema.String })),
  },
) {
  override get message(): string {
    return crewMemberReasoningRefusal({
      selection: this,
      projectTitle: this.projectTitle,
      eligible: this.eligible,
    });
  }
}

/**
 * The one place that decides whether a resolved model and reasoning level may run a custom worker
 * in a project: a Crew's custom member, a plain `j5_spawn_agent`, or a plain `delegate_task`.
 * Persona seats that keep their persona's selection never reach it.
 */
export class CrewMemberModels extends Context.Service<
  CrewMemberModels,
  {
    readonly assertEligible: (input: {
      readonly projectId: ProjectId;
      readonly selection: Pick<ModelSelection, "instanceId" | "model" | "options">;
    }) => Effect.Effect<
      void,
      CrewMemberModelNotEligibleError | CrewMemberReasoningNotEligibleError
    >;
    /** The same rule as a pure check per resolved selection, for routing an agent's persona pick. */
    readonly eligibility: (
      projectId: ProjectId,
    ) => Effect.Effect<(selection: ModelSelection, provider: ServerProvider) => boolean>;
  }
>()("t3/j5/agents/crewMemberModels") {}

export const layer = Layer.effect(
  CrewMemberModels,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderRegistry;
    const projects = yield* ProjectService;
    const projectTitleOf = (projectId: ProjectId) =>
      projects.getById(projectId).pipe(
        Effect.map(Option.map((project) => project.title)),
        Effect.map(Option.getOrElse(() => projectId as string)),
        Effect.orElseSucceed(() => projectId as string),
      );
    const listsFor = (projectId: ProjectId) =>
      settings.getSettings.pipe(
        Effect.map((all) => resolveProjectSettings(all, projectId).settings),
        Effect.orDie,
      );
    const eligibility: CrewMemberModels["Service"]["eligibility"] = Effect.fn(
      "j5.crewMemberModels.eligibility",
    )(function* (projectId) {
      const { crewMemberModels: models, crewMemberReasoning: levels } = yield* listsFor(projectId);
      return (selection, provider) => {
        if (!isCrewMemberModelChecked(models, selection)) return false;
        const level = crewMemberSelectionLevel(
          provider.models.find((model) => model.slug === selection.model),
          selection.options,
        );
        return (
          level === null ||
          isCrewMemberLevelChecked(levels, { instanceId: provider.instanceId, level })
        );
      };
    });
    const assertEligible: CrewMemberModels["Service"]["assertEligible"] = Effect.fn(
      "j5.crewMemberModels.assertEligible",
    )(function* ({ projectId, selection }) {
      const resolved = yield* listsFor(projectId);
      const list = resolved.crewMemberModels;
      if (!isCrewMemberModelChecked(list, selection)) {
        return yield* new CrewMemberModelNotEligibleError({
          projectId,
          projectTitle: yield* projectTitleOf(projectId),
          instanceId: selection.instanceId,
          model: selection.model,
          eligible: eligibleCrewMemberModels(list, yield* registry.getProviders),
        });
      }
      // With no saved list every level is eligible, so the catalog is not read at all.
      const levels = resolved.crewMemberReasoning;
      if (levels === null) return;
      const provider = (yield* registry.getProviders).find(
        (candidate) => candidate.instanceId === selection.instanceId,
      );
      const level = crewMemberSelectionLevel(
        provider?.models.find((model) => model.slug === selection.model),
        selection.options,
      );
      if (provider === undefined || level === null) return;
      if (isCrewMemberLevelChecked(levels, { instanceId: provider.instanceId, level })) return;
      return yield* new CrewMemberReasoningNotEligibleError({
        projectId,
        projectTitle: yield* projectTitleOf(projectId),
        instanceId: selection.instanceId,
        model: selection.model,
        level,
        eligible: eligibleCrewMemberLevelsForModel(levels, provider, selection.model),
      });
    });
    return CrewMemberModels.of({ assertEligible, eligibility });
  }),
);
