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
    /** What keeps a selection off the project's lists, or null; an unknown provider has no level. */
    const selectionProblem = (
      lists: Effect.Success<ReturnType<typeof listsFor>>,
      selection: Pick<ModelSelection, "instanceId" | "model" | "options">,
      provider: ServerProvider | undefined,
    ) => {
      if (!isCrewMemberModelChecked(lists.crewMemberModels, selection))
        return { kind: "model" } as const;
      if (provider === undefined) return null;
      const level = crewMemberSelectionLevel(
        provider.models.find((model) => model.slug === selection.model),
        selection.options,
      );
      if (
        level === null ||
        isCrewMemberLevelChecked(lists.crewMemberReasoning, {
          instanceId: provider.instanceId,
          level,
        })
      )
        return null;
      return { kind: "level", level, provider } as const;
    };
    const eligibility: CrewMemberModels["Service"]["eligibility"] = Effect.fn(
      "j5.crewMemberModels.eligibility",
    )(function* (projectId) {
      const lists = yield* listsFor(projectId);
      return (selection, provider) => selectionProblem(lists, selection, provider) === null;
    });
    const assertEligible: CrewMemberModels["Service"]["assertEligible"] = Effect.fn(
      "j5.crewMemberModels.assertEligible",
    )(function* ({ projectId, selection }) {
      const lists = yield* listsFor(projectId);
      // With no saved level list every level is eligible, so the catalog is not read for one.
      const provider =
        lists.crewMemberReasoning === null
          ? undefined
          : (yield* registry.getProviders).find(
              (candidate) => candidate.instanceId === selection.instanceId,
            );
      const problem = selectionProblem(lists, selection, provider);
      if (problem === null) return;
      if (problem.kind === "model")
        return yield* new CrewMemberModelNotEligibleError({
          projectId,
          projectTitle: yield* projectTitleOf(projectId),
          instanceId: selection.instanceId,
          model: selection.model,
          eligible: eligibleCrewMemberModels(lists.crewMemberModels, yield* registry.getProviders),
        });
      return yield* new CrewMemberReasoningNotEligibleError({
        projectId,
        projectTitle: yield* projectTitleOf(projectId),
        instanceId: selection.instanceId,
        model: selection.model,
        level: problem.level,
        eligible: eligibleCrewMemberLevelsForModel(
          lists.crewMemberReasoning,
          problem.provider,
          selection.model,
        ),
      });
    });
    return CrewMemberModels.of({ assertEligible, eligibility });
  }),
);
