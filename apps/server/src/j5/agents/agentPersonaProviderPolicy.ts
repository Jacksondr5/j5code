import type { AgentPersonaAuthorityPolicy, RuntimeMode } from "@t3tools/contracts";

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

export function providerCanEnforceAgentPersonaAuthority(
  driver: string,
  authorityPolicy: AgentPersonaAuthorityPolicy,
): boolean {
  switch (authorityPolicy) {
    case "read-only":
    case "critic-review":
      return driver === "codex" || driver === "claudeAgent";
    case "workspace-write":
    case "critic-fix":
      return driver === "codex";
    case "diagnostic":
    case "publish-only":
      return false;
  }
}

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
