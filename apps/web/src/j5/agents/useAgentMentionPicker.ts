import { agentPersonaMentionItems } from "@t3tools/client-runtime/j5/agent-mentions";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

export function useAgentMentionPicker(
  environmentId: EnvironmentId | null,
  provider: string | undefined,
  trigger: { kind: string; query: string } | null,
) {
  const enabled =
    (provider === "codex" || provider === "claudeAgent") &&
    (trigger?.kind === "agent" || trigger?.kind === "path");
  const catalog = useEnvironmentQuery(
    enabled && environmentId !== null
      ? orchestrationEnvironment.v2.agentPersonaCatalog({ environmentId, input: {} })
      : null,
  );
  const items = useMemo(
    () => (enabled ? agentPersonaMentionItems(catalog.data, trigger?.query ?? "") : []),
    [catalog.data, enabled, trigger?.query],
  );
  return { items, isPending: catalog.isPending, error: catalog.error };
}
