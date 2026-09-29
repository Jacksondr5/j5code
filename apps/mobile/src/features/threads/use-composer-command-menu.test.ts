import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../j5/agents/useAgentMentionPicker", () => ({
  useAgentMentionPicker: () => ({ items: [], isPending: false, error: null }),
}));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false }),
}));
vi.mock("../../j5/state", () => ({ j5Environment: { playbookLibrary: vi.fn() } }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
} from "./use-composer-command-menu";

describe("mobile slash commands", () => {
  it("inserts the registered playbook name", () => {
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/playbook deb",
        trigger: { rangeStart: 0, rangeEnd: 13 },
        item: {
          id: "playbook:debugging",
          type: "playbook",
          name: "debugging",
          label: "Debug",
          description: "",
        },
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/playbook debugging ", cursor: 20, interactionMode: null });
  });
  it("inserts a mentioned playbook name mid-message", () => {
    const draftMessage = "Please run @playbook:deb";
    expect(
      resolveComposerCommandSelection({
        draftMessage,
        trigger: { rangeStart: 11, rangeEnd: 24 },
        item: {
          id: "playbook:debugging",
          type: "playbook",
          name: "debugging",
          label: "debugging",
          description: "",
        },
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "Please run @playbook:debugging ", cursor: 31, interactionMode: null });
  });
  it("leaves the draft as typed when the mentioned playbook's file name is invalid", () => {
    expect(
      resolveComposerCommandSelection({
        draftMessage: "@playbook:rel",
        trigger: { rangeStart: 0, rangeEnd: 13 },
        item: {
          id: "playbook:Release Plan",
          type: "playbook",
          name: "Release Plan",
          label: "Release Plan",
          description: "Rename it to release-plan.yaml.",
        },
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "@playbook:rel", cursor: 13, interactionMode: null });
  });
  it("keeps the playbook command active to search names", () => {
    const item = buildComposerSlashCommandItems({
      query: "playbook",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: false,
      selectedProviderStatus: null,
    })[0];
    if (!item) throw new Error("Expected playbook command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/playbook",
        trigger: { rangeStart: 0, rangeEnd: 9 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({
      text: "/playbook ",
      cursor: 10,
      interactionMode: null,
    });
  });
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    showInteractionModeToggle: false,
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it.each([false, true])(
    "keeps native /plan with legacy mode enabled=%s",
    (allowInteractionMode) => {
      const items = buildComposerSlashCommandItems({
        query: "pl",
        atMessageStart: true,
        hasThread: true,
        allowInteractionMode,
        selectedProviderStatus: antigravity,
      });

      expect(items.map((item) => item.type)).toEqual(["slash-command", "provider-slash-command"]);
      const item = items.find((item) => item.type === "provider-slash-command");
      if (!item) throw new Error("Expected the native plan command");
      expect(
        resolveComposerCommandSelection({
          draftMessage: "/pl",
          trigger: { rangeStart: 0, rangeEnd: 3 },
          item,
          allowInteractionMode,
        }),
      ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
    },
  );

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        allowInteractionMode: true,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("still applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    // A provider switch can invalidate an open menu before a tap arrives.
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});
