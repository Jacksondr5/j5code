/**
 * Which server, if any, the startup question is asked for now. It is asked only of a connection
 * that can manage access on a server whose owner has no name (`null`; `undefined` means the
 * connection was not told, as a guest's is not), one server at a time, in the order they are
 * listed, and not again this session for a server the person answered "Not now" for.
 */
export function serverToAskOwnerNameFor<Id>(
  servers: ReadonlyArray<{
    readonly id: Id;
    readonly ownerName: string | null | undefined;
    readonly canManage: boolean;
  }>,
  askedLater: ReadonlySet<Id>,
): Id | null {
  return (
    servers.find(
      (server) => server.ownerName === null && server.canManage && !askedLater.has(server.id),
    )?.id ?? null
  );
}
