import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { stringify as yaml } from "yaml";

import {
  AgentCrewInstanceService,
  type AgentCrewInstance,
} from "../a2a/AgentCrewInstanceService.ts";
import createDraftTable from "../a2a/migrations/054_PersonaDrafts.ts";
import { lineDiff, makeAgentPersonaDrafts } from "./agentPersonaDrafts.ts";
import {
  createAgentPersonaLibrary,
  definitionDigest,
  definitionYaml,
} from "./agentPersonaLibrary.ts";

const member = "agent:j5:a2a:thread:member";
const captain = "agent:j5:a2a:thread:captain";
const otherCaptain = "agent:j5:a2a:thread:other-captain";

const reviewer = {
  id: "reviewer",
  version: 2,
  displayName: "Reviewer",
  description: "Reviews changes.",
  access: "read-only",
  modelRoute: [
    { driver: ProviderDriverKind.make("codex"), model: "gpt-5", reasoningEffort: "high" },
  ],
  instructions: "Review the diff.\nCheck the tests.\nBe kind.",
};

const newcomer = {
  displayName: "Release Notes",
  description: "Writes release notes.",
  instructions: "Summarize the merged changes.",
  access: "read-only" as const,
  modelRoute: [
    { driver: ProviderDriverKind.make("codex"), model: "gpt-5", reasoningEffort: "high" },
  ],
};

// The member sits on one Crew, commanded by `captain`.
const crews = Layer.mock(AgentCrewInstanceService)({
  findMembership: (participantId) =>
    Effect.succeed(
      participantId === member ? { crewInstanceId: "crew:1", seatName: "reviewer" } : null,
    ),
  read: (id) =>
    Effect.succeed(
      id === "crew:1" ? ({ captainParticipantId: captain } as unknown as AgentCrewInstance) : null,
    ),
});

/** A library whose team folder holds `reviewer`, and a drafts store over it. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "j5-persona-drafts-" });
  const folder = path.join(stateDir, "personas");
  const file = path.join(folder, "reviewer.yaml");
  yield* fs.makeDirectory(folder, { recursive: true });
  yield* fs.writeFileString(file, yaml(reviewer));
  const library = createAgentPersonaLibrary({ fs, path, stateDir });
  const drafts = yield* makeAgentPersonaDrafts(library);
  const digest = definitionDigest(yield* library.read("reviewer"));
  return { fs, path, stateDir, file, library, drafts, digest };
});

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        Layer.effectDiscard(createDraftTable).pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
        crews,
        NodeServices.layer,
      ),
    ),
  );

const editInstructions = (digest: string, instructions: string) =>
  ({
    mode: "edit",
    personaId: "reviewer",
    expectedDigest: digest,
    changes: { instructions },
  }) as const;

describe("persona drafts", () => {
  it.effect(
    "an edit of a team persona warns first, then saves as an override the folder never sees",
    () =>
      provided(
        Effect.gen(function* () {
          const { fs, path, stateDir, file, library, drafts, digest } = yield* fixture;
          const folderText = yield* fs.readFileString(file);
          // Off on this server before the edit, and still off after it.
          yield* library.setEnabled("reviewer", false);
          const { draftId, summary, warnings } = yield* drafts.propose({
            proposerParticipantId: member,
            proposerThreadId: "thread:member",
            draft: editInstructions(digest, "Review the diff.\nInsist on tests.\nBe kind."),
          });
          assert.include(summary, `an edit of reviewer ("Reviewer")`);
          assert.include(summary, "    - Check the tests.\n    + Insist on tests.");
          assert.lengthOf(warnings, 2);
          assert.include(warnings[0], "hides later team updates to this persona for everyone");
          assert.include(warnings[1], "remove the override, then restore the team persona");
          for (const warning of warnings) assert.include(summary, warning);
          // Drafting writes nothing to the library.
          assert.deepEqual((yield* library.catalog()).importedIds, []);

          yield* drafts.linkAsk({ draftId, exchangeId: "exchange:edit" });
          assert.deepEqual((yield* drafts.forExchanges(["exchange:edit"])).get("exchange:edit"), {
            draftId,
            personaId: "reviewer",
            mode: "edit",
            overridesFolder: true,
            status: "open",
          });
          yield* drafts.save({ exchangeId: "exchange:edit", savedBy: "human:owner" });

          const after = yield* library.catalog();
          assert.deepEqual(after.importedIds, ["reviewer"]);
          assert.isTrue(after.sourcePaths.has("reviewer"));
          assert.include(after.disabledIds, "reviewer");
          const saved = yield* library.read("reviewer");
          assert.equal(saved.instructions, "Review the diff.\nInsist on tests.\nBe kind.");
          assert.equal(saved.version, 3);
          assert.equal(yield* fs.readFileString(file), folderText);
          // A second press saves nothing more.
          yield* drafts.save({ exchangeId: "exchange:edit", savedBy: "human:owner" });
          assert.equal((yield* library.read("reviewer")).version, 3);

          // Export YAML of the override is a file a team folder loads as it is.
          const team = path.join(stateDir, "team");
          yield* fs.makeDirectory(team);
          yield* fs.writeFileString(path.join(team, "reviewer.yaml"), definitionYaml(saved));
          const teamLibrary = createAgentPersonaLibrary({ fs, path, stateDir: team });
          yield* fs.writeFileString(
            path.join(team, "agent-personas.json"),
            JSON.stringify({ folders: ["."] }),
          );
          assert.deepEqual(yield* teamLibrary.read("reviewer"), saved);

          // Remove plus restore brings the team version back.
          yield* library.removeAgent("reviewer");
          yield* library.restoreSource("reviewer");
          assert.equal((yield* library.read("reviewer")).instructions, reviewer.instructions);
          assert.deepEqual((yield* library.catalog()).importedIds, []);
        }),
      ),
  );

  it.effect("a draft that went stale, or a create whose id was taken, saves nothing", () =>
    provided(
      Effect.gen(function* () {
        const { library, drafts, digest } = yield* fixture;
        const edit = yield* drafts.propose({
          proposerParticipantId: member,
          proposerThreadId: "thread:member",
          draft: editInstructions(digest, "Be strict."),
        });
        yield* drafts.linkAsk({ draftId: edit.draftId, exchangeId: "exchange:stale" });
        // Someone edits the persona in Settings after the agent read it.
        yield* library.importFiles({
          files: [{ name: "reviewer.yaml", content: yaml({ ...reviewer, description: "New." }) }],
          replaceExisting: true,
        });
        const stale = yield* drafts
          .save({ exchangeId: "exchange:stale", savedBy: "human:owner" })
          .pipe(Effect.flip);
        assert.include(stale.message, "reviewer changed since the agent drafted this");
        assert.equal((yield* library.read("reviewer")).instructions, reviewer.instructions);

        const create = yield* drafts.propose({
          proposerParticipantId: member,
          proposerThreadId: "thread:member",
          draft: { mode: "create", personaId: "release-notes", fields: newcomer },
        });
        assert.include(create.summary, "a new persona, release-notes");
        assert.include(create.summary, "instructions: Summarize the merged changes.");
        assert.deepEqual(create.warnings, []);
        yield* drafts.linkAsk({ draftId: create.draftId, exchangeId: "exchange:create" });
        yield* library.createPersona({ id: "release-notes", ...newcomer, displayName: "Other" });
        const taken = yield* drafts
          .save({ exchangeId: "exchange:create", savedBy: "human:owner" })
          .pipe(Effect.flip);
        assert.include(taken.message, "release-notes was created since the agent drafted this");
        assert.equal((yield* library.read("release-notes")).displayName, "Other");
      }),
    ),
  );

  it.effect("an approved create lands in the environment library", () =>
    provided(
      Effect.gen(function* () {
        const { library, drafts } = yield* fixture;
        const { draftId } = yield* drafts.propose({
          proposerParticipantId: member,
          proposerThreadId: "thread:member",
          draft: { mode: "create", personaId: "release-notes", fields: newcomer },
        });
        assert.lengthOf(
          (yield* library.catalog()).definitions.filter(({ id }) => id === "release-notes"),
          0,
        );
        yield* drafts.linkAsk({ draftId, exchangeId: "exchange:new" });
        yield* drafts.save({ exchangeId: "exchange:new", savedBy: "human:owner" });
        const current = yield* library.catalog();
        assert.include(current.importedIds, "release-notes");
        assert.isFalse(current.sourcePaths.has("release-notes"));
        assert.equal((yield* library.read("release-notes")).version, 1);
      }),
    ),
  );

  it.effect("refuses drafts Settings would refuse, and edits that change nothing", () =>
    provided(
      Effect.gen(function* () {
        const { drafts, digest } = yield* fixture;
        const propose = (draft: Parameters<typeof drafts.propose>[0]["draft"]) =>
          drafts
            .propose({ proposerParticipantId: member, proposerThreadId: "thread:member", draft })
            .pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );
        assert.include(
          yield* propose({
            mode: "edit",
            personaId: "reviewer",
            expectedDigest: digest,
            changes: { modelRoute: [] },
          }),
          "not a valid persona",
        );
        assert.include(
          yield* propose(editInstructions(digest, reviewer.instructions)),
          "changes nothing",
        );
        assert.include(
          yield* propose(editInstructions("0".repeat(64), "Be strict.")),
          "changed since you read it",
        );
        assert.include(
          yield* propose({ mode: "create", personaId: "reviewer", fields: newcomer }),
          "already exists",
        );
      }),
    ),
  );

  it.effect("only the proposer or its Captain asks about a draft, and only until it saves", () =>
    provided(
      Effect.gen(function* () {
        const { drafts, digest } = yield* fixture;
        const { draftId } = yield* drafts.propose({
          proposerParticipantId: member,
          proposerThreadId: "thread:member",
          draft: editInstructions(digest, "Be strict."),
        });
        const own = yield* drafts.askSummary({ draftId, askerParticipantId: member });
        assert.include(own, `(draft ${draftId})`);
        assert.equal(yield* drafts.askSummary({ draftId, askerParticipantId: captain }), own);
        const refused = yield* drafts
          .askSummary({ draftId, askerParticipantId: otherCaptain })
          .pipe(Effect.flip);
        assert.include(refused.message, "is another agent's");

        yield* drafts.linkAsk({ draftId, exchangeId: "exchange:ask" });
        yield* drafts.save({ exchangeId: "exchange:ask", savedBy: "human:owner" });
        const saved = yield* drafts
          .askSummary({ draftId, askerParticipantId: member })
          .pipe(Effect.flip);
        assert.include(saved.message, "already saved");
      }),
    ),
  );
});

describe("lineDiff", () => {
  it("shows the changed lines with one line of context, eliding the rest", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "B", "c", "d", "e", "f", "G"].join("\n");
    assert.deepEqual(lineDiff(before, after), [
      "  a",
      "- b",
      "+ B",
      "  c",
      "  …",
      "  f",
      "- g",
      "+ G",
    ]);
  });
});
