import { agentPersonaMentionItems } from "@t3tools/client-runtime/j5/agent-mentions";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { agentPersonaEnvironment } from "./agentPersonaAtoms";
import { useEnvironmentQuery } from "../../state/query";

export function useAgentMentionPicker(
  environmentId: EnvironmentId | null,
  provider: string | undefined,
  trigger: { kind: string; query: string } | null,
) {
  const enabled = (provider === "codex" || provider === "claudeAgent") && trigger?.kind === "agent";
  const catalog = useEnvironmentQuery(
    enabled && environmentId !== null
      ? agentPersonaEnvironment.catalog({ environmentId, input: {} })
      : null,
  );
  const items = useMemo(
    () => (enabled ? agentPersonaMentionItems(catalog.data, trigger?.query ?? "") : []),
    [catalog.data, enabled, trigger?.query],
  );
  return { items, isPending: catalog.isPending, error: catalog.error };
}
