import { assert, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";

import {
  applyCodexFastModeAvailability,
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  readCodexFastModeEnabled,
} from "./CodexProvider.ts";

it.effect.each([false, true])(
  "uses effective fast-mode enablement %s from later feature pages",
  (effectiveEnabled) =>
    Effect.gen(function* () {
      const enabled = yield* readCodexFastModeEnabled(({ cursor }) =>
        Effect.succeed(
          cursor === "next"
            ? {
                data: [
                  {
                    name: "fast_mode",
                    enabled: effectiveEnabled,
                    defaultEnabled: !effectiveEnabled,
                    stage: "stable",
                  },
                ],
              }
            : { data: [], nextCursor: "next" },
        ),
      );
      assert.strictEqual(enabled, effectiveEnabled);
    }),
);

it("keeps Standard metadata for custom models that only declared a legacy fast toggle", () => {
  const [model] = applyCodexFastModeAvailability(
    [
      {
        slug: "custom",
        name: "Custom",
        isCustom: true,
        capabilities: { optionDescriptors: [{ id: "fastMode", label: "Fast", type: "boolean" }] },
      },
    ],
    false,
  );
  // An empty capability set would let provider snapshot merging restore the old Fast toggle.
  assert.deepStrictEqual(model?.capabilities?.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      currentValue: "default",
      options: [{ id: "default", label: "Standard", isDefault: true }],
    },
  ]);
});

it.effect("preserves unknown enablement when the feature or RPC is unavailable", () =>
  Effect.gen(function* () {
    assert.isUndefined(yield* readCodexFastModeEnabled(() => Effect.succeed({ data: [] })));
    assert.isUndefined(
      yield* readCodexFastModeEnabled(() =>
        Effect.fail(CodexAppServerRequestError.internalError("Method not found")),
      ),
    );
  }),
);

it.effect("does not let feature discovery stall the provider probe", () =>
  Effect.gen(function* () {
    const fiber = yield* readCodexFastModeEnabled(() => Effect.never).pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    assert.isUndefined(yield* Fiber.join(fiber));
  }),
);

it.each(["priority", "fast"])(
  "removes disabled %s from built-in and custom models and saved selections",
  (tier) => {
    const capabilities = mapCodexModelCapabilities({
      id: "test",
      model: "test",
      displayName: "Test",
      description: "",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [],
      defaultServiceTier: tier,
      additionalSpeedTiers: ["fast"],
      ...(tier === "priority"
        ? { serviceTiers: [{ id: tier, name: "Fast", description: "" }] }
        : {}),
    });
    const models: ServerProviderModel[] = [false, true].map((isCustom) => ({
      slug: isCustom ? "custom" : "test",
      name: "Test",
      isCustom,
      capabilities,
    }));
    const filtered = applyCodexFastModeAvailability(models, false);
    for (const model of filtered) {
      const selections = [{ id: "serviceTier", value: tier }];
      const descriptors = getProviderOptionDescriptors({ caps: model.capabilities!, selections });
      assert.deepStrictEqual(descriptors, [
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [{ id: "default", label: "Standard", isDefault: true }],
          currentValue: "default",
        },
      ]);
      assert.deepStrictEqual(
        buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, selections),
        [{ id: "serviceTier", value: "default" }],
      );
    }
    // A new probe after re-enabling Fast must restore the original catalog options.
    assert.strictEqual(applyCodexFastModeAvailability(models, true), models);
    assert.strictEqual(applyCodexFastModeAvailability(models, undefined), models);
  },
);

it("preserves non-fast tiers and reasoning while removing custom legacy fast toggles", () => {
  const reasoning = {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [{ id: "medium", label: "Medium" }],
  } as const;
  const [model] = applyCodexFastModeAvailability(
    [
      {
        slug: "custom",
        name: "Custom",
        isCustom: true,
        capabilities: {
          optionDescriptors: [
            reasoning,
            { id: "fastMode", label: "Fast", type: "boolean", currentValue: true },
            {
              id: "serviceTier",
              label: "Tier",
              type: "select",
              currentValue: "flex",
              options: [
                { id: "priority", label: "Fast" },
                { id: "flex", label: "Flex", isDefault: true },
              ],
            },
          ],
        },
      },
    ],
    false,
  );
  const descriptors = model?.capabilities?.optionDescriptors;
  assert.deepStrictEqual(descriptors?.[0], reasoning);
  assert.strictEqual(descriptors?.length, 2);
  assert.strictEqual(descriptors?.[1]?.currentValue, "flex");
  assert.deepStrictEqual(
    descriptors?.[1]?.type === "select" ? descriptors[1].options.map((option) => option.id) : [],
    ["default", "flex"],
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
