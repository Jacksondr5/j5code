import { createFileRoute } from "@tanstack/react-router";

import { WorkflowLibrarySettings } from "../j5/workflow/WorkflowLibrarySettings";

export const Route = createFileRoute("/settings/workflows")({ component: WorkflowLibrarySettings });
