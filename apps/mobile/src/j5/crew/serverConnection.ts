import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentPresentation } from "../../state/presentation";

/**
 * Whether the server is connected, and its name, as upstream's screens read it. A Crew surface
 * the phone already loaded stays readable while the server is away, but takes no action.
 */
export function useServerConnection(environmentId: EnvironmentId) {
  const { presentation } = useEnvironmentPresentation(environmentId);
  return {
    connected: presentation?.connection.phase === "connected",
    label: presentation?.entry.target.label ?? "This server",
  };
}
