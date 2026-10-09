import { createFileRoute } from "@tanstack/react-router";

import { FleetPage } from "../j5/fleet/FleetPage";

export const Route = createFileRoute("/fleet")({
  component: FleetPage,
});
