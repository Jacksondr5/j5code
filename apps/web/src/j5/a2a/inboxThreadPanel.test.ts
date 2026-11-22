import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import {
  armInboxThreadPanel,
  followInboxThreadPanelOpens,
  reachesAskingThreadPanel,
  useInboxThreadPanelStore,
} from "./inboxThreadPanel";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const askA = { ref: refA, agentLabel: "Builder" };
const askB = { ref: refB, agentLabel: "Reviewer" };

function setup() {
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  useInboxThreadPanelStore.setState({ shown: null, armed: null });
  const unsubscribe = followInboxThreadPanelOpens();
  return { [Symbol.dispose]: unsubscribe };
}

it("shows the panel a link in an ask opened, and switches when a link in another ask opens one", () => {
  using _follow = setup();
  const store = useRightPanelStore.getState();

  armInboxThreadPanel(askA);
  store.openArtifact(refA, "plan.md");
  expect(useInboxThreadPanelStore.getState().shown).toEqual(askA);

  // B's panel is open in its own thread. A commit lookup in B's ask marks a user action before it
  // resolves, and falling back to the browser changes no panel.
  store.open(refB, "artifacts");
  armInboxThreadPanel(askB);
  store.markUserAction(refB);
  expect(useInboxThreadPanelStore.getState().shown).toEqual(askA);
  // Nor does B's panel changing on its own afterwards, with the click still armed.
  store.openProactive(
    refB,
    { id: "pull-requests", kind: "pull-requests" },
    store.getUserActionRevision(refB),
  );
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB).surfaces,
  ).toContainEqual({ id: "pull-requests", kind: "pull-requests" });
  expect(useInboxThreadPanelStore.getState().shown).toEqual(askA);

  // A lookup that resolves after the click still counts as the click's.
  store.openFile(refB, "src/index.ts", 3);
  expect(useInboxThreadPanelStore.getState().shown).toEqual(askB);
});

it("shows no panel when the armed thread's action closes it", () => {
  using _follow = setup();
  armInboxThreadPanel(askA);
  useRightPanelStore.getState().close(refA);
  expect(useInboxThreadPanelStore.getState().shown).toBeNull();
});

it("forgets a click once the Inbox stops following, so a later action elsewhere is not its", () => {
  const follow = setup();
  armInboxThreadPanel(askA);
  follow[Symbol.dispose]();
  using _again = { [Symbol.dispose]: followInboxThreadPanelOpens() };
  useRightPanelStore.getState().openArtifact(refA, "plan.md");
  expect(useInboxThreadPanelStore.getState().shown).toBeNull();
});

it.each([
  ["a server that has not answered", null, false, true],
  ["a device the server cannot place", { kind: "unknown" } as const, false, true],
  ["a peer server's session", { kind: "service" } as const, false, true],
  ["a person who writes to the whole server", person(true), false, true],
  ["a narrowed person who collaborates on the thread", person(false), true, true],
  ["a narrowed person who does not", person(false), false, false],
])("for %s, links use the asking thread's panel: %#", (_name, access, operable, expected) => {
  expect(reachesAskingThreadPanel(access, operable)).toBe(expected);
});

function person(wide: boolean) {
  return {
    kind: "person" as const,
    personId: "person-1",
    name: "Sam",
    firstOwner: false,
    levels: [],
    wide,
    owner: false,
    retiredLinks: null,
  };
}
