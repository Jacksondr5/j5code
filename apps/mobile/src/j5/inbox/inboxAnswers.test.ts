import { RegistryContext } from "@effect/atom-react";
import { mergeHumanInboxSources } from "@t3tools/client-runtime/j5/inbox";
import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import { EnvironmentId } from "@t3tools/contracts";
import type { HumanInboxItem, HumanInboxResponse } from "@t3tools/contracts/j5";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  composerDraftsAtom,
  composerDraftsLoadedAtom,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { answerAttachmentDraftKey } from "./answerAttachments.logic";
import { useInboxAnswers } from "./inboxAnswers";

const server = vi.hoisted(() => {
  const deferred = () => {
    let resolve: (value: { _tag: "Success"; value: undefined }) => void = () => undefined;
    const promise = new Promise<{ _tag: "Success"; value: undefined }>((done) => {
      resolve = done;
    });
    return { promise, resolve: () => resolve({ _tag: "Success", value: undefined }) };
  };
  return { deferred, send: deferred(), reread: deferred(), cleared: vi.fn() };
});
vi.mock("../state", () => ({
  j5Environment: { answerHumanExchange: {} },
}));
vi.mock("../runCommand", () => ({ runJ5Command: () => server.send.promise }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: () => server.reread.promise,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request-1" }));
vi.mock("./inboxSources", async () => {
  const { Atom } = await import("effect/reactivity");
  const query = Atom.family((_id: string) => Atom.make(0));
  return {
    openInboxQueryAtom: query,
    answeredInboxQueryAtom: query,
    inboxCountQueryAtom: query,
  };
});
vi.mock("./answerAttachmentDrafts", () => ({
  readyAnswerAttachments: () => ({ attachments: [] }),
}));
vi.mock("./answerDrafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./answerDrafts")>()),
  clearAnswerDraft: server.cleared,
}));
// The answers are saved in upstream's composer draft store; only its file is faked.
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    exists = false;
    create() {}
    write() {}
    moveSync() {}
  },
  Paths: { document: { uri: "file:///documents" } },
}));

const ask: HumanInboxItem = {
  personId: "human:alpha",
  projectId: "project:shared",
  projectTitle: "Shared",
  exchangeId: "exchange:1",
  senderId: "agent:sender",
  senderThreadId: "thread:sender",
  intent: "Ship it?",
  urgency: "soon",
  message: "Proceed?",
  openedAt: "2026-11-19T00:00:00Z",
  status: "open",
  terminalAt: null,
};
const sources = (items: ReadonlyArray<HumanInboxItem>): J5ReadSources<HumanInboxResponse> => ({
  isReady: true,
  sources: [
    {
      environmentId: EnvironmentId.make("alpha"),
      environmentLabel: "alpha",
      connected: true,
      status: "ready",
      data: { personId: "human:alpha", items },
      error: null,
      refreshing: false,
    },
  ],
});

let answers: ReturnType<typeof useInboxAnswers>;
let renderer: ReactTestRenderer | undefined;
function Consumer(props: {
  readonly open: J5ReadSources<HumanInboxResponse>;
  readonly answered: J5ReadSources<HumanInboxResponse>;
  readonly onRender: (value: ReturnType<typeof useInboxAnswers>) => void;
}) {
  props.onRender(
    useInboxAnswers({
      openSources: props.open,
      items: mergeHumanInboxSources(props.open),
      answeredSources: props.answered,
      answered: mergeHumanInboxSources(props.answered),
      pruneClosed: true,
    }),
  );
  return null;
}
async function render(
  open: ReadonlyArray<HumanInboxItem>,
  answered: ReadonlyArray<HumanInboxItem>,
) {
  await act(async () => {
    const element = createElement(
      RegistryContext.Provider,
      { value: appAtomRegistry },
      createElement(Consumer, {
        open: sources(open),
        answered: sources(answered),
        onRender: (value) => {
          answers = value;
        },
      }),
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

beforeEach(async () => {
  await waitForComposerDraftsLoaded();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.send = server.deferred();
  server.reread = server.deferred();
  server.cleared.mockClear();
  appAtomRegistry.set(composerDraftsAtom, {});
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("keeps a half-typed answer when the person leaves the screen and comes back", async () => {
  await render([ask], []);
  const [item] = answers.shownItems;
  if (item === undefined) throw new Error("the ask is not shown");
  await act(async () => answers.setAnswerText(item, "Yes, ship it"));
  await act(async () => renderer?.unmount());
  renderer = undefined;

  await render([ask], []);

  expect(answers.answerText(item)).toBe("Yes, ship it");
});

it("drops a saved answer, words and files, once a read shows its ask closed while away", async () => {
  await render([ask], []);
  const [item] = answers.shownItems;
  if (item === undefined) throw new Error("the ask is not shown");
  await act(async () => answers.setAnswerText(item, "Yes, ship it"));
  await act(async () => renderer?.unmount());
  renderer = undefined;

  await render([], []);

  expect(appAtomRegistry.get(composerDraftsAtom)[answerAttachmentDraftKey(item)]).toBeUndefined();
});

it("keeps a draft per ask, so stepping between a Captain's asks never mixes their words", async () => {
  const second = { ...ask, exchangeId: "exchange:2", intent: "Name it?" };
  await render([ask, second], []);
  const [first, next] = answers.shownItems;
  if (first === undefined || next === undefined) throw new Error("the asks are not shown");
  await act(async () => answers.setAnswerText(first, "Yes, ship it"));
  await act(async () => answers.setAnswerText(next, "Call it Beacon"));
  expect(answers.answerText(first)).toBe("Yes, ship it");
  expect(answers.answerText(next)).toBe("Call it Beacon");
});

it("keeps the sent words on the card until the re-read takes it away, without keeping it as answered elsewhere", async () => {
  await render([ask], []);
  const [item] = answers.shownItems;
  if (item === undefined) throw new Error("the ask is not shown");
  await act(async () => answers.setAnswerText(item, "Yes, ship it"));

  let answering: Promise<void> = Promise.resolve();
  await act(async () => {
    answering = answers.answer(item);
  });
  await act(async () => server.send.resolve());
  // Accepted: the draft is gone, but the box still shows what was sent while the re-read runs.
  expect(answers.answerText(item)).toBe("Yes, ship it");
  expect(server.cleared).not.toHaveBeenCalled();

  // The open list arrives without the ask: it leaves, rather than staying as one someone else
  // answered while the person had words in it (AC17).
  await render([], [{ ...ask, status: "answered", terminalAt: "2026-11-19T00:01:00Z" }]);
  expect(answers.shownItems).toEqual([]);

  await act(async () => {
    server.reread.resolve();
    await answering;
  });
  expect(answers.pendingKey).toBeNull();
  expect(answers.answerText(item)).toBe("");
  expect(server.cleared).toHaveBeenCalledOnce();
});

it("drops a closed ask's saved answer that a restart reads back after the Inbox's first read", async () => {
  appAtomRegistry.set(composerDraftsLoadedAtom, false);
  await render([], []);

  await act(async () => {
    appAtomRegistry.set(composerDraftsAtom, {
      [answerAttachmentDraftKey({ ...ask, environmentId: EnvironmentId.make("alpha") })]: {
        text: "Yes, ship it",
        attachments: [],
      },
    });
    appAtomRegistry.set(composerDraftsLoadedAtom, true);
  });

  expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({});
});
