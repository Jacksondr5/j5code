import { createFileRoute } from "@tanstack/react-router";

import { SkillInstallerSettings } from "../j5/skills/SkillInstallerSettings";

export const Route = createFileRoute("/settings/skills")({ component: SkillInstallerSettings });
