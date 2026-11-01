export type PersonaRowAction = "edit" | "duplicate" | "export" | "copy" | "remove" | "restore";

/** What a Personas settings row offers, in menu order. A removed persona offers only Restore. */
export function personaRowActions(
  persona: { readonly removed: boolean; readonly editable: boolean },
  hasOtherEnvironments: boolean,
): ReadonlyArray<PersonaRowAction> {
  if (persona.removed) return ["restore"];
  return [
    ...(persona.editable ? (["edit"] as const) : []),
    "duplicate",
    "export",
    ...(hasOtherEnvironments ? (["copy"] as const) : []),
    "remove",
  ];
}
