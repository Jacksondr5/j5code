import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { SupervisorConnectionState } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "../state/connections.ts";
import { isJ5UnsupportedError } from "./http.ts";

export interface J5ReadSource<A> {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly canOperate: boolean;
  readonly status: "loading" | "ready" | "offline" | "unsupported" | "error";
  readonly data: A | null;
  readonly error: string | null;
  readonly refreshing: boolean;
}

export interface J5ReadSources<A> {
  readonly isReady: boolean;
  readonly sources: ReadonlyArray<J5ReadSource<A>>;
}

export function resolveJ5ReadSource<A>(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly phase: SupervisorConnectionState["phase"];
  readonly supported?: boolean;
  readonly session: AuthSessionState | null;
  readonly result: AsyncResult.AsyncResult<A, unknown>;
}): J5ReadSource<A> {
  const connected = input.phase === "connected";
  const data = Option.getOrNull(AsyncResult.value(input.result));
  const failure = input.result._tag === "Failure" ? Cause.squash(input.result.cause) : null;
  const unsupported = input.supported === false || isJ5UnsupportedError(failure);
  const status = unsupported
    ? "unsupported"
    : !connected
      ? input.phase === "connecting" || input.phase === "available"
        ? "loading"
        : "offline"
      : failure !== null
        ? "error"
        : data === null
          ? "loading"
          : "ready";
  return {
    environmentId: input.environmentId,
    environmentLabel: input.environmentLabel,
    connected,
    canOperate:
      connected &&
      input.session?.authenticated === true &&
      (input.session.scopes?.includes(AuthOrchestrationOperateScope) ?? true),
    status,
    data: unsupported ? null : data,
    error:
      failure === null
        ? null
        : failure instanceof Error
          ? failure.message
          : "The environment request failed.",
    refreshing: connected && input.result.waiting,
  };
}

/** Merge read models through the existing catalog; each source keeps its own data and failure state. */
export function createJ5ReadSourcesAtom<A>(input: {
  readonly label: string;
  readonly capability: "j5Squadrons" | "j5HumanInbox";
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly stateAtom: (
    id: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, unknown>>;
  readonly configValueAtom: (id: EnvironmentId) => Atom.Atom<ServerConfig | null>;
  readonly sessionStateValueAtom: (id: EnvironmentId) => Atom.Atom<AuthSessionState | null>;
  readonly queryAtom: (id: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>;
}): Atom.Atom<J5ReadSources<A>> {
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    const sources: Array<J5ReadSource<A>> = [];
    for (const [environmentId, entry] of catalog.entries) {
      const state = Option.getOrNull(AsyncResult.value(get(input.stateAtom(environmentId))));
      const supported = get(input.configValueAtom(environmentId))?.environment.capabilities[
        input.capability
      ];
      sources.push(
        resolveJ5ReadSource({
          environmentId,
          environmentLabel: entry.target.label,
          phase: state?.phase ?? "available",
          ...(supported === undefined ? {} : { supported }),
          session: get(input.sessionStateValueAtom(environmentId)),
          result:
            supported === false
              ? AsyncResult.initial<A, unknown>(false)
              : get(input.queryAtom(environmentId)),
        }),
      );
    }
    return { isReady: catalog.isReady, sources };
  }).pipe(Atom.withLabel(input.label));
}
