import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { J5_LEDGER_CAPABILITIES } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { J5HttpError } from "./http.ts";
import { resolveJ5ReadSource } from "./readSources.ts";
import { j5ServerCompatibilityError } from "./serverCompatibility.ts";

const descriptor = (
  capabilities: ExecutionEnvironmentDescriptor["capabilities"],
): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make("environment-remote"),
  label: "Build Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "9.0.0",
  capabilities,
});

describe("J5 server compatibility", () => {
  it("connects to a J5 server whose ledger is keyed by project", () => {
    expect(
      j5ServerCompatibilityError(descriptor({ repositoryIdentity: true, j5ProjectLedger: true })),
    ).toBeNull();
  });

  it("connects to a server reporting exactly what a project-keyed J5 server reports", () => {
    expect(
      j5ServerCompatibilityError(
        descriptor({ repositoryIdentity: true, ...J5_LEDGER_CAPABILITIES }),
      ),
    ).toBeNull();
  });

  it("tells the person to update a J5 server from before the ledger was re-keyed, naming it", () => {
    const error = j5ServerCompatibilityError(
      descriptor({ repositoryIdentity: true, j5Squadrons: true }),
    );
    expect(error).toMatchObject({ reason: "unsupported" });
    expect(error?.message).toBe(
      "This client requires a newer server. Update the server on Build Mac to connect.",
    );
  });

  it("connects to a server with no J5 ledger at all, whose J5 views read as unsupported", () => {
    const plain = descriptor({ repositoryIdentity: true });
    expect(j5ServerCompatibilityError(plain)).toBeNull();
    // With no capability stated, a J5 read is tried once and its 404 marks the source.
    expect(
      resolveJ5ReadSource({
        environmentId: plain.environmentId,
        environmentLabel: plain.label,
        phase: "connected",
        session: null,
        result: AsyncResult.failure(
          Cause.fail(new J5HttpError({ status: 404, detail: "Not found" })),
        ),
      }).status,
    ).toBe("unsupported");
  });
});
