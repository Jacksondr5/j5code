import { createFileRoute } from "@tanstack/react-router";

import { PlaybookLibrarySettings } from "../j5/playbook/PlaybookLibrarySettings";

export const Route = createFileRoute("/settings/playbooks")({ component: PlaybookLibrarySettings });
