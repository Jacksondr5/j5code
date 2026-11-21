import { EnvironmentId } from "@t3tools/contracts";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

// A modal dialog's backdrop sits over everything outside it, including the selects' popups,
// so the dialog renders inline here; the checkboxes, radios and buttons are the real ones.
vi.mock(import("../../components/ui/dialog"), async (importOriginal) => {
  const Part = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    ...(await importOriginal()),
    Dialog: Part as never,
    DialogDescription: Part as never,
    DialogFooter: Part as never,
    DialogHeader: Part as never,
    DialogPanel: Part as never,
    DialogPopup: Part as never,
    DialogTitle: Part as never,
  };
});

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");
const ops = vi.hoisted(() => ({
  introduce: vi.fn(),
  peerRecord: vi.fn(),
  enableLinkedEnvironments: vi.fn(),
  mintPairingCode: vi.fn(),
  link: vi.fn(),
  forget: vi.fn(),
  removePeer: vi.fn(),
}));
vi.mock(import("./linksClient"), () => ({ pairLinkOps: ops, refreshLinks: vi.fn() }) as never);
vi.mock(import("./managedLinks"), async (importOriginal) => ({
  ...(await importOriginal()),
  refreshManagedLinks: vi.fn(),
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useRelayEnvironmentDiscovery: (() => ({ environments: new Map() })) as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readPreparedConnection: (() => ({ httpBaseUrl: "http://client.example" })) as never,
}));
vi.mock(import("../peering/peeringCheck"), async (importOriginal) => ({
  ...(await importOriginal()),
  // Each server reaches the other, so the check's pick is to send directly both ways.
  runPeeringCheck: (() =>
    Promise.resolve({
      localToRemote: { kind: "reached", origin: "https://remote.example:3773" },
      remoteToLocal: { kind: "reached", origin: "https://local.example:3773" },
    })) as never,
}));

import { render } from "../../../test/render";
import { LinkServersDialog } from "./LinkServersDialog";
import type { ManagedLinks } from "./managedLinks";

function setup() {
  for (const op of Object.values(ops)) op.mockReset();
  ops.introduce.mockResolvedValue({ ok: true, steps: [] });
  ops.mintPairingCode.mockResolvedValue("code");
  ops.peerRecord.mockImplementation((_holder: string, other: string) =>
    Promise.resolve({ environmentId: other, linkMode: "push", origin: `https://${other}.example` }),
  );
}

const environmentOf = (environmentId: EnvironmentId, label: string) => ({
  environmentId,
  label,
  connection: { phase: "connected" },
  serverConfig: {
    environment: {
      label,
      serverVersion: "1.0.0",
      capabilities: { j5PeerPoll: true, peerLinks: true, serverSelfUpdate: "boot-service" },
    },
    settings: { linkedEnvironmentsEnabled: false },
  },
});
/** What the client reads of its servers; `managed` are the ones it can manage access on. */
const linksOf = (managed: ReadonlyArray<EnvironmentId>) =>
  ({
    environments: [environmentOf(LOCAL, "Local"), environmentOf(REMOTE, "Remote")],
    servers: managed,
    lists: managed.map((environmentId) => ({ environmentId, label: "", peers: [], links: [] })),
    pairs: [],
  }) as unknown as ManagedLinks;

const dialog = (managed: ReadonlyArray<EnvironmentId> = [LOCAL, REMOTE]) => (
  <LinkServersDialog
    open
    onOpenChange={() => {}}
    links={linksOf(managed)}
    defaultServerId={LOCAL}
  />
);
const linkButton = () => page.getByRole("button", { name: "Link", exact: true });
// Styles are not loaded here, so a checkbox or radio has no size to click: its label is clicked.
const tickRemote = () => page.getByText("Remote", { exact: true }).click();

describe("linking servers", () => {
  it("checks a ticked server, lets its route be changed, and links both parts", async () => {
    setup();
    await using _screen = await render(dialog());
    await expect.element(linkButton()).toBeDisabled();

    await tickRemote();
    await expect.element(page.getByText("Messages are sent directly both ways")).toBeVisible();
    await expect
      .element(page.getByText("Turns on Linked environments on Local and Remote."))
      .toBeVisible();

    await page.getByRole("button", { name: "Change Remote" }).click();
    await page.getByText("Remote polls Local", { exact: true }).click();
    await expect.element(page.getByText("Remote polls Local for messages")).toBeVisible();

    await linkButton().click();
    await expect.element(page.getByText("Linked for messages and tools both ways.")).toBeVisible();
    expect(ops.introduce).toHaveBeenCalledTimes(1);
    expect(ops.introduce.mock.calls[0]![0]).toMatchObject({ connections: "remote-only" });
    expect(ops.enableLinkedEnvironments.mock.calls.map(([id]) => id)).toEqual([LOCAL, REMOTE]);
    expect(ops.link.mock.calls.map(([holder, link]) => [holder, link.access])).toEqual([
      [LOCAL, "approval-required"],
      [REMOTE, "approval-required"],
    ]);
  });

  it("stops offering a ticked server once this client can no longer manage it", async () => {
    setup();
    await using screen = await render(dialog());
    await tickRemote();
    await expect.element(linkButton()).toBeEnabled();

    await screen.rerender(dialog([LOCAL]));
    await expect.element(page.getByText("This app can't manage access there")).toBeVisible();
    await expect.element(linkButton()).toBeDisabled();
    expect(ops.introduce).not.toHaveBeenCalled();
  });
});
