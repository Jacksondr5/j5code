import { createFileRoute } from "@tanstack/react-router";
import { RunsPage } from "../j5/playbook/RunsPage";
import { parseRunsSearch } from "../j5/playbook/runsSearch";
export const Route = createFileRoute("/runs")({
  validateSearch: parseRunsSearch,
  component: RunsPage,
});
