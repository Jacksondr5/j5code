import { AGENT_PERSONA_IMPORT_CONFIRMATION_MESSAGE } from "@t3tools/client-runtime/j5/agent-personas";
import type {
  AgentPersonaImportConflict,
  AgentPersonaImportConflictError,
} from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Sheet } from "../../components/ui/Sheet";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { cn } from "../../lib/cn";

/** Which conflicting personas an import replaces. Closing the sheet cancels the import. */
export function AgentImportConflictSheet(props: {
  error: AgentPersonaImportConflictError;
  onConfirm: (selected: ReadonlyArray<AgentPersonaImportConflict> | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState(props.error.conflicts);
  const count = selected.length;
  return (
    <Sheet title="Replace existing personas?" onClose={() => props.onConfirm(null)}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(20, insets.bottom) }}
      >
        <View className="gap-1 px-2">
          <Text className="text-sm text-foreground">{props.error.message}</Text>
          <Text className="text-sm text-foreground-muted">
            {AGENT_PERSONA_IMPORT_CONFIRMATION_MESSAGE}
          </Text>
        </View>
        <SettingsSection>
          {props.error.conflicts.map((conflict, index) => (
            <View
              key={conflict.personaId}
              className={cn(index > 0 && "border-t border-border-subtle")}
            >
              <ListToggleRow
                label={conflict.displayName}
                description={conflict.personaId}
                value={selected.some(({ personaId }) => personaId === conflict.personaId)}
                onValueChange={(enabled) =>
                  setSelected(
                    enabled
                      ? [...selected, conflict]
                      : selected.filter(({ personaId }) => personaId !== conflict.personaId),
                  )
                }
              />
            </View>
          ))}
        </SettingsSection>
        {/* With nothing to replace, the import still adds any definitions that don't conflict. */}
        <Button
          label={
            count === 0
              ? "Import without replacing"
              : `Replace ${count} ${count === 1 ? "persona" : "personas"}`
          }
          tone={count === 0 ? "secondary" : "danger"}
          fullWidth
          onPress={() => props.onConfirm(selected)}
        />
      </ScrollView>
    </Sheet>
  );
}
