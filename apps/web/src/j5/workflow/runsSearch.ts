import { statusPresentation } from "./presentation";

export type RunsView = "board" | "list";
export type RunDetailTab = "overview" | "timeline";

export interface RunsSearch {
  readonly runId?: string | undefined;
  readonly squadronId?: string | undefined;
  readonly newWorkflow?: true | undefined;
  readonly view?: RunsView | undefined;
  readonly q?: string | undefined;
  readonly status?: keyof typeof statusPresentation | undefined;
  readonly page?: number | undefined;
  readonly tab?: RunDetailTab | undefined;
}

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export function parseRunsSearch(raw: Record<string, unknown>): RunsSearch {
  const status = nonEmptyString(raw.status);
  const page = typeof raw.page === "number" ? raw.page : Number(raw.page);
  return {
    runId: nonEmptyString(raw.runId),
    squadronId: nonEmptyString(raw.squadronId),
    newWorkflow: raw.newWorkflow === true || raw.newWorkflow === "true" ? true : undefined,
    view: raw.view === "board" || raw.view === "list" ? raw.view : undefined,
    q: nonEmptyString(raw.q),
    status:
      status !== undefined && status in statusPresentation
        ? (status as keyof typeof statusPresentation)
        : undefined,
    page: Number.isSafeInteger(page) && page >= 0 ? page : undefined,
    tab: raw.tab === "overview" || raw.tab === "timeline" ? raw.tab : undefined,
  };
}

export function serializeRunsSearch(search: RunsSearch): RunsSearch {
  return {
    ...(search.runId ? { runId: search.runId } : {}),
    ...(search.squadronId ? { squadronId: search.squadronId } : {}),
    ...(search.newWorkflow ? { newWorkflow: true as const } : {}),
    ...(search.view ? { view: search.view } : {}),
    ...(search.q?.trim() ? { q: search.q.trim() } : {}),
    ...(search.status ? { status: search.status } : {}),
    ...(search.page && search.page > 0 ? { page: search.page } : {}),
    ...(search.tab && search.tab !== "overview" ? { tab: search.tab } : {}),
  };
}

export const effectiveView = (search: RunsSearch): RunsView =>
  search.view ?? (search.runId ? "list" : "board");

export const effectiveTab = (search: RunsSearch, hash: string): RunDetailTab =>
  hash.replace(/^#/u, "") === "workflow-approval" ? "overview" : (search.tab ?? "overview");
