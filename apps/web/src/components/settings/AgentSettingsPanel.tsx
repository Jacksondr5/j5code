import { presentAgentPersonaCatalog } from "@t3tools/client-runtime/state/agent-personas";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function AgentSettingsPanel() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedEnvironments = useMemo(
    () =>
      environments.toSorted((left, right) => {
        const leftPrimary = left.environmentId === primaryEnvironmentId;
        const rightPrimary = right.environmentId === primaryEnvironmentId;
        return Number(rightPrimary) - Number(leftPrimary) || left.label.localeCompare(right.label);
      }),
    [environments, primaryEnvironmentId],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = orderedEnvironments.some(
    (environment) => environment.environmentId === selectedEnvironmentId,
  )
    ? selectedEnvironmentId
    : (orderedEnvironments[0]?.environmentId ?? null);
  const selectedEnvironment = orderedEnvironments.find(
    (environment) => environment.environmentId === effectiveEnvironmentId,
  );
  const catalog = useEnvironmentQuery(
    effectiveEnvironmentId === null
      ? null
      : orchestrationEnvironment.v2.agentPersonaCatalog({
          environmentId: effectiveEnvironmentId,
          input: {},
        }),
  );
  const personas =
    catalog.data === null || catalog.data === undefined
      ? []
      : presentAgentPersonaCatalog(catalog.data);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Agents">
        <SettingsRow
          title="Built-in agent catalog"
          description="Skill orchestrators invoke these scoped agents. They are not selected directly when starting a task."
        />
        {orderedEnvironments.length > 1 ? (
          <SettingsRow
            title="Environment"
            description="Availability and model routing are resolved by the selected environment."
            control={
              <Select
                value={effectiveEnvironmentId ?? undefined}
                onValueChange={(value) => {
                  const environment = orderedEnvironments.find(
                    (candidate) => candidate.environmentId === value,
                  );
                  if (environment) setSelectedEnvironmentId(environment.environmentId);
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Agent environment">
                  <SelectValue>{selectedEnvironment?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {orderedEnvironments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Scoped agents">
        {effectiveEnvironmentId === null ? (
          <SettingsRow
            title={isReady ? "No connected environments" : "Loading environments"}
            description="Connect an environment to inspect its built-in agents."
          />
        ) : catalog.isPending ? (
          <SettingsRow title="Loading agents" description="Reading the built-in agent catalog." />
        ) : catalog.error ? (
          <SettingsRow
            title="Agents unavailable"
            description="This environment could not return its built-in agent catalog."
          />
        ) : (
          personas.map((persona) => (
            <SettingsRow
              key={persona.personaId}
              title={persona.displayName}
              description={persona.description}
              control={
                <Badge variant={persona.availability === "available" ? "success" : "outline"}>
                  {persona.availabilityLabel}
                </Badge>
              }
              status={
                <div className="grid gap-1 sm:grid-cols-2">
                  <span>Input: {persona.acceptedInput}</span>
                  <span>Output: {persona.outputArtifact}</span>
                  <span>Authority: {persona.authority}</span>
                  <span>Route: {persona.route}</span>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
