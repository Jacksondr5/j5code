import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ServerSettings as ServerSettingsDocument,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  CodexAppServerClientFactory,
  makeCodexAppServerClientFactoryCommandLayer,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { buildCodexInitializeParams } from "../provider/Layers/CodexProvider.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2RuntimePolicy as ProviderAdapterV2RuntimePolicyType,
} from "../orchestration-v2/ProviderAdapter.ts";
import { layer as projectionStoreLayer } from "../orchestration-v2/ProjectionStore.ts";
import { layerFromStores as eventSinkLayer } from "../orchestration-v2/EventSink.ts";
import { layerFromOrchestrationEventStore as eventStoreLayer } from "../orchestration-v2/EventStore.ts";
import { layerFromApplicationReceipts as commandReceiptStoreLayer } from "../orchestration-v2/CommandReceiptStore.ts";
import { layer as effectOutboxLayer } from "../orchestration-v2/EffectOutbox.ts";
import { layer as turnItemPositionStoreLayer } from "../orchestration-v2/TurnItemPositionStore.ts";
import { OrchestrationEventInfrastructureLayerLive } from "../orchestration/runtimeLayer.ts";
import {
  NativeThreadValidationError,
  ThreadRepointError,
  ThreadRepointService,
  layer as threadRepointLayer,
  type NativeThreadValidator,
} from "../j5/threadRepoint/ThreadRepointService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveCliAuthConfig, type CliAuthLocationFlags, projectLocationFlags } from "./config.ts";
import { layerConfig as sqlitePersistenceLayer } from "../persistence/Layers/Sqlite.ts";

const nativeFlag = Flag.string("native").pipe(
  Flag.withDescription("Validated native provider thread/session id."),
);

const storesLayer = Layer.mergeAll(
  OrchestrationEventInfrastructureLayerLive,
  eventStoreLayer.pipe(Layer.provide(OrchestrationEventInfrastructureLayerLive)),
  projectionStoreLayer,
  commandReceiptStoreLayer.pipe(Layer.provide(OrchestrationEventInfrastructureLayerLive)),
  effectOutboxLayer,
  turnItemPositionStoreLayer,
);

const eventSinkLive = eventSinkLayer.pipe(Layer.provide(storesLayer));
const settingsLive = ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer));

function providerSettings(input: {
  readonly settings: ServerSettingsDocument;
  readonly instanceId: ProviderInstanceId;
  readonly driver: "codex" | "claudeAgent";
}) {
  const configured = input.settings.providerInstances[input.instanceId];
  return configured?.driver === input.driver
    ? configured.config
    : input.settings.providers[input.driver];
}

const makeNativeValidator = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const validate = (input: Parameters<NativeThreadValidator>[0]) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      if (input.driver === ProviderDriverKind.make("claudeAgent")) {
        if (input.cwd === null) {
          return yield* new NativeThreadValidationError({
            detail: "Claude validation needs the target thread workspace path.",
          });
        }
        const config = yield* Schema.decodeUnknownEffect(ClaudeSettings)(
          providerSettings({
            settings,
            instanceId: input.providerThread.providerInstanceId,
            driver: "claudeAgent",
          }),
        );
        const home = yield* resolveClaudeHomePath(config);
        const projectsRoot = yield* fileSystem
          .exists(path.join(home, ".claude", "projects"))
          .pipe(
            Effect.map((nested) =>
              nested ? path.join(home, ".claude", "projects") : path.join(home, "projects"),
            ),
          );
        const mungedCwd = input.cwd.replaceAll("/", "-").replace(/\\/g, "-");
        const sessionPath = path.join(projectsRoot, mungedCwd, `${input.nativeId}.jsonl`);
        const present = yield* fileSystem.exists(sessionPath);
        if (!present) {
          return yield* new NativeThreadValidationError({
            detail: `Claude session file is absent at ${sessionPath}.`,
          });
        }
        return;
      }
      if (input.driver !== ProviderDriverKind.make("codex")) {
        return yield* new NativeThreadValidationError({
          detail: `Native re-point only supports Codex and Claude, not ${input.driver}.`,
        });
      }
      const config = yield* Schema.decodeUnknownEffect(CodexSettings)(
        providerSettings({
          settings,
          instanceId: input.providerThread.providerInstanceId,
          driver: "codex",
        }),
      );
      const cwd = input.cwd ?? process.cwd();
      const codexHome = yield* resolveCodexHomeLayout(config);
      const probeLayer = makeCodexAppServerClientFactoryCommandLayer({
        command: config.binaryPath || "codex",
        args: ["app-server"],
        cwd,
        env: {
          ...process.env,
          CODEX_HOME: codexHome.sharedHomePath,
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const probe = yield* CodexAppServerClientFactory;
          const client = yield* probe.open({
            instanceId: input.providerThread.providerInstanceId,
            threadId: ThreadId.make("thread:operator-repoint-probe"),
            providerSessionId: ProviderSessionId.make("provider-session:operator-repoint-probe"),
            runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd,
            }) satisfies ProviderAdapterV2RuntimePolicyType,
            settings: config,
            environment: process.env,
          });
          yield* client.request("initialize", buildCodexInitializeParams());
          yield* client.notify("initialized", undefined);
          // This is intentionally a bare thread/resume probe: unlike the old
          // repair procedure, no fallback thread/start is permitted here.
          yield* client.request("thread/resume", { threadId: input.nativeId, cwd });
        }).pipe(
          Effect.provide(probeLayer),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new NativeThreadValidationError({
              detail: `Codex thread/resume probe failed for ${input.nativeId}.`,
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        Schema.is(NativeThreadValidationError)(cause)
          ? cause
          : new NativeThreadValidationError({
              detail: `Native validation failed for ${input.nativeId}.`,
              cause,
            }),
      ),
    );
  return validate;
});

const runThreadCommand = <A>(
  flags: CliAuthLocationFlags,
  run: Effect.Effect<A, ThreadRepointError, ThreadRepointService>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const runtime = Layer.mergeAll(eventSinkLive, idAllocatorLayer, projectionStoreLayer).pipe(
      Layer.provideMerge(sqlitePersistenceLayer),
      Layer.provideMerge(settingsLive),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
    return yield* Effect.gen(function* () {
      const validator = yield* makeNativeValidator;
      return yield* run.pipe(Effect.provide(threadRepointLayer(validator)));
    }).pipe(Effect.provide(runtime));
  }).pipe(Effect.orDie);

const threadRepointCommand = Command.make("repoint", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("App thread to repair.")),
  native: nativeFlag,
}).pipe(
  Command.withDescription("Validate and repoint a stopped thread to its native provider history."),
  Command.withHandler((flags) =>
    runThreadCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* ThreadRepointService;
        const result = yield* service.repoint({
          threadId: ThreadId.make(flags.threadId),
          nativeId: flags.native,
        });
        yield* Console.log(
          `Repointed ${result.driver} thread ${flags.threadId} to native ${result.nativeId}.`,
        );
      }),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Inspect and repair durable thread state."),
  Command.withSubcommands([threadRepointCommand]),
);
