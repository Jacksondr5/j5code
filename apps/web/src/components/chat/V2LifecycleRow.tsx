import { Fragment } from "react";
import type {
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  ArrowRightLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  GitForkIcon,
  MessageSquareIcon,
  MinusIcon,
  type LucideIcon,
  XIcon,
} from "lucide-react";

import { getProviderInstanceEntry } from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { PROVIDER_ICON_BY_PROVIDER, getTriggerDisplayModelName } from "./providerIconUtils";
import { TimelineSystemDivider } from "./TimelineSystemDivider";

const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "subagent",
  "thread_created",
]);

export function isV2LifecycleItem(item: OrchestrationV2TurnItem): boolean {
  return LIFECYCLE_TYPES.has(item.type);
}

// Aborted subagents (cancelled/interrupted) keep whatever result text had
// streamed before the abort, so only completed/failed results are final.
const FINAL_RESULT_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
]);

// Once a subagent stops, its last streamed result says more than the stale
// progress line; while it runs, live progress comes first.
const TERMINAL_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * The subset of a projection run that handoff rows read. Kept minimal so the
 * timeline can hold a content-stable snapshot: run status/timestamps churn on
 * every stream event, but these fields only change when a run is added.
 */
export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  if (item.type === "run_interrupt_request") {
    return (
      <div className="flex justify-end px-1 py-1" data-v2-item-type={item.type}>
        <div className="flex max-w-[80%] items-center gap-2 text-xs text-destructive">
          <span aria-hidden="true" className="font-mono">
            ■
          </span>
          <span className="font-medium">Interrupt requested</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span className="font-medium">{item.message}</span>
          <span className="text-[10px] text-muted-foreground">
            {formatShortTimestamp(props.createdAt, props.timestampFormat)}
          </span>
        </div>
      </div>
    );
  }
  if (item.type === "run_interrupt_result") {
    return (
      <TimelineSystemDivider
        label="Run interrupted"
        detail={item.message}
        tone="danger"
        icon={XIcon}
      />
    );
  }
  if (item.type === "compaction") {
    const tokenDetail =
      item.beforeTokenCount === undefined && item.afterTokenCount === undefined
        ? null
        : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
    return (
      <TimelineSystemDivider
        label="Context compacted"
        detail={item.summary ?? tokenDetail}
        icon={MinusIcon}
      />
    );
  }
  if (item.type === "handoff") {
    // Items persisted before models were stamped only carry instance ids;
    // recover the models from the thread's runs (the handoff's own run is
    // the target, the newest earlier run per source instance is the origin).
    // HandoffEndpoint falls back to the provider display name when neither
    // source has a model.
    const handoffRun =
      item.runId === null ? undefined : props.runs.find((run) => run.id === item.runId);
    const toModel =
      item.toModel ??
      (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
        ? handoffRun.modelSelection.model
        : undefined);
    const fromEndpoints: ReadonlyArray<{
      readonly instanceId: ProviderInstanceId;
      readonly model?: string | undefined;
    }> =
      item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
        ? item.fromModelSelections
        : item.fromProviderInstanceIds.map((instanceId) => ({
            instanceId,
            model: latestRunModelBefore(props.runs, instanceId, handoffRun?.ordinal),
          }));
    return (
      <TimelineSystemDivider
        label="Context handoff"
        icon={ArrowRightLeftIcon}
        showDetailSeparator={false}
        tone={item.status === "failed" ? "danger" : "neutral"}
        detail={
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {fromEndpoints.map((endpoint, index) => (
              <Fragment key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}>
                {index > 0 ? (
                  <span aria-hidden="true" className="-ml-1">
                    ,
                  </span>
                ) : null}
                <HandoffEndpoint
                  providers={props.providerStatuses}
                  instanceId={endpoint.instanceId}
                  model={endpoint.model}
                />
              </Fragment>
            ))}
            {fromEndpoints.length > 0 ? (
              <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
            ) : null}
            <HandoffEndpoint
              providers={props.providerStatuses}
              instanceId={item.toProviderInstanceId}
              model={toModel}
            />
          </span>
        }
      />
    );
  }
  if (item.type === "fork") {
    const relatedThreadId = item.source.type === "run" ? item.source.threadId : item.targetThreadId;
    return (
      <TimelineSystemDivider
        label={item.source.type === "run" ? "Forked from conversation" : "Conversation fork"}
        icon={GitForkIcon}
        actionLabel={item.source.type === "run" ? "Open source conversation" : "Open fork"}
        onAction={() => props.onOpenThread(relatedThreadId)}
      />
    );
  }
  if (item.type === "thread_created") {
    return (
      <RelatedThreadCard
        itemType={item.type}
        icon={MessageSquareIcon}
        title={item.title ?? "Created thread"}
        detail={`${item.targetProviderInstanceId} · ${item.targetModel}`}
        badge="created"
        threadId={item.targetThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  if (item.type === "subagent") {
    const streamedResult = item.result?.trim() ? item.result : null;
    const genericSuccess =
      item.status === "completed" &&
      streamedResult !== null &&
      /^(ok|done|complete|completed|success|succeeded)[.!]?$/i.test(streamedResult);
    const meaningfulResult = genericSuccess ? null : streamedResult;
    const finalResult = FINAL_RESULT_SUBAGENT_STATUSES.has(item.status) ? meaningfulResult : null;
    const detail = TERMINAL_SUBAGENT_STATUSES.has(item.status)
      ? (meaningfulResult ?? item.progress ?? (item.status === "completed" ? null : item.prompt))
      : (item.progress ?? meaningfulResult ?? item.prompt);
    return (
      <RelatedThreadCard
        itemType={item.type}
        icon={BotIcon}
        title={formatSubagentDisplayTitle(item.title ?? "Subagent")}
        detail={detail}
        badge={item.status}
        threadId={item.childThreadId}
        expandedDetail={finalResult}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return null;
}

function RelatedThreadCard(props: {
  readonly itemType: "subagent" | "thread_created";
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string | null;
  readonly expandedDetail?: string | null;
  readonly badge: string;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const Icon = props.icon;
  const threadId = props.threadId;
  const expandedDetail = props.expandedDetail ?? null;
  const badgeLabel = props.badge
    .replaceAll(/[-_]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
  const badgeClass =
    props.badge === "completed"
      ? "border-success/25 bg-success/10 text-success-foreground"
      : props.badge === "failed"
        ? "border-destructive/25 bg-destructive/10 text-destructive-foreground"
        : props.badge === "running" || props.badge === "pending" || props.badge === "waiting"
          ? "border-info/25 bg-info/10 text-info-foreground"
          : "border-border/70 bg-muted/30 text-muted-foreground";
  const content = (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/65 text-muted-foreground shadow-xs/5">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[.82rem] font-semibold tracking-tight">
        {props.title}
      </span>
      {props.detail === null ? null : (
        <span className="max-w-[46%] truncate text-xs text-muted-foreground">{props.detail}</span>
      )}
      <span
        className={`inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[.65rem] font-medium ${badgeClass}`}
      >
        {props.badge === "completed" ? <CheckIcon className="size-2.5" aria-hidden="true" /> : null}
        {badgeLabel}
      </span>
    </>
  );

  if (expandedDetail !== null) {
    return (
      <div
        data-v2-item-type={props.itemType}
        className="relative min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5"
      >
        <details className="group" data-v2-subagent-result-disclosure="true">
          <summary
            aria-label={`Show full result for ${props.title}`}
            className="flex min-w-0 cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 pr-11 text-left transition-colors hover:bg-muted/45 [&::-webkit-details-marker]:hidden"
          >
            {content}
            <ChevronDownIcon
              className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="border-border/60 border-t px-3 py-2" data-v2-subagent-result="true">
            <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
              {expandedDetail}
            </p>
          </div>
        </details>
        {threadId === null ? null : (
          <button
            type="button"
            aria-label={`Open ${props.title}`}
            onClick={() => props.onOpenThread(threadId)}
            className="absolute right-1.5 top-1.5 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  return threadId === null ? (
    <div
      data-v2-item-type={props.itemType}
      className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 shadow-xs/5"
    >
      {content}
    </div>
  ) : (
    <button
      type="button"
      data-v2-item-type={props.itemType}
      aria-label={`Open ${props.title}`}
      onClick={() => props.onOpenThread(threadId)}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 text-left shadow-xs/5 transition-colors hover:bg-muted/45"
    >
      {content}
      <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/**
 * Model of the newest run for `instanceId` that started before the handoff's
 * own run. Legacy handoff items don't record their source models, but the
 * covered runs are still in the projection.
 */
function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

/**
 * One side of a context handoff: the provider's brand icon plus the model's
 * display name. Falls back to the raw model slug when the instance no longer
 * lists it, and to the instance display name (or id) when no model was
 * recorded on the item.
 */
function HandoffEndpoint(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}) {
  const entry = getProviderInstanceEntry(props.providers, props.instanceId);
  const Icon = entry === undefined ? null : (PROVIDER_ICON_BY_PROVIDER[entry.driverKind] ?? null);
  const model = props.model?.trim();
  const providerModel =
    model === undefined || model.length === 0
      ? undefined
      : entry?.models.find((candidate) => candidate.slug === model);
  const label =
    providerModel !== undefined
      ? getTriggerDisplayModelName(providerModel)
      : model !== undefined && model.length > 0
        ? model
        : (entry?.displayName ?? props.instanceId);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {Icon === null ? null : <Icon aria-hidden="true" className="size-3 shrink-0" />}
      <span className="max-w-40 truncate">{label}</span>
    </span>
  );
}
