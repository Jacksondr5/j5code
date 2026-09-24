import { createFileRoute } from "@tanstack/react-router";

import { HumanInboxPage } from "../j5/a2a/HumanInboxPage";

export const Route = createFileRoute("/inbox")({
  component: HumanInboxPage,
});
