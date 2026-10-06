import {
  ProviderDriverKind,
  type AgentPersonaAuthorityPolicy,
  type AgentPersonaPolicyEnforcement,
  type RuntimeMode,
} from "@t3tools/contracts";

import { getAgentAuthorityRules } from "./agentPersonas.ts";

export interface AgentPersonaProviderPolicy {
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

/** Drivers whose sandbox enforces each policy's workspace boundary; nothing else is promised. */
const ENFORCING_DRIVERS = {
  "read-only": ["codex", "claudeAgent"],
  "critic-review": ["codex", "claudeAgent"],
  "workspace-write": ["codex"],
  "critic-fix": ["codex"],
  diagnostic: [],
  "publish-only": [],
} as const satisfies Record<AgentPersonaAuthorityPolicy, ReadonlyArray<string>>;

export function providerCanEnforceAgentPersonaAuthority(
  driver: string,
  authorityPolicy: AgentPersonaAuthorityPolicy,
): boolean {
  return (ENFORCING_DRIVERS[authorityPolicy] as ReadonlyArray<string>).includes(driver);
}

/** The catalog's copy of the table, so persona editors show it without a second client copy. */
export const agentPersonaPolicyEnforcement = (): ReadonlyArray<AgentPersonaPolicyEnforcement> =>
  Object.entries(ENFORCING_DRIVERS).map(([policy, drivers]) => ({
    policy: policy as AgentPersonaAuthorityPolicy,
    drivers: drivers.map((driver) => ProviderDriverKind.make(driver)),
  }));

export function translateAgentPersonaProviderPolicy(
  authorityPolicy: AgentPersonaAuthorityPolicy,
  driver: string,
): AgentPersonaProviderPolicy {
  if (!providerCanEnforceAgentPersonaAuthority(driver, authorityPolicy)) {
    return READ_ONLY_POLICY;
  }

  switch (getAgentAuthorityRules(authorityPolicy).workspace) {
    case "read-only":
      return READ_ONLY_POLICY;
    case "write":
    case "diagnostic-write":
      return WORKSPACE_WRITE_POLICY;
    case "publication-only":
      return READ_ONLY_POLICY;
  }
}
