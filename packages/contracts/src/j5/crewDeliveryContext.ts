const OPEN = "<j5_crew_delivery_context>\n";
const CLOSE = "\n</j5_crew_delivery_context>\n\n";

/** The assignment keeps its own envelope after the platform's Crew context. */
export const crewDeliveryContextPrefix = (context: string) =>
  context === ""
    ? ""
    : `${OPEN}${context.replaceAll("</j5_crew_delivery_context>", "<\\/j5_crew_delivery_context>")}${CLOSE}`;

/** Call only on platform-owned delivery message ids; ordinary authored text stays literal. */
export const crewDeliveryAssignment = (text: string) => {
  if (!text.startsWith(OPEN)) return text;
  const end = text.indexOf(CLOSE, OPEN.length);
  return end < 0 ? text : text.slice(end + CLOSE.length);
};
