import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveComposerDispatchMode } from "../../components/chat/composerDispatch";
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
          dispatchMode: resolveComposerDispatchMode({ phase: "running", queueModifier: false }),
        }),
      ).toBe(true);
      expect(
        shouldRefuseComposerSteer({
          ...input,
          dispatchMode: resolveComposerDispatchMode({ phase: "running", queueModifier: true }),
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
    },
  );
});
