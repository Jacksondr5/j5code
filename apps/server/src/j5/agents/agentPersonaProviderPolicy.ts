import {
  isAgentPersonaAuthorityPolicy,
  ProviderDriverKind,
  type AgentPersonaAuthorityPolicy,
  type AgentPersonaAccess,
  type AgentPersonaPolicyEnforcement,
  type AgentPersonaReportedAuthorityPolicy,
  type RuntimeMode,
} from "@t3tools/contracts";

import { mapAgentPersonaPolicy } from "./agentPersonas.ts";

/** A restricted policy asks the provider for an explicit sandbox; full access adds no J5 restriction. */
export type AgentPersonaProviderPolicy =
  | {
      readonly runtimeMode: RuntimeMode;
      readonly approvalPolicy?: "never";
      readonly sandboxPolicy:
        | {
            readonly type: "readOnly";
            readonly access: { readonly type: "fullAccess" };
            readonly networkAccess: false;
          }
        | { readonly type: "workspaceWrite"; readonly networkAccess: false };
    }
  | { readonly runtimeMode: "full-access" };

const READ_ONLY_POLICY = {
  runtimeMode: "approval-required",
  approvalPolicy: "never",
  sandboxPolicy: {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false,
  },
} as const satisfies AgentPersonaProviderPolicy;

const WORKSPACE_WRITE_POLICY = {
  runtimeMode: "auto-accept-edits",
  approvalPolicy: "never",
  sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
} as const satisfies AgentPersonaProviderPolicy;

/** The ordinary full-access runtime mode; adapters derive their native behavior from it. */
const FULL_ACCESS_POLICY = {
  runtimeMode: "full-access",
} as const satisfies AgentPersonaProviderPolicy;

/** Drivers whose adapter applies native full-access behavior for the ordinary full-access mode. */
const FULL_ACCESS_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "grok",
  "antigravity",
  "pi",
  "acpRegistry",
] as const;

/** Drivers whose sandbox enforces each policy's workspace boundary; nothing else is promised. */
const ENFORCING_DRIVERS = {
  "read-only": ["codex", "claudeAgent"],
  "workspace-write": ["codex"],
  "full-access": FULL_ACCESS_DRIVERS,
} as const satisfies Record<AgentPersonaAccess, ReadonlyArray<string>>;

/** Policies this server does not know (persisted by a newer one) are never enforceable. */
export function providerCanEnforceAgentPersonaAuthority(
  driver: string,
  authorityPolicy: AgentPersonaReportedAuthorityPolicy,
): boolean {
  if (!isAgentPersonaAuthorityPolicy(authorityPolicy)) return false;
  const access = mapAgentPersonaPolicy(authorityPolicy);
  return (
    access !== "diagnostic" &&
    access !== "publish-only" &&
    (ENFORCING_DRIVERS[access] as ReadonlyArray<string>).includes(driver)
  );
}

/** The catalog's copy of the table, so persona editors show it without a second client copy. */
export const agentPersonaPolicyEnforcement = (): ReadonlyArray<AgentPersonaPolicyEnforcement> =>
  Object.entries(ENFORCING_DRIVERS).map(([policy, drivers]) => ({
    policy,
    drivers: drivers.map((driver) => ProviderDriverKind.make(driver)),
  }));

export function translateAgentPersonaProviderPolicy(
  authorityPolicy: AgentPersonaAuthorityPolicy,
  driver: string,
): AgentPersonaProviderPolicy {
  // Callers reject unknown policies first; one reaching here is a bug, never a quiet read-only run.
  if (!isAgentPersonaAuthorityPolicy(authorityPolicy)) {
    throw new Error(`Unknown agent persona authority policy: ${String(authorityPolicy)}`);
  }
  if (!providerCanEnforceAgentPersonaAuthority(driver, authorityPolicy)) {
    return READ_ONLY_POLICY;
  }

  switch (mapAgentPersonaPolicy(authorityPolicy)) {
    case "workspace-write":
      return WORKSPACE_WRITE_POLICY;
    case "full-access":
      return FULL_ACCESS_POLICY;
    default:
      return READ_ONLY_POLICY;
  }
}
