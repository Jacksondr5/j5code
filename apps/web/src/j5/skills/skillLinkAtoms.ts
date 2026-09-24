import { J5_SKILL_LINK_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";

export const skillLinkEnvironment = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:j5-skill-links:list",
    tag: J5_SKILL_LINK_WS_METHODS.list,
    staleTimeMs: 0,
  }),
  preview: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:j5-skill-links:preview",
    tag: J5_SKILL_LINK_WS_METHODS.preview,
  }),
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:j5-skill-links:create",
    tag: J5_SKILL_LINK_WS_METHODS.create,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:j5-skill-links:remove",
    tag: J5_SKILL_LINK_WS_METHODS.remove,
  }),
};
