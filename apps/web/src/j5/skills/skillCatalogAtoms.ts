import { SKILL_CATALOG_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

export const skillCatalog = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:skill-catalog",
  tag: SKILL_CATALOG_METHODS.read,
  staleTimeMs: 0,
});

export const applySkillGroups = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "skill-catalog:apply",
  tag: SKILL_CATALOG_METHODS.apply,
});
