import { FetchHttpClient } from "effect/http";
import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { PeerRegistryService } from "../a2a/PeerRegistryService.ts";
import { live as deliveryTransport } from "../a2a/DeliveryTransport.ts";
import { A2ADeliveryWorker, manualLayer } from "../a2a/DeliveryWorker.ts";
import { ensureLocalOperatorHumanPerson } from "../a2a/HumanPersonRegistry.ts";
import { A2AHumanInbox, layer as inboxLayer } from "../a2a/HumanInboxService.ts";
import { A2ALedger, layer as ledgerLayer } from "../a2a/LedgerService.ts";
import { CommCommandId, ExchangeId, LedgerProjectId } from "../a2a/contracts.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";
import { ThreadId, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { permissiveCrewMemberModels } from "../test-support/crewMemberModels.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { makePlaybookStore, playbookStoreLayer } from "./PlaybookStore.ts";
import { createAgentPersonaLibrary } from "../agents/agentPersonaLibrary.ts";

export const seedPlaybookOwners = Effect.fn(function* (owners: ReadonlyArray<string>) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  for (const owner of owners) {
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (${owner}, 'project:playbook-test', 'Owner', 'codex', 'full-access', 'default',
      '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z', '{}')`;
  }
});

/** Adds personas to the environment's real library through its own API, then turns some off. */
export const seedPersonas = Effect.fn(function* (
  personas: ReadonlyArray<{
    readonly id: string;
    readonly enabled: boolean;
    readonly independentReviewer?: boolean;
    readonly codexModel?: string;
    readonly access?: "read-only" | "full-access";
  }>,
) {
  const { stateDir } = yield* ServerConfig;
  const library = createAgentPersonaLibrary({
    fs: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    stateDir,
  });
  for (const { id, enabled, independentReviewer, codexModel, access = "read-only" } of personas) {
    yield* library.createPersona({
      id,
      displayName: id,
      description: `The ${id} persona.`,
      instructions: `You are ${id}.`,
      access,
      ...(independentReviewer === undefined ? {} : { independentReviewer }),
      modelRoute: [
        {
          driver: ProviderDriverKind.make("codex"),
          model: codexModel ?? "gpt-5.5",
          reasoningEffort: "high",
        },
        ...(codexModel === undefined
          ? [
              {
                driver: ProviderDriverKind.make("claudeAgent"),
                model: "claude-opus-5-5",
                reasoningEffort: "high" as const,
              },
            ]
          : []),
      ],
    });
    if (!enabled) yield* library.setEnabled(id, false);
  }
  return stateDir;
});

/** Use production exchange projection and answer paths for playbook gates. */
export const seedPlaybookInbox = Effect.fn(function* (owner: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-11-24T00:00:00.000Z";
  const personId = yield* ensureLocalOperatorHumanPerson(sql);
  const projectId = LedgerProjectId.make("project:playbook-test");
  const ledger = yield* A2ALedger.pipe(Effect.provide(ledgerLayer));
  yield* ledger.ensureProject({ projectId, createdAt: at });
  const id = participantIdForThread(owner);
  yield* ledger.appendEvents({
    projectId,
    commandId: CommCommandId.make(`register:${owner}`),
    acceptedAt: at,
    events: [
      {
        kind: "participant.joined",
        sender: null,
        receiver: id,
        exchangeId: null,
        correlationId: null,
        createdAt: at,
        payload: { participant: { kind: "agent", id, threadId: owner } },
      },
    ],
  });
  const inbox = yield* A2AHumanInbox.pipe(
    Effect.provide(inboxLayer.pipe(Layer.provide(ledgerLayer))),
  );
  const transport = deliveryTransport.pipe(
    Layer.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        Layer.mock(PeerRegistryService)({}),
        Layer.mock(OrchestratorV2)({}),
        Layer.mock(ThreadManagementService)({}),
        Layer.mock(EffectOutboxV2)({}),
      ),
    ),
  );
  const worker = yield* A2ADeliveryWorker.pipe(
    Effect.provide(manualLayer.pipe(Layer.provide(Layer.merge(ledgerLayer, transport)))),
  );
  return {
    personId,
    inbox,
    drain: worker.drain,
    answer: (requestId: string, message: string, clientRequestId = `answer:${requestId}`) =>
      inbox.answer({
        personId,
        exchangeId: ExchangeId.make(requestId),
        message,
        commandId: CommCommandId.make(clientRequestId),
        acceptedAt: at,
      }),
  };
});

const personaAvailabilityLayer = Layer.mergeAll(
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  permissiveCrewMemberModels,
);
export const playbookStoreTestLayer = playbookStoreLayer.pipe(
  Layer.provide(personaAvailabilityLayer),
);
export const makePlaybookStoreForTests = makePlaybookStore.pipe(
  Effect.provide(personaAvailabilityLayer),
);
