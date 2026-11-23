/**
 * `j5 thread`: upstream's `t3 thread` (`cli/thread.ts`) on J5's tool boundary (register D2).
 * `list` and `show` are upstream's. `start` and `send` reach agents the way any outside agent does,
 * through `j5_spawn_agent` and `j5_send_message`, signed in as `j5-thread-cli`.
 */
import { RunId, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { projectLocationFlags } from "../../cli/config.ts";
import {
  decodeThreadId,
  decodeTitle,
  finishRun,
  jsonFlag,
  messageArgument,
  printJson,
  readMessageArgument,
  reportThreadErrors,
  resolveProject,
  threadArgument,
  threadListCommand,
  threadShowCommand,
  ThreadToolFailedError,
  ThreadUsageError,
  type ThreadTools,
  titleFromMessage,
  waitFlag,
  withThreadTools,
} from "../../cli/thread.ts";
import { SendMessageResult } from "../a2a/contracts.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";

const SpawnResult = Schema.Struct({
  participant_id: Schema.String,
  thread_id: ThreadId,
  /** The run the brief started; a message someone else sends the new thread cannot stand in. */
  run_id: Schema.NullOr(RunId),
  project_id: Schema.String,
});

interface StartFlags {
  readonly title: Option.Option<string>;
  readonly persona: Option.Option<string>;
  readonly provider: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly reasoning: Option.Option<string>;
  readonly runtimeMode: Option.Option<RuntimeMode>;
  readonly worktree: Option.Option<string>;
  readonly branch: Option.Option<string>;
}

const optional = <K extends string, A>(key: K, value: Option.Option<A>) =>
  Option.match(value, {
    onNone: () => ({}),
    onSome: (present) => ({ [key]: present }) as { [P in K]: A },
  });

/**
 * `j5_spawn_agent`'s arguments, except the project. It takes no default model, so a persona or a
 * provider and model is required. Without --runtime-mode the agent gets the CLI's full access.
 */
export const spawnArgs = Effect.fn("j5.cli.thread.spawnArgs")(function* (
  flags: StartFlags,
  message: string,
) {
  if (Option.isSome(flags.provider) !== Option.isSome(flags.model)) {
    return yield* new ThreadUsageError({ detail: "--provider and --model go together." });
  }
  if (Option.isNone(flags.persona) && Option.isNone(flags.model)) {
    return yield* new ThreadUsageError({
      detail: "Choose the agent's model: pass --persona, or --provider and --model.",
    });
  }
  if (Option.isSome(flags.branch) && Option.isNone(flags.worktree)) {
    return yield* new ThreadUsageError({ detail: "--branch needs --worktree <base-ref>." });
  }
  const title = yield* decodeTitle(
    Option.getOrElse(flags.title, () => titleFromMessage(message)),
  ).pipe(Effect.mapError(() => new ThreadUsageError({ detail: "The title is empty." })));
  return {
    title,
    brief: message,
    workspace: Option.match(flags.worktree, {
      onNone: () => ({ type: "root" as const }),
      onSome: (baseRef) => ({
        type: "worktree" as const,
        base_ref: baseRef,
        ...optional("branch", flags.branch),
      }),
    }),
    ...optional("persona", flags.persona),
    ...optional("provider", flags.provider),
    ...optional("model", flags.model),
    ...optional("reasoning", flags.reasoning),
    ...optional("runtime_mode", flags.runtimeMode),
  };
});

/** Spawns the agent, then with `wait` follows the run its brief started. */
export const startAgent = Effect.fn("j5.cli.thread.startAgent")(function* (
  tools: ThreadTools,
  input: {
    readonly projectId: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly wait: boolean;
    readonly json: boolean;
  },
) {
  const spawned = yield* tools.call(
    "j5_spawn_agent",
    { project_id: input.projectId, ...input.args },
    SpawnResult,
  );
  if (input.wait) {
    const runId = spawned.run_id;
    if (runId === null) {
      return yield* new ThreadToolFailedError({
        tool: "j5_spawn_agent",
        detail: `Started thread ${spawned.thread_id}, but its brief's run could not be found to wait for. Follow it with j5 thread show.`,
      });
    }
    if (!input.json) yield* Console.error(`Thread ${spawned.thread_id}`);
    return yield* finishRun(tools, { threadId: spawned.thread_id, runId, json: input.json });
  }
  yield* input.json ? printJson(spawned) : Console.log(spawned.thread_id);
});

/** A message to the thread's agent, addressed by its participant id as any agent's is. */
export const sendToThread = Effect.fn("j5.cli.thread.sendToThread")(function* (
  tools: ThreadTools,
  input: { readonly threadId: ThreadId; readonly message: string; readonly json: boolean },
) {
  const sent = yield* tools.call(
    "j5_send_message",
    { to: participantIdForThread(input.threadId), message: input.message },
    SendMessageResult,
  );
  if (input.json) return yield* printJson(sent);
  yield* Console.log(sent.note ?? sent.deliveryNotice ?? "Sent.");
});

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

const threadStartCommand = Command.make("start", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or a path inside the project, such as ."),
  ),
  message: messageArgument,
  title: optionalString("title", "Agent title. Defaults to the message's first line."),
  persona: optionalString(
    "persona",
    "Persona id. It sets the agent's instructions, access and model. Or pass --provider and --model.",
  ),
  provider: optionalString("provider", "Provider instance id. Pass with --model."),
  model: optionalString("model", "Model id, from the project's Models for custom members."),
  reasoning: optionalString("reasoning", "Reasoning level, for a model that has one."),
  runtimeMode: Flag.Literals("runtime-mode", RuntimeMode.literals).pipe(
    Flag.withDescription(
      "The agent's permission mode. Without it, the agent runs with full access.",
    ),
    Flag.optional,
  ),
  worktree: optionalString(
    "worktree",
    "Run in a new git worktree based on this branch, tag, or commit, instead of the project folder.",
  ),
  branch: optionalString("branch", "Branch name for the new worktree."),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start an agent in a project and print its thread id."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const message = yield* readMessageArgument(flags.message);
      const args = yield* spawnArgs(flags, message);
      yield* withThreadTools(
        flags,
        Effect.fn("j5.cli.thread.start")(function* (tools) {
          const project = yield* resolveProject(tools, flags.project);
          return yield* startAgent(tools, {
            projectId: project.id,
            args,
            wait: flags.wait,
            json: flags.json,
          });
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  thread: threadArgument,
  message: messageArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message to a thread's agent, delivered as any agent's message is. It doesn't take --wait; follow up with j5 thread show.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const message = yield* readMessageArgument(flags.message);
      yield* withThreadTools(flags, (tools) =>
        sendToThread(tools, { threadId, message, json: flags.json }),
      );
    }).pipe(reportThreadErrors),
  ),
);

export const j5ThreadCommand = Command.make("thread").pipe(
  Command.withDescription("Start, message, and read agents on the running server."),
  Command.withSubcommands([
    threadListCommand,
    threadStartCommand,
    threadSendCommand,
    threadShowCommand,
  ]),
);
