import { createFileRoute } from "@tanstack/react-router";

import { SkillCatalogSettings } from "../j5/skills/SkillCatalogSettings";

export const Route = createFileRoute("/settings/skills")({ component: SkillCatalogSettings });
