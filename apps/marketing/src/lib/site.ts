export const GITHUB_REPOSITORY_URL = "https://github.com/Jacksondr5/j5code";
export const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
export const LICENSE_URL = `${GITHUB_REPOSITORY_URL}/blob/j5/main/LICENSE`;
export const PRODUCT_DOCS_URL = `${GITHUB_REPOSITORY_URL}/tree/j5/main/docs/j5/product`;
export const FORK_DISCIPLINE_URL = `${GITHUB_REPOSITORY_URL}/blob/j5/main/FORK.md`;

export const UPSTREAM_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";
/** Upstream's long-running orchestrator rewrite, the branch the fork tracks. */
export const UPSTREAM_V2_PR_URL = "https://github.com/pingdotgg/t3code/pull/2829";
export const T3_SITE_URL = "https://t3.codes";

export const NPM_PACKAGE = "@jacksondr5/j5code";
export const NPX_COMMAND = `npx ${NPM_PACKAGE}@latest`;
export const NPM_PACKAGE_URL = `https://www.npmjs.com/package/${NPM_PACKAGE}`;

/** Status words used on every card. Copy must not claim more than the word allows. */
export type ShipStatus = "underway" | "charted" | "horizon";

export const STATUS_LABEL: Record<ShipStatus, string> = {
  underway: "Shipped",
  charted: "Charted",
  horizon: "Horizon",
};

export const STATUS_HELP: Record<ShipStatus, string> = {
  underway: "Ready to use",
  charted: "In dry dock, being built",
  horizon: "On our roadmap, coming soon",
};
