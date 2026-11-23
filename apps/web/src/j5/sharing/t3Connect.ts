/**
 * Upstream's doors that need T3 Connect (the MCP "Use in another app" wizard, the Welcome page's
 * phone section, Connect device approval) lead nowhere in J5, which does not ship Connect, so J5
 * hides them the way it hides guest links (`GUEST_LINKS_OFFERED`).
 */
export const T3_CONNECT_OFFERED = false;
