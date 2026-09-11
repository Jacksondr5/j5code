import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { J5HttpError } from "./http.ts";
import { resolveJ5ReadSource } from "./readSources.ts";

const session: AuthSessionState = {
  authenticated: true,
  scopes: [AuthOrchestrationReadScope],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "session",
  },
};
const source = {
  environmentId: EnvironmentId.make("remote"),
  environmentLabel: "Remote",
  phase: "connected" as const,
  session,
};

it("preserves an independently loaded read-only source without permitting mutations", () => {
  const result = resolveJ5ReadSource({ ...source, result: AsyncResult.success(["remote-row"]) });
  expect(result).toMatchObject({ data: ["remote-row"], status: "ready", canOperate: false });
});

it("retains data but reports an outage or refresh failure instead of an empty successful source", () => {
  const success = AsyncResult.success(["cached-row"]);
  const offline = resolveJ5ReadSource({ ...source, phase: "offline", result: success });
  expect(offline).toMatchObject({ status: "offline", data: ["cached-row"], canOperate: false });
  const failed = resolveJ5ReadSource({
    ...source,
    result: AsyncResult.failure(
      Cause.fail(new J5HttpError({ status: 503, detail: "Unavailable" })),
      { previousSuccess: Option.some(success) },
    ),
  });
  expect(failed).toMatchObject({ status: "error", data: ["cached-row"], error: "Unavailable" });
});

it("keeps unsupported, authentication failure, and not-yet-connected states distinct", () => {
  expect(
    resolveJ5ReadSource({ ...source, supported: false, result: AsyncResult.initial(false) }).status,
  ).toBe("unsupported");
  expect(
    resolveJ5ReadSource({
      ...source,
      result: AsyncResult.failure(
        Cause.fail(new J5HttpError({ status: 404, detail: "Not found" })),
      ),
    }).status,
  ).toBe("unsupported");
  expect(
    resolveJ5ReadSource({
      ...source,
      result: AsyncResult.failure(
        Cause.fail(new J5HttpError({ status: 401, detail: "Pair again" })),
      ),
    }).status,
  ).toBe("error");
  expect(
    resolveJ5ReadSource({ ...source, phase: "connecting", result: AsyncResult.initial(false) })
      .status,
  ).toBe("loading");
});
