import type { ClaudeSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { makeClaudeEnvironment } from "../../provider/Drivers/ClaudeHome.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  spawnAndCollect,
  type CommandResult,
} from "../../provider/providerSnapshot.ts";

const decodeAuthStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ loggedIn: Schema.Boolean })),
);

/** SDK initialization succeeds without credentials; only the CLI auth probe confirms login. */
export function claudeAuthenticationStatus(result: CommandResult | undefined) {
  if (result === undefined) return "unknown";
  const decoded = decodeAuthStatus(result.stdout);
  if (decoded._tag === "None") return "unknown";
  if (!decoded.value.loggedIn) return "unauthenticated";
  return result.code === 0 ? "authenticated" : "unknown";
}

export const checkClaudeAuthentication = Effect.fn("j5.checkClaudeAuthentication")(
  function* (settings: ClaudeSettings, environment: NodeJS.ProcessEnv) {
    const env = yield* makeClaudeEnvironment(settings, environment);
    const command = yield* resolveSpawnCommand(settings.binaryPath, ["auth", "status"], { env });
    const result = yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(command.command, command.args, { env, shell: command.shell }),
    ).pipe(Effect.timeout(AUTH_PROBE_TIMEOUT_MS));
    return claudeAuthenticationStatus(result);
  },
  Effect.orElseSucceed(() => "unknown" as const),
);
