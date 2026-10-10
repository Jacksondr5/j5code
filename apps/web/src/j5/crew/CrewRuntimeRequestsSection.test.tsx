import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import type { ScopedCrewRuntimeRequest } from "./crewRuntimeRequests.logic";

const OPERABLE = EnvironmentId.make("env-operate");
const READ_ONLY = EnvironmentId.make("env-read-only");
const client = vi.hoisted(() => ({
  respondCrewRuntimeRequest: vi.fn(() => Promise.resolve({})),
  refreshCrewRuntimeRequests: vi.fn(() => Promise.resolve()),
}));

// A permission atom is its environment id; only the operable environment's session may answer.
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (environmentId: string) => environmentId === "env-operate",
}));
vi.mock("../state", () => ({
  j5Environment: {
    respondCrewRuntimeRequest: { permissionAtom: (environmentId: string) => environmentId },
  },
}));
vi.mock("./crewRuntimeRequestsClient", () => client);
vi.mock("../a2a/humanInboxRefresh", () => ({ notifyHumanInboxChanged: vi.fn() }));
vi.mock("../../components/chat/ComposerPendingApprovalPanel", () => ({
  ComposerPendingApprovalPanel: () => null,
}));
vi.mock("../../components/chat/ComposerPendingApprovalActions", () => ({
  ComposerPendingApprovalActions: (props: {
    readonly requestId: string;
    readonly canRespond: boolean;
    readonly onRespondToApproval: (requestId: string, decision: "accept") => void;
  }) => (
    <button
      type="button"
      data-request={props.requestId}
      disabled={!props.canRespond}
      onClick={() => props.onRespondToApproval(props.requestId, "accept")}
    >
      Approve
    </button>
  ),
}));

import { CrewRuntimeRequestsSection } from "./CrewRuntimeRequestsSection";

const request = (environmentId: EnvironmentId, id: string): ScopedCrewRuntimeRequest => ({
  environmentId,
  threadId: ThreadId.make(`thread:${id}`),
  requestId: RuntimeRequestId.make(id),
  crewInstanceId: "crew:1",
  crewName: "Release Crew",
  projectId: "project:1",
  seat: "builder",
  threadTitle: "builder",
  createdAt: "2026-09-24T12:00:00.000Z",
  requestKind: "command",
});

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = null;
});

it("lets each seat's approval be answered only where this session may operate", async () => {
  await act(async () => {
    renderer = create(
      <CrewRuntimeRequestsSection
        requests={[request(OPERABLE, "req:operable"), request(READ_ONLY, "req:read-only")]}
        onOpenThread={() => undefined}
      />,
    );
  });
  const approve = (id: string) => renderer!.root.findByProps({ "data-request": id });
  expect(approve("req:read-only").props.disabled).toBe(true);
  expect(approve("req:operable").props.disabled).toBe(false);

  await act(async () => approve("req:operable").props.onClick());
  // The answer goes to the environment that holds the seat's thread, never another one.
  expect(client.respondCrewRuntimeRequest).toHaveBeenCalledExactlyOnceWith(OPERABLE, {
    threadId: ThreadId.make("thread:req:operable"),
    requestId: RuntimeRequestId.make("req:operable"),
    decision: "accept",
  });
});
