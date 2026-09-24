import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderSessionId, ProviderThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderAdapterResumeThreadError } from "../../orchestration-v2/ProviderAdapter.ts";
import {
  MINIMUM_CODEX_CLI_VERSION,
  assertSupportedCodexCliVersion,
  codexCliVersionFromUserAgent,
  compareCodexCliVersions,
  findCodexCliVersionUnsupportedError,
} from "./CodexCliVersionGate.ts";

describe("CodexCliVersionGate", () => {
  it("reads the CLI version from the initialize userAgent", () => {
    assert.strictEqual(
      codexCliVersionFromUserAgent(
        "t3code_desktop/0.152.1 (Mac OS 26.4.1; arm64) dumb (t3code_desktop; 0.1.0)",
      ),
      "0.152.1",
    );
    assert.strictEqual(
      codexCliVersionFromUserAgent("t3code_desktop/0.124.0-alpha.3"),
      "0.124.0-alpha.3",
    );
    assert.isNull(codexCliVersionFromUserAgent("codex 0.152.1"));
    assert.isNull(codexCliVersionFromUserAgent(""));
  });

  it("orders versions numerically with prereleases below their release", () => {
    assert.strictEqual(compareCodexCliVersions("0.152.1", "0.151.0"), 1);
    assert.strictEqual(compareCodexCliVersions("0.9.9", "0.151.0"), -1);
    assert.strictEqual(compareCodexCliVersions("0.151.0-alpha.1", "0.151.0"), -1);
    assert.strictEqual(compareCodexCliVersions("1.0.0", "0.999.0"), 1);
    assert.strictEqual(compareCodexCliVersions("0.151.0", "0.151.0"), 0);
  });

  it.effect("accepts the floor and newer CLIs", () =>
    Effect.gen(function* () {
      yield* assertSupportedCodexCliVersion(`t3code_desktop/${MINIMUM_CODEX_CLI_VERSION}`);
      yield* assertSupportedCodexCliVersion("t3code_desktop/0.152.1 (Linux)");
    }),
  );

  it.effect("fails closed for older and unparseable CLIs with the named message", () =>
    Effect.gen(function* () {
      const older = yield* assertSupportedCodexCliVersion(
        "t3code_desktop/0.120.0 (Mac OS 26.4.1; arm64)",
      ).pipe(Effect.flip);
      assert.strictEqual(older._tag, "CodexCliVersionUnsupportedError");
      assert.strictEqual(older.message, "J5 requires Codex CLI ≥ 0.151.0; found 0.120.0");

      const unknown = yield* assertSupportedCodexCliVersion("codex-app-server").pipe(Effect.flip);
      assert.strictEqual(
        unknown.message,
        'J5 requires Codex CLI ≥ 0.151.0; found unknown (userAgent "codex-app-server")',
      );
    }),
  );

  it.effect("finds the gate error inside adapter error chains and nowhere else", () =>
    Effect.gen(function* () {
      const gate = yield* assertSupportedCodexCliVersion("t3code_desktop/0.120.0").pipe(
        Effect.flip,
      );
      const wrapped = new ProviderAdapterResumeThreadError({
        driver: ProviderDriverKind.make("codex"),
        providerSessionId: ProviderSessionId.make("session"),
        providerThreadId: ProviderThreadId.make("thread"),
        cause: gate,
      });
      assert.strictEqual(findCodexCliVersionUnsupportedError(wrapped), gate);
      assert.isUndefined(findCodexCliVersionUnsupportedError(new Error("other")));
      assert.isUndefined(findCodexCliVersionUnsupportedError(null));
    }),
  );
});
