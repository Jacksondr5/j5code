import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import { shouldRefuseComposerSteer } from "./submitGuard";

describe("composer steer availability with upstream dispatch policy", () => {
  it.each(["preparing", "starting", "waiting", "finalizing"] as const)(
    "refuses ordinary Send during %s while explicit queue and non-turn answers remain available",
    (phase) => {
      const input = {
        steerState: { kind: "not-steerable" as const, phase, runId: RunId.make("active") },
        isEditingQueuedMessage: false,
        isAnsweringQuestion: false,
      };
      expect(
        shouldRefuseComposerSteer({
          ...input,
          dispatchMode: resolveComposerDispatchMode({ running: true, alternateModifier: false }),
        }),
      ).toBe(true);
      expect(
        shouldRefuseComposerSteer({
          ...input,
          dispatchMode: resolveComposerDispatchMode({ running: true, alternateModifier: true }),
        }),
      ).toBe(false);
      expect(
        shouldRefuseComposerSteer({
          ...input,
          dispatchMode: "steer",
          isEditingQueuedMessage: true,
        }),
      ).toBe(false);
      expect(
        shouldRefuseComposerSteer({ ...input, dispatchMode: "steer", isAnsweringQuestion: true }),
      ).toBe(false);
      expect(shouldRefuseComposerSteer({ ...input, dispatchMode: "restart" })).toBe(false);
      // With follow-ups set to queue, plain Send queues and only the alternate tries to steer.
      const queueFirst = (alternateModifier: boolean) =>
        resolveComposerDispatchMode({
          running: true,
          alternateModifier,
          activeTurnDefault: "queue",
        });
      expect(shouldRefuseComposerSteer({ ...input, dispatchMode: queueFirst(false) })).toBe(false);
      expect(shouldRefuseComposerSteer({ ...input, dispatchMode: queueFirst(true) })).toBe(true);
    },
  );
});
