import { AGENT_PERSONA_IMPORT_CONFIRMATION_MESSAGE } from "@t3tools/client-runtime/j5/agent-personas";
import type {
  AgentPersonaImportConflict,
  AgentPersonaImportConflictError,
} from "@t3tools/contracts";
import { useState } from "react";
import { Switch } from "../../components/ui/switch";

export function AgentImportConflictSelection(props: {
  error: AgentPersonaImportConflictError;
  onChange: (selected: ReadonlyArray<AgentPersonaImportConflict>) => void;
}) {
  const [selected, setSelected] = useState(props.error.conflicts);
  return (
    <div className="space-y-4">
      <p>{props.error.message}</p>
      <p>{AGENT_PERSONA_IMPORT_CONFIRMATION_MESSAGE}</p>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {props.error.conflicts.map((conflict) => {
          const checked = selected.some(({ personaId }) => personaId === conflict.personaId);
          return (
            <label
              key={conflict.personaId}
              className="flex items-center justify-between gap-4 rounded-md border border-border p-3"
            >
              <span className="min-w-0 break-words">
                <span className="block font-medium">{conflict.displayName}</span>
                <span className="block text-xs text-muted-foreground">
                  {conflict.personaId} · {checked ? "Replace" : "Skip"}
                </span>
              </span>
              <Switch
                aria-label={`Replace ${conflict.displayName} (${conflict.personaId})`}
                checked={checked}
                onCheckedChange={(enabled) => {
                  const next = enabled
                    ? [...selected, conflict]
                    : selected.filter(({ personaId }) => personaId !== conflict.personaId);
                  setSelected(next);
                  props.onChange(next);
                }}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
