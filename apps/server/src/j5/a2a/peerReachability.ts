import type * as NodeOS from "node:os";

import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../../startupAccess.ts";

/**
 * The origins this server thinks others might reach it at, for the check the
 * client runs before peering. A server bound to one address offers that one;
 * one bound to every interface offers each non-loopback address, only IPv4
 * ones when it is bound to every IPv4 interface alone; one that listens on
 * loopback only offers none, which the client reads as a direction it cannot
 * test. The client compares who answers each probe, so a guess that
 * lands on another server is only ever a miss.
 */
export const peerAddressOrigins = (input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces: ReturnType<typeof NodeOS.networkInterfaces>;
}): ReadonlyArray<string> => {
  const origin = (host: string) => `http://${formatHostForUrl(host)}:${String(input.port)}`;
  if (isLoopbackHost(input.host)) return [];
  if (input.host !== undefined && !isWildcardHost(input.host)) return [origin(input.host)];
  return Object.values(input.interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && !entry.address.startsWith("fe80:"))
    .filter((entry) => input.host !== "0.0.0.0" || entry.family === "IPv4")
    .map((entry) => origin(entry.address));
};
