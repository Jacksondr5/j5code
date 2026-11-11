import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

/** Reject unsupported selections instead of letting a provider silently fall back to a default. */
export function crewModelSelectionProblem(
  selection: ModelSelection,
  provider: ServerProvider,
): string | null {
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (model === undefined)
    return `Provider ${selection.instanceId} does not advertise ${selection.model}.`;
  const seen = new Set<string>();
  for (const option of selection.options ?? []) {
    if (seen.has(option.id)) return `Model ${selection.model} repeats option ${option.id}.`;
    seen.add(option.id);
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === option.id,
    );
    if (descriptor === undefined)
      return `Model ${selection.model} does not advertise option ${option.id}.`;
    if (
      descriptor.type === "boolean"
        ? typeof option.value !== "boolean"
        : typeof option.value !== "string" ||
          !descriptor.options.some((choice) => choice.id === option.value)
    )
      return `Model ${selection.model} does not support ${option.id}=${String(option.value)}.`;
  }
  return null;
}
