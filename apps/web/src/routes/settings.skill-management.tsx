import { createFileRoute } from "@tanstack/react-router";
import { SkillManagementSettings } from "../j5/skills/SkillManagementSettings";

export const Route = createFileRoute("/settings/skill-management")({
  component: SkillManagementSettings,
});
