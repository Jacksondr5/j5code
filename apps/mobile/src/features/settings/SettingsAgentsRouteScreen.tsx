import { presentAgentPersonaCatalog } from "@t3tools/client-runtime/state/agent-personas";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState } from "react";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsAgentsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const effectiveEnvironmentId = connectedEnvironments.some(
    (environment) => environment.environmentId === selectedEnvironmentId,
  )
    ? selectedEnvironmentId
    : (connectedEnvironments[0]?.environmentId ?? null);
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
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Agents" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Built-in agents">
          <View className="rounded-2xl bg-card px-4 py-3">
            <Text className="text-base text-foreground">
              Skill orchestrators invoke these scoped agents. They are not selected directly when
              starting a task.
            </Text>
          </View>
        </SettingsSection>

        {connectedEnvironments.length > 1 ? (
          <SettingsSection title="Environment">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {connectedEnvironments.map((environment) => {
                  const selected = environment.environmentId === effectiveEnvironmentId;
                  return (
                    <Pressable
                      key={environment.environmentId}
                      accessibilityLabel={environment.environmentLabel}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      className={cn(
                        "rounded-full border px-4 py-2",
                        selected ? "border-primary bg-primary/10" : "border-border bg-card",
                      )}
                      onPress={() => setSelectedEnvironmentId(environment.environmentId)}
                    >
                      <Text className="text-sm font-t3-medium text-foreground">
                        {environment.environmentLabel}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </SettingsSection>
        ) : null}

        <SettingsSection title="Scoped agents">
          <View className="gap-2">
            {effectiveEnvironmentId === null ? (
              <AgentMessage title="No connected environments" />
            ) : catalog.isPending ? (
              <AgentMessage title="Loading agents" />
            ) : catalog.error ? (
              <AgentMessage title="Agents unavailable" />
            ) : (
              personas.map((persona) => {
                const available = persona.availability === "available";
                return (
                  <View key={persona.personaId} className="gap-2 rounded-2xl bg-card px-4 py-3">
                    <View className="flex-row items-center gap-3">
                      <Text className="min-w-0 flex-1 text-lg font-t3-semibold text-foreground">
                        {persona.displayName}
                      </Text>
                      <Text
                        className={cn(
                          "text-xs font-t3-medium",
                          available ? "text-foreground" : "text-foreground-muted",
                        )}
                      >
                        {persona.availabilityLabel}
                      </Text>
                    </View>
                    <Text className="text-sm text-foreground-muted">{persona.description}</Text>
                    <View className="gap-1 border-t border-border-subtle pt-2">
                      <AgentDetail label="Input" value={persona.acceptedInput} />
                      <AgentDetail label="Output" value={persona.outputArtifact} />
                      <AgentDetail label="Authority" value={persona.authority} />
                      <AgentDetail label="Route" value={persona.route} />
                    </View>
                  </View>
                );
              })
            )}
          </View>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function AgentMessage(props: { readonly title: string }) {
  return (
    <View className="rounded-2xl bg-card px-4 py-4">
      <Text className="text-base text-foreground-muted">{props.title}</Text>
    </View>
  );
}

function AgentDetail(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row gap-3">
      <Text className="w-20 text-xs font-t3-medium text-foreground-muted">{props.label}</Text>
      <Text className="min-w-0 flex-1 text-xs text-foreground">{props.value}</Text>
    </View>
  );
}
