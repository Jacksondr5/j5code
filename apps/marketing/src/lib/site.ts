export const GITHUB_REPOSITORY_URL = "https://github.com/Jacksondr5/j5code";
export const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
export const LICENSE_URL = `${GITHUB_REPOSITORY_URL}/blob/j5/main/LICENSE`;
export const PRODUCT_DOCS_URL = `${GITHUB_REPOSITORY_URL}/tree/j5/main/docs/j5/product`;
export const FORK_DISCIPLINE_URL = `${GITHUB_REPOSITORY_URL}/blob/j5/main/FORK.md`;

export const UPSTREAM_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";
/** Upstream's long-running orchestrator rewrite, the branch the fork tracks. */
export const UPSTREAM_V2_PR_URL = "https://github.com/pingdotgg/t3code/pull/2829";
export const T3_SITE_URL = "https://t3.codes";

export const SITE_URL = "https://j5.codes";
/**
 * The self-contained server for macOS (Apple silicon) and Linux x64; no Node
 * needed. The site serves the installer itself (staged from scripts/install.sh
 * at build time), which in turn fetches the release archive from GitHub.
 */
export const INSTALL_COMMAND = `curl -fsSL ${SITE_URL}/install.sh | sh`;
export const INSTALL_DOCS_URL = `${GITHUB_REPOSITORY_URL}/blob/j5/main/docs/user/install.md`;

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
