import { Artifact, RunDetail, PlaybookDefinitionPresentation } from "@j5/playbook-contracts";
import {
  PlaybookApprovalCount,
  PlaybookEntries,
  PlaybookThreadParent,
} from "@j5/playbook-contracts/sidebar";
import { BoardPage, TimelinePage } from "@j5/playbook-contracts/observability";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { EnvironmentId } from "@t3tools/contracts";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { executeJ5Request, J5HttpError } from "@t3tools/client-runtime/j5/http";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export { J5HttpError as PlaybookHttpError } from "@t3tools/client-runtime/j5/http";
const RunResponse = Schema.Struct({ run: RunDetail });
const ArtifactResponse = Schema.Struct({ artifact: Artifact });

const requestCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "playbook:request",
  execute: Effect.fn("playbook.request")(function* (input: { path: string; body?: unknown }) {
    const supervisor = yield* EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    const state = yield* SubscriptionRef.get(supervisor.state);
    if (Option.isNone(prepared) || state.phase !== "connected")
      return yield* new J5HttpError({
        status: 0,
        detail: "The Playbook environment is disconnected.",
      });
    const path = "/api/j5/playbooks" + input.path;
    const request =
      input.body === undefined
        ? HttpClientRequest.get(path)
        : yield* HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJson(input.body));
    return yield* executeJ5Request(
      prepared.value,
      request,
      input.body === undefined ? 10_000 : 30_000,
    );
  }),
});

const request = Effect.fn("playbook.requestResult")(function* (
  environmentId: EnvironmentId,
  path: string,
  body?: unknown,
) {
  const result = yield* Effect.promise(() =>
    requestCommand.run(appAtomRegistry, {
      environmentId,
      input: { path, ...(body === undefined ? {} : { body }) },
    }),
  );
  if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
  return result.value;
});

export const readRun = (environmentId: EnvironmentId, id: string, ifReadVersion?: number) =>
  Effect.runPromise(
    request(
      environmentId,
      `/${encodeURIComponent(id)}${ifReadVersion === undefined ? "" : `?ifReadVersion=${ifReadVersion}`}`,
    ).pipe(
      Effect.flatMap((response) =>
        response.status === 304
          ? Effect.succeed(null)
          : HttpClientResponse.schemaBodyJson(RunResponse)(response).pipe(
              Effect.map((result) => result.run),
            ),
      ),
    ),
  );

export const readArtifact = (environmentId: EnvironmentId, runId: string, artifactId: string) =>
  Effect.runPromise(
    request(
      environmentId,
      `/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    ).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ArtifactResponse)),
      Effect.map((result) => result.artifact),
    ),
  );

export const mutateRun = async (environmentId: EnvironmentId, path: string, body: unknown) => {
  const run = await Effect.runPromise(
    request(environmentId, path, body).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(RunResponse)),
      Effect.map((result) => result.run),
    ),
  );
  window.dispatchEvent(new Event("j5-playbooks-changed"));
  return run;
};

export const listPlaybookEntries = (
  environmentId: EnvironmentId,
  squadronId: string,
  query = "",
  status = "",
  offset = 0,
  limit = 50,
) =>
  Effect.runPromise(
    request(
      environmentId,
      `/sidebar?squadronId=${encodeURIComponent(squadronId)}&q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}&offset=${offset}&limit=${limit}`,
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(PlaybookEntries))),
  );

export const listPlaybookBoard = (
  environmentId: EnvironmentId,
  squadronId: string,
  query = "",
  status = "",
  offset = 0,
  limit = 24,
) =>
  Effect.runPromise(
    request(
      environmentId,
      `/board?squadronId=${encodeURIComponent(squadronId)}&q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}&offset=${offset}&limit=${limit}`,
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(BoardPage))),
  );

export const readPlaybookTimeline = (
  environmentId: EnvironmentId,
  runId: string,
  before: number | null,
  limit = 50,
) =>
  Effect.runPromise(
    request(
      environmentId,
      `/${encodeURIComponent(runId)}/timeline?${before === null ? "" : `before=${before}&`}limit=${limit}`,
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(TimelinePage))),
  );

export const readPlaybookApprovalCount = (environmentId: EnvironmentId) =>
  Effect.runPromise(
    request(environmentId, "/approval-count").pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PlaybookApprovalCount)),
    ),
  );

export const listPlaybookDefinitions = (environmentId: EnvironmentId) =>
  Effect.runPromise(
    request(environmentId, "/definitions").pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({ definitions: Schema.Array(PlaybookDefinitionPresentation) }),
        ),
      ),
      Effect.map((result) => result.definitions),
    ),
  );

const definitionsResponse = (environmentId: EnvironmentId, path: string, body: unknown) =>
  Effect.runPromise(
    request(environmentId, `/definitions/${path}`, body).pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({ definitions: Schema.Array(PlaybookDefinitionPresentation) }),
        ),
      ),
      Effect.map((result) => result.definitions),
    ),
  );

export const importPlaybookDefinitions = (
  environmentId: EnvironmentId,
  files: readonly { readonly name: string; readonly content: string }[],
  confirmConflicts = false,
) => definitionsResponse(environmentId, "import", { files, confirmConflicts });

export const setPlaybookDefinitionEnabled = (
  environmentId: EnvironmentId,
  id: string,
  enabled: boolean,
) => definitionsResponse(environmentId, "state", { id, enabled });

export const removePlaybookDefinition = (environmentId: EnvironmentId, id: string) =>
  definitionsResponse(environmentId, "remove", { id, enabled: false });

export const readPlaybookThreadParent = (environmentId: EnvironmentId, threadId: string) =>
  Effect.runPromise(
    request(environmentId, `/thread-parent?threadId=${encodeURIComponent(threadId)}`).pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({ parent: Schema.NullOr(PlaybookThreadParent) }),
        ),
      ),
      Effect.map((result) => result.parent),
    ),
  );
