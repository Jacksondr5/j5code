export type PersonaSheetAction = "edit" | "duplicate" | "export" | "copy" | "remove" | "restore";

/** What a persona's sheet offers, in order. A removed persona offers only Restore. */
export function personaSheetActions(
  persona: { readonly removed: boolean; readonly editable: boolean },
  hasOtherEnvironments: boolean,
): ReadonlyArray<PersonaSheetAction> {
  if (persona.removed) return ["restore"];
  return [
    ...(persona.editable ? (["edit"] as const) : []),
    "duplicate",
    "export",
    ...(hasOtherEnvironments ? (["copy"] as const) : []),
    "remove",
  ];
}

/** The one word a Personas row shows under the name; the sheet holds the detail behind it. */
export function personaRowMarker(persona: {
  readonly removed: boolean;
  readonly blocked: boolean;
  readonly overrideLabel: string | null;
}): { readonly label: string; readonly tone: "muted" | "danger" } | null {
  if (persona.removed) return { label: "Removed", tone: "muted" };
  if (persona.blocked) return { label: "Blocked", tone: "danger" };
  if (persona.overrideLabel !== null) return { label: persona.overrideLabel, tone: "muted" };
  return null;
}
