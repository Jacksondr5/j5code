import { assert, describe, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import { resolveProviderCompatibility } from "../provider/providerCompatibility.ts";

describe("J5_UPSTREAM_T3_CODE_VERSION", () => {
  // The bundled table is written for the pinned code, so the pinned code's version must select
  // each harness's newest policy. A stale version falls onto an older policy, or onto none.
  it("selects the newest bundled compatibility policy for every built-in harness", () => {
    const policies = ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility;
    for (const { driverKind } of BUILT_IN_DRIVERS) {
      // Registry entries are arbitrary external ACP agents, not one versioned harness.
      if (driverKind === "acpRegistry") continue;
      const selected = resolveProviderCompatibility(policies, driverKind, null);
      assert.isDefined(selected, `No bundled compatibility policy for ${driverKind}`);
      assert.deepStrictEqual(
        selected,
        resolveProviderCompatibility(policies, driverKind, null, "9999.0.0"),
        `${driverKind} is not on its newest bundled compatibility policy`,
      );
    }
  });
});
