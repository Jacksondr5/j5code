import { mergeHumanInboxSources } from "@t3tools/client-runtime/j5/inbox";
import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import { EnvironmentId } from "@t3tools/contracts";
import type { HumanInboxItem, HumanInboxResponse } from "@t3tools/contracts/j5";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { refresh: () => undefined } }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request-1" }));
vi.mock("./inboxSources", () => ({
  openInboxQueryAtom: (id: string) => `open:${id}`,
  answeredInboxQueryAtom: (id: string) => `answered:${id}`,
  inboxCountQueryAtom: (id: string) => `count:${id}`,
}));
vi.mock("./answerAttachmentDrafts", () => ({
  readyAnswerAttachments: () => ({ attachments: [] }),
  clearAnswerAttachments: server.cleared,
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
    }),
  );
  return null;
}
async function render(
  open: ReadonlyArray<HumanInboxItem>,
  answered: ReadonlyArray<HumanInboxItem>,
) {
  await act(async () => {
    const element = createElement(Consumer, {
      open: sources(open),
      answered: sources(answered),
      onRender: (value) => {
        answers = value;
      },
    });
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.send = server.deferred();
  server.reread = server.deferred();
  server.cleared.mockClear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
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
