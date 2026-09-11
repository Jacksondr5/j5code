import type { WorkflowDefinitionPresentation } from "@j5/workflow-contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import {
  importWorkflowDefinitions,
  listWorkflowDefinitions,
  removeWorkflowDefinition,
  setWorkflowDefinitionEnabled,
} from "./client";

export function WorkflowLibrarySettings() {
  const input = useRef<HTMLInputElement>(null);
  const [definitions, setDefinitions] = useState<readonly WorkflowDefinitionPresentation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(
    () =>
      listWorkflowDefinitions()
        .then(setDefinitions)
        .catch((cause) => setError(String(cause))),
    [],
  );
  useEffect(() => void refresh(), [refresh]);
  const run = async (operation: () => Promise<readonly WorkflowDefinitionPresentation[]>) => {
    setBusy(true);
    setError(null);
    try {
      setDefinitions(await operation());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsPageContainer>
      <SettingsSection title="Playbooks">
        <SettingsRow
          title="Playbook library"
          description="Import YAML definitions for this environment. Active runs keep their saved definition."
          control={
            <Button disabled={busy} onClick={() => input.current?.click()}>
              Import YAML
            </Button>
          }
        />
        <input
          ref={input}
          hidden
          multiple
          type="file"
          accept=".yaml,.yml,application/yaml"
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            void run(async () => {
              const contents = await Promise.all(
                files.map(async (file) => ({ name: file.name, content: await file.text() })),
              );
              try {
                return await importWorkflowDefinitions(contents);
              } catch (cause) {
                if (!String(cause).includes("Confirm replacement")) throw cause;
                if (!window.confirm(`${String(cause)}\n\nReplace the existing definitions?`))
                  return definitions;
                return importWorkflowDefinitions(contents, true);
              }
            });
          }}
        />
        {error ? (
          <p role="alert" className="rounded border border-destructive p-3 text-sm">
            {error}
          </p>
        ) : null}
        {definitions
          .filter((definition) => definition.source !== undefined)
          .map((definition) => (
            <SettingsRow
              key={`${definition.source}:${definition.id}:${definition.hash}`}
              title={definition.title ?? definition.id}
              description={
                definition.diagnostics?.length
                  ? definition.diagnostics.join("\n")
                  : `${definition.description ?? ""} Version ${definition.version}. ${definition.source ?? "shipped"}.`
              }
              control={
                definition.source === "imported" ? (
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={() =>
                        void run(() =>
                          setWorkflowDefinitionEnabled(definition.id, definition.enabled === false),
                        )
                      }
                    >
                      {definition.enabled === false ? "Enable" : "Disable"}
                    </Button>
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Remove ${definition.title ?? definition.id}? If a configured or shipped definition has the same id, it will become available again.`,
                          )
                        )
                          return;
                        void run(() => removeWorkflowDefinition(definition.id));
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                ) : undefined
              }
            />
          ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
