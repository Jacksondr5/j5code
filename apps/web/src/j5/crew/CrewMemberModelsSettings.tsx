import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import {
  crewMemberModelCounts,
  isCrewMemberModelChecked,
  isCrewMemberProviderSetUp,
  type CrewMemberModel,
  type CrewMemberModels,
} from "@t3tools/contracts/j5";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../../components/settings/useScopedSettings";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Toggle } from "../../components/ui/toggle";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { agentPersonaEnvironment } from "../agents/agentPersonaAtoms";
import {
  crewMemberModelsSummary,
  personasOffCrewMemberModels,
  setCrewMemberModelChecked,
  setCrewMemberProviderChecked,
} from "./crewMemberModels.logic";

const NO_ENVIRONMENT = "" as EnvironmentId;

/**
 * The same "New" tag the composer's model picker shows for a model carrying the catalog's `new`
 * badge.
 */
function NewTag() {
  return (
    <span
      className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
      aria-label="New model"
    >
      New
    </span>
  );
}

function ProviderModels(props: {
  readonly provider: ServerProvider;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly entry: ReturnType<typeof deriveProviderInstanceEntries>[number];
  readonly list: CrewMemberModels;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChange: (next: ReadonlyArray<CrewMemberModel>) => void;
}) {
  const { provider, entry, list } = props;
  const { checked, total } = crewMemberModelCounts(list, [provider]);
  const Chevron = props.open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="rounded-lg border bg-card">
      <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <ProviderInstanceIcon
              driverKind={entry.driverKind}
              displayName={entry.displayName}
              acpRegistryIconUrl={entry.acpRegistryIconUrl}
              iconClassName="size-3.5"
            />
            <span className="truncate font-medium text-foreground">{entry.displayName}</span>
          </CollapsibleTrigger>
          <span className="shrink-0 text-muted-foreground">
            {checked} of {total}
          </span>
          <Button
            size="micro"
            variant="ghost-muted"
            onClick={() =>
              props.onChange(
                setCrewMemberProviderChecked(list, props.providers, provider, checked < total),
              )
            }
          >
            {checked < total ? "Check all" : "Uncheck all"}
          </Button>
        </div>
        <CollapsiblePanel>
          <ul className="flex flex-wrap gap-1.5 px-3 pb-3">
            {provider.models.map((model) => {
              const pair = { instanceId: provider.instanceId, model: model.slug };
              const isChecked = isCrewMemberModelChecked(list, pair);
              return (
                <li key={model.slug}>
                  <Toggle
                    variant="outline"
                    size="compact"
                    pressed={isChecked}
                    onPressedChange={(next) =>
                      props.onChange(setCrewMemberModelChecked(list, props.providers, pair, next))
                    }
                  >
                    {isChecked ? <CheckIcon aria-hidden="true" /> : null}
                    <span className="min-w-0 truncate">{model.name}</span>
                    {model.badge === "new" ? <NewTag /> : null}
                  </Toggle>
                </li>
              );
            })}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/**
 * Which models custom Crew members, and plain agents started without a persona, may run on.
 * Personas keep their own model, and native subagents are outside the list on every provider
 * (docs/j5/product/crews.md).
 */
export function CrewMemberModelsSettings() {
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(["crewMemberModels"]);
  const updateSettings = useUpdateScopedSettings();
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const list = settings.crewMemberModels;
  const [open, setOpen] = useState(false);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const providers = useAtomValue(
    serverEnvironment.providersValueAtom(environmentId ?? NO_ENVIRONMENT),
  );
  const catalog = useEnvironmentQuery(
    environmentId === null ? null : agentPersonaEnvironment.catalog({ environmentId, input: {} }),
  );
  const entries = useMemo(() => deriveProviderInstanceEntries(providers ?? []), [providers]);
  const known = providers ?? [];
  const setUp = entries.filter((entry) => isCrewMemberProviderSetUp(entry.snapshot));
  const notSetUp = entries.filter((entry) => !isCrewMemberProviderSetUp(entry.snapshot));
  const summary = crewMemberModelsSummary(list, known);
  const offList = personasOffCrewMemberModels(catalog.data, list);
  const save = (next: ReadonlyArray<CrewMemberModel>) => updateSettings({ crewMemberModels: next });
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  return (
    <SettingsRow
      id="crew-member-models"
      title="Models for custom members"
      description="The models custom Crew members, and agents started without a persona, may run on. Until you save a list every model is allowed, and a model added later starts unchecked."
      serverScoped
      settingKeys={["crewMemberModels"]}
      mixed={mixed}
      status={
        summary.nothingEligible && !mixed ? (
          <span className="inline-flex items-center gap-1.5 text-warning-foreground">
            <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0" />
            Nothing is checked, so no custom member or plain agent can start.
          </span>
        ) : null
      }
      resetAction={
        list !== null ? (
          <SettingResetButton
            label="Models for custom members"
            tooltip="Reset to every model"
            onClick={() => updateSettings({ crewMemberModels: null })}
          />
        ) : null
      }
      control={
        <Button
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-controls="crew-member-models-panel"
          disabled={environmentId === null}
          onClick={() => {
            setOpen((value) => !value);
            setOpenProvider((current) => current ?? setUp[0]?.instanceId ?? null);
          }}
        >
          {mixed ? "Mixed" : summary.label}
          <Chevron aria-hidden="true" />
        </Button>
      }
    >
      {open && environmentId !== null ? (
        <div id="crew-member-models-panel" className="space-y-2 pb-3 pt-1">
          {mixed ? (
            <p className="text-xs text-muted-foreground">
              The selected environments differ. Changing a model sets this list on all of them.
            </p>
          ) : null}
          {setUp.map((entry) => (
            <ProviderModels
              key={entry.instanceId}
              provider={entry.snapshot}
              providers={known}
              entry={entry}
              list={list}
              open={openProvider === entry.instanceId}
              onOpenChange={(next) => setOpenProvider(next ? entry.instanceId : null)}
              onChange={save}
            />
          ))}
          {notSetUp.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Not set up: {notSetUp.map((entry) => entry.displayName).join(", ")}.{" "}
              <Link to="/settings/providers" className="underline underline-offset-2">
                Set them up in Providers
              </Link>
              .
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Personas always run on their own model, even one that isn't checked.
            {offList.length > 0
              ? ` ${offList.join(", ")} ${offList.length === 1 ? "runs" : "run"} on a model that isn't checked.`
              : ""}{" "}
            This list doesn't cover native subagents, which Codex, Claude and Cursor start on a
            model of their own choosing.
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}
