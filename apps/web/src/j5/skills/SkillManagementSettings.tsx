import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { skillLinkUnavailableReason } from "@t3tools/contracts";
import { SkillLinksPanel, type SkillLinkSelection } from "./SkillLinksPanel";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { getDriverOption } from "../../components/settings/providerDriverMeta";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Input } from "../../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildSkillInventory,
  filterSkillInventory,
  missingSkillLabel,
  SKILL_ORIGINS,
  skillDiscoveryState,
  type SkillOrigin,
} from "./skillInventory";

const SKILL_ORIGIN_DESCRIPTIONS = {
  Plugin:
    "From installed plugins’ skill folders, such as those under ~/.codex/plugins or ~/.claude/plugins.",
  Catalog:
    "From your configured skill catalog directory or T3’s cached catalog checkout, including skills linked to those locations.",
  Project:
    "Reported for the selected project or workspace, usually from folders such as .agents/skills or .claude/skills inside the project.",
  Personal:
    "Reported for your user account, usually from folders such as ~/.agents/skills, ~/.codex/skills, or ~/.claude/skills. Custom provider homes may use different paths.",
  "Built-in":
    "Reported by the provider as built-in, system, or administrator-managed skills. Their locations depend on the provider and installation.",
  Other:
    "Discovered by a provider, but its reported scope and file location do not identify one of the categories above.",
} satisfies Record<SkillOrigin, string>;

function providerLabel(provider: ServerProvider, providers: ReadonlyArray<ServerProvider>) {
  const label = provider.displayName ?? provider.driver;
  return providers.filter((entry) => entry.driver === provider.driver).length > 1
    ? `${label} (${provider.instanceId})`
    : label;
}

function SkillRecordDetails({ skill }: { readonly skill: ServerProviderSkill }) {
  return (
    <div className="space-y-1">
      <p className="font-medium">{skill.name}</p>
      {(skill.description ?? skill.shortDescription) ? (
        <p>{skill.description ?? skill.shortDescription}</p>
      ) : null}
      <p>
        {skill.enabled ? "Enabled" : "Disabled"}
        {skill.userInvocationOnly ? " · User only" : ""}
        {skill.userInvocable === false ? " · Agent only" : ""}
      </p>
      {skill.pluginId ? <p>Plugin: {skill.pluginId}</p> : null}
      <p>{skill.path}</p>
      <p>{skill.linkTarget ? `Resolved: ${skill.linkTarget}` : "Resolved location unavailable"}</p>
    </div>
  );
}

export function SkillManagementSettings() {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId =
    environments.find((environment) => environment.environmentId === (selected ?? primaryId))
      ?.environmentId ?? environments[0]?.environmentId;
  return (
    <SettingsPageContainer width="expanded">
      <SettingsSection
        id="skill-management"
        title="Skill Management"
        description="Inspect discovered skills and link standalone skills to Codex or Claude. Paths refer to the selected environment; ~ means its user home. Hover or focus a skill or provider status to see its exact source and resolved paths. Running sessions may discover additional skills."
      >
        <div className="grid min-w-0 gap-4 p-4">
          <label className="grid gap-2 text-sm">
            Environment
            <Select
              value={environmentId ?? ""}
              onValueChange={(value) => {
                const environment = environments.find(
                  (candidate) => candidate.environmentId === value,
                );
                if (environment) setSelected(environment.environmentId);
              }}
            >
              <SelectTrigger aria-label="Skill inventory environment">
                <SelectValue>
                  {environments.find((environment) => environment.environmentId === environmentId)
                    ?.label ?? "No environments"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environments.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          {environmentId ? (
            <SkillInventoryPanel key={environmentId} environmentId={environmentId} />
          ) : (
            <p>Connect an environment to view its skills.</p>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function SkillInventoryPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState<string | null>(null);
  const project =
    projectId === ""
      ? undefined
      : (projects.find((entry) => entry.id === projectId) ?? projects[0]);
  const cwd = project?.workspaceRoot;
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const providerOptions = useMemo(
    () =>
      providers.filter(
        (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
      ),
    [providers],
  );
  const [filter, setFilter] = useState<ProviderInstanceId | undefined>();
  const selectedProvider = providerOptions.find((provider) => provider.instanceId === filter);
  const selectedProviders = useMemo(
    () => (selectedProvider ? [selectedProvider] : providers),
    [selectedProvider, providers],
  );
  const [query, setQuery] = useState("");
  const [linkSelection, setLinkSelection] = useState<SkillLinkSelection | null>(null);
  const [collapsedOrigins, setCollapsedOrigins] = useState<ReadonlySet<SkillOrigin>>(new Set());
  const connected = environment?.connection.phase === "connected";
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const attempted = useRef({ selection: "", instances: new Set<ProviderInstanceId>() });
  const [failures, setFailures] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const scopeKey = (instanceId: ProviderInstanceId) => JSON.stringify([instanceId, cwd]);

  useEffect(() => {
    const selection = JSON.stringify([cwd, selectedProvider?.instanceId, connected]);
    if (attempted.current.selection !== selection) {
      attempted.current = { selection, instances: new Set() };
    }
    if (!connected || !cwd) return;
    for (const provider of selectedProviders) {
      if (
        !provider.enabled ||
        !provider.installed ||
        provider.availability === "unavailable" ||
        provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
      )
        continue;
      const key = JSON.stringify([provider.instanceId, cwd]);
      if (attempted.current.instances.has(provider.instanceId)) continue;
      attempted.current.instances.add(provider.instanceId);
      void refresh({ environmentId, input: { instanceId: provider.instanceId, cwd } }).then(
        (result) => {
          setFailures((previous) => {
            if (result._tag === "Failure") return new Set(previous).add(key);
            if (!previous.has(key)) return previous;
            const next = new Set(previous);
            next.delete(key);
            return next;
          });
        },
      );
    }
  }, [
    connected,
    cwd,
    environmentId,
    selectedProviders,
    selectedProvider?.instanceId,
    refresh,
    attempted,
  ]);

  const catalogSource = environment?.serverConfig?.settings.skillCatalogSource;
  const rows = buildSkillInventory(providers, cwd, catalogSource);
  const visibleRows = filterSkillInventory(rows, query, selectedProvider?.instanceId);
  // Search should not change the columns, and refresh still includes empty providers.
  const displayedProviders =
    selectedProvider || rows.length === 0
      ? selectedProviders
      : selectedProviders.filter((provider) =>
          rows.some((row) => row.records.has(provider.instanceId)),
        );
  const stateOf = (provider: (typeof providers)[number]) =>
    failures.has(scopeKey(provider.instanceId))
      ? ("failed" as const)
      : !connected
        ? ("not-checked" as const)
        : skillDiscoveryState(provider, cwd);

  async function refreshInventory() {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    try {
      await Promise.all(
        selectedProviders.map(async (provider) => {
          const key = scopeKey(provider.instanceId);
          // No cwd: the explicit instance refresh replaces its cached workspaces.
          const result = await refresh({
            environmentId,
            input: { instanceId: provider.instanceId },
          });
          if (
            result._tag === "Success" &&
            cwd &&
            !result.value.providers
              .find((entry) => entry.instanceId === provider.instanceId)
              ?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
          ) {
            const workspace = await refresh({
              environmentId,
              input: { instanceId: provider.instanceId, cwd },
            });
            setFailures((previous) => {
              const next = new Set(previous);
              if (workspace._tag === "Failure") next.add(key);
              else next.delete(key);
              return next;
            });
          } else {
            setFailures((previous) => {
              const next = new Set(previous);
              if (result._tag === "Failure") next.add(key);
              else next.delete(key);
              return next;
            });
          }
        }),
      );
    } finally {
      busy.current = false;
      setRefreshing(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-2 text-sm">
          Project
          <Select
            value={project?.id ?? ""}
            onValueChange={(value) => {
              setProjectId(value ?? "");
              setLinkSelection(null);
            }}
          >
            <SelectTrigger aria-label="Skill inventory project">
              <SelectValue>{project?.title ?? "Environment only"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">Environment only</SelectItem>
              {projects.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="grid gap-2 text-sm">
          Provider instance
          <Select
            value={selectedProvider?.instanceId ?? ""}
            onValueChange={(value) =>
              setFilter(
                providerOptions.find((provider) => provider.instanceId === value)?.instanceId,
              )
            }
          >
            <SelectTrigger aria-label="Skill inventory provider">
              <SelectValue>
                {selectedProvider?.displayName ?? selectedProvider?.instanceId ?? "All providers"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">All providers</SelectItem>
              {providerOptions.map((provider) => (
                <SelectItem key={provider.instanceId} value={provider.instanceId}>
                  {provider.displayName ?? provider.instanceId} ({provider.instanceId})
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
      </div>
      <div className="flex gap-2">
        <Input
          aria-label="Search skill inventory"
          placeholder="Search names, descriptions, paths, or plugin IDs"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (event.target.value.trim()) setCollapsedOrigins(new Set());
          }}
        />
        <Button
          variant="outline"
          disabled={!connected || refreshing || providers.length === 0}
          onClick={() => void refreshInventory()}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground" role="status">
        {!connected ? <p>Environment disconnected. Cached results may be stale.</p> : null}
        {displayedProviders.map((provider) => {
          const state = stateOf(provider);
          const Icon = getDriverOption(provider.driver)?.icon;
          const workspace = cwd
            ? provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)
            : undefined;
          return (
            <p key={provider.instanceId} className="flex min-w-0 items-center gap-1.5">
              {Icon ? <Icon aria-hidden className="size-3 shrink-0" /> : null}
              <span>
                {providerLabel(provider, displayedProviders)}:{" "}
                {state === "checked"
                  ? `Checked ${workspace?.checkedAt ?? provider.checkedAt}`
                  : `${missingSkillLabel(state)}. Cached results may be stale.`}
              </span>
            </p>
          );
        })}
      </div>
      <div
        aria-label="Skill status legend"
        className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      >
        <Badge size="sm" variant="success">
          Enabled
        </Badge>
        <span>·</span>
        <Badge size="sm" variant="secondary">
          Disabled
        </Badge>
        <span>· Not detected ·</span>
        <Badge size="sm" variant="warning">
          Not checked / Refresh failed (stale)
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{visibleRows.length} skill locations</p>
      {visibleRows.length ? (
        <div className="grid min-w-0 gap-4">
          {SKILL_ORIGINS.map((origin) => {
            const group = visibleRows.filter((row) => row.origin === origin);
            if (!group.length) return null;
            return (
              <Collapsible
                key={origin}
                open={!collapsedOrigins.has(origin)}
                onOpenChange={(open) => {
                  setCollapsedOrigins((previous) => {
                    const next = new Set(previous);
                    if (open) next.delete(origin);
                    else next.add(origin);
                    return next;
                  });
                }}
                className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card/40"
              >
                <h3>
                  <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-2 bg-muted/40 px-3 py-2 text-left text-sm font-medium hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                    <ChevronRightIcon
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground group-data-panel-open:rotate-90"
                    />
                    <span className="flex-1">{origin}</span>
                    <span className="text-xs font-normal tabular-nums text-muted-foreground">
                      {group.length}
                      <span className="sr-only"> skill locations</span>
                    </span>
                  </CollapsibleTrigger>
                </h3>
                <p className="bg-muted/40 pr-3 pb-3 pl-9 text-xs leading-relaxed text-muted-foreground">
                  {SKILL_ORIGIN_DESCRIPTIONS[origin]}
                </p>
                <CollapsiblePanel className="border-t border-border/60 transition-none duration-0">
                  <Table aria-label={`${origin} skill inventory`} className="min-w-160 table-fixed">
                    <colgroup>
                      <col className="w-[40%]" />
                      <col className="w-[16%]" />
                      {displayedProviders.map((provider) => (
                        <col key={provider.instanceId} />
                      ))}
                    </colgroup>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Skill</TableHead>
                        <TableHead>Flags</TableHead>
                        {displayedProviders.map((provider) => {
                          const Icon = getDriverOption(provider.driver)?.icon;
                          const label = providerLabel(provider, displayedProviders);
                          return (
                            <TableHead key={provider.instanceId}>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span
                                      tabIndex={0}
                                      className="flex min-w-0 items-center gap-1"
                                    />
                                  }
                                >
                                  {Icon ? <Icon aria-hidden className="size-3 shrink-0" /> : null}
                                  <span className="truncate">{label}</span>
                                </TooltipTrigger>
                                <TooltipPopup>{label}</TooltipPopup>
                              </Tooltip>
                            </TableHead>
                          );
                        })}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.map((row) => {
                        const selectedRecords = displayedProviders.flatMap((provider) =>
                          (row.records.get(provider.instanceId) ?? []).map((skill) => ({
                            provider,
                            skill,
                          })),
                        );
                        const first = selectedRecords[0]!.skill;
                        const pluginIds = [
                          ...new Set(
                            selectedRecords.flatMap(({ skill }) =>
                              skill.pluginId ? [skill.pluginId] : [],
                            ),
                          ),
                        ];
                        return (
                          <TableRow key={row.key}>
                            <TableCell className="min-w-0 py-1">
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span
                                      tabIndex={0}
                                      className="flex min-w-0 items-center gap-2"
                                    />
                                  }
                                >
                                  <span className="max-w-full shrink-0 truncate font-medium">
                                    {first.displayName ?? first.name}
                                  </span>
                                  <span className="truncate text-muted-foreground">
                                    {first.description ?? first.shortDescription}
                                  </span>
                                </TooltipTrigger>
                                <TooltipPopup className="max-w-md whitespace-normal break-words">
                                  <SkillRecordDetails skill={first} />
                                </TooltipPopup>
                              </Tooltip>
                              {skillLinkUnavailableReason(row.origin) ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <span
                                        tabIndex={0}
                                        className="text-xs text-muted-foreground"
                                      />
                                    }
                                  >
                                    Link unavailable
                                  </TooltipTrigger>
                                  <TooltipPopup className="max-w-md">
                                    {skillLinkUnavailableReason(row.origin)}
                                  </TooltipPopup>
                                </Tooltip>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={!connected}
                                  onClick={() =>
                                    setLinkSelection({
                                      source: {
                                        instanceId: selectedRecords[0]!.provider.instanceId,
                                        path: first.path,
                                        name: first.name,
                                      },
                                      origin: row.origin,
                                    })
                                  }
                                >
                                  Use in…
                                </Button>
                              )}
                            </TableCell>
                            <TableCell className="py-1">
                              <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                                {selectedRecords.some(({ skill }) => skill.userInvocationOnly) ? (
                                  <Badge size="sm" variant="outline">
                                    User only
                                  </Badge>
                                ) : null}
                                {selectedRecords.some(
                                  ({ skill }) => skill.userInvocable === false,
                                ) ? (
                                  <Badge size="sm" variant="outline">
                                    Agent only
                                  </Badge>
                                ) : null}
                                <span className="truncate text-muted-foreground">
                                  {pluginIds.join(", ")}
                                </span>
                              </div>
                            </TableCell>
                            {displayedProviders.map((provider) => {
                              const records = row.records.get(provider.instanceId);
                              const state = stateOf(provider);
                              const label = providerLabel(provider, displayedProviders);
                              return (
                                <TableCell key={provider.instanceId} className="py-1">
                                  {records ? (
                                    <div className="grid min-w-0 grid-cols-1 justify-items-start gap-1">
                                      {records.map((skill) => {
                                        const status =
                                          state === "checked"
                                            ? skill.enabled
                                              ? "Enabled"
                                              : "Disabled"
                                            : `${missingSkillLabel(state)} · Stale`;
                                        return (
                                          <Tooltip
                                            key={JSON.stringify([
                                              skill.path,
                                              skill.name,
                                              skill.pluginId,
                                            ])}
                                          >
                                            <TooltipTrigger
                                              render={
                                                <span
                                                  tabIndex={0}
                                                  className="max-w-full"
                                                  aria-label={`${label}: ${skill.name} · ${status}`}
                                                />
                                              }
                                            >
                                              <Badge
                                                size="sm"
                                                variant={
                                                  state !== "checked"
                                                    ? "warning"
                                                    : skill.enabled
                                                      ? "success"
                                                      : "secondary"
                                                }
                                                className="max-w-full"
                                              >
                                                <span className="truncate">{status}</span>
                                              </Badge>
                                            </TooltipTrigger>
                                            <TooltipPopup className="max-w-md whitespace-normal break-words">
                                              <p className="font-medium">
                                                {label}: {status}
                                              </p>
                                              <SkillRecordDetails skill={skill} />
                                            </TooltipPopup>
                                          </Tooltip>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <span
                                            tabIndex={0}
                                            className="block truncate text-muted-foreground"
                                          />
                                        }
                                      >
                                        {missingSkillLabel(state)}
                                      </TooltipTrigger>
                                      <TooltipPopup>
                                        {label}: {missingSkillLabel(state)}
                                      </TooltipPopup>
                                    </Tooltip>
                                  )}
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CollapsiblePanel>
              </Collapsible>
            );
          })}
        </div>
      ) : null}
      <SkillLinksPanel
        environmentId={environmentId}
        connected={connected}
        providers={providers}
        {...(project ? { projectId: project.id, projectTitle: project.title } : {})}
        selection={linkSelection}
        onClose={() => setLinkSelection(null)}
      />
      {!visibleRows.length ? (
        <p className="text-sm text-muted-foreground">
          No skills reported for this selection. Discovery status is shown above.
        </p>
      ) : null}
    </div>
  );
}
