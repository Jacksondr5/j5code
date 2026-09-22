import { createFileRoute } from "@tanstack/react-router";
import { PlaybooksPage } from "../j5/playbooks/PlaybooksPage";

export const Route = createFileRoute("/playbooks")({ component: PlaybooksPage });
