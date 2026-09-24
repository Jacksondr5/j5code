export type SquadronCreationState =
  | { readonly kind: "missing-name"; readonly message: string }
  | { readonly kind: "missing-project"; readonly message: string }
  | { readonly kind: "environment-unavailable"; readonly message: string }
  | { readonly kind: "read-only-environment"; readonly message: string }
  | { readonly kind: "ready" };

/** Keeps a selected folder human-readable instead of surfacing its durable id. */
export const formatSquadronFolder = (input: {
  readonly title: string;
  readonly workspaceRoot: string;
}): string => `${input.title} — ${input.workspaceRoot}`;

/** The create form has no default folder or inferred Squadron home. */
export const resolveSquadronCreationState = (input: {
  readonly name: string;
  readonly hasSelectedProject: boolean;
  readonly environmentAvailable: boolean;
  readonly canOperate: boolean;
}): SquadronCreationState => {
  if (input.name.trim().length === 0) {
    return { kind: "missing-name", message: "Name your Squadron before creating it." };
  }
  if (!input.hasSelectedProject) {
    return {
      kind: "missing-project",
      message: "Choose one existing folder before creating a Squadron.",
    };
  }
  if (!input.environmentAvailable) {
    return {
      kind: "environment-unavailable",
      message: "Connect to this folder’s environment and load its Squadrons before creating one.",
    };
  }
  if (!input.canOperate) {
    return {
      kind: "read-only-environment",
      message: "This connection does not have permission to create Squadrons.",
    };
  }
  return { kind: "ready" };
};
