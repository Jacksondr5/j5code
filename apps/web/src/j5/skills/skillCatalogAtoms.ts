import { J5_SKILL_CATALOG_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

/** Web-only atoms for the J5 skill catalog RPCs. */
export const skillCatalogEnvironment = {
  status: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-skills:status",
    tag: J5_SKILL_CATALOG_WS_METHODS.getSkillCatalogStatus,
    staleTimeMs: 0,
  }),
  applyGroups: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:j5-skills:apply",
    tag: J5_SKILL_CATALOG_WS_METHODS.applySkillCatalogGroups,
  }),
  updateCatalog: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:j5-skills:update",
    tag: J5_SKILL_CATALOG_WS_METHODS.updateSkillCatalog,
  }),
};
