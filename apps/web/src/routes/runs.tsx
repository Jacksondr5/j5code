import { createFileRoute } from "@tanstack/react-router";
import { RunsPage } from "../j5/workflow/RunsPage";
export const Route = createFileRoute("/runs")({
  validateSearch: (search: Record<string, unknown>) => ({
    runId: typeof search.runId === "string" ? search.runId : undefined,
    squadronId: typeof search.squadronId === "string" ? search.squadronId : undefined,
    newWorkflow: search.newWorkflow === true || search.newWorkflow === "true" ? true : undefined,
  }),
  component: RunsPage,
});
