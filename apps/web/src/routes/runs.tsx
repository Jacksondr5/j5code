import { createFileRoute } from "@tanstack/react-router";
import { RunsPage } from "../j5/workflow/RunsPage";
import { parseRunsSearch } from "../j5/workflow/runsSearch";
export const Route = createFileRoute("/runs")({
  validateSearch: parseRunsSearch,
  component: RunsPage,
});
