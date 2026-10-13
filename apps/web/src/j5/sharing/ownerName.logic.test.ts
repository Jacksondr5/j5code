import { describe, expect, it } from "vite-plus/test";

import { serverToAskOwnerNameFor } from "./ownerName.logic";

const server = (id: string, ownerName: string | null | undefined, canManage = true) => ({
  id,
  ownerName,
  canManage,
});

describe("asking the owner of a server for their name at startup", () => {
  it("asks on a server whose owner has no name yet", () => {
    expect(serverToAskOwnerNameFor([server("a", null)], new Set())).toBe("a");
  });

  it("never asks once a name is set, on any device", () => {
    expect(serverToAskOwnerNameFor([server("a", "Jackson M.")], new Set())).toBeNull();
  });

  it("never asks a guest, nor before the server has answered", () => {
    expect(serverToAskOwnerNameFor([server("a", undefined)], new Set())).toBeNull();
  });

  it("never asks a connection that cannot manage access", () => {
    expect(serverToAskOwnerNameFor([server("a", null, false)], new Set())).toBeNull();
  });

  it("does not ask again this session after Not now, and moves on to the next server", () => {
    const servers = [server("a", null), server("b", null)];
    expect(serverToAskOwnerNameFor(servers, new Set())).toBe("a");
    expect(serverToAskOwnerNameFor(servers, new Set(["a"]))).toBe("b");
    expect(serverToAskOwnerNameFor(servers, new Set(["a", "b"]))).toBeNull();
  });
});
