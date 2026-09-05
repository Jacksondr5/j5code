export type SquadronCreationState =
  | { readonly kind: "missing-name"; readonly message: string }
  | { readonly kind: "missing-project"; readonly message: string }
  | { readonly kind: "non-primary-project"; readonly message: string }
  | { readonly kind: "ready" };

export const PRIMARY_ENVIRONMENT_CREATION_REASON =
  "This v0 creation path is primary-environment only. Choose a primary-environment folder; multi-environment routing returns in the next targeting milestone.";

/** Keeps a selected folder human-readable instead of surfacing its durable id. */
export const formatSquadronFolder = (input: {
  readonly title: string;
  readonly workspaceRoot: string;
}): string => `${input.title} — ${input.workspaceRoot}`;

/** The create form has no default folder or inferred Squadron home. */
export const resolveSquadronCreationState = (input: {
  readonly name: string;
  readonly hasSelectedProject: boolean;
  readonly isPrimaryProject: boolean;
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
  if (!input.isPrimaryProject) {
    return { kind: "non-primary-project", message: PRIMARY_ENVIRONMENT_CREATION_REASON };
  }
  return { kind: "ready" };
};
