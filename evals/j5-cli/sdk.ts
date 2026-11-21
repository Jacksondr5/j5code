/**
 * The Claude Agent SDK the server already depends on, loaded from the server's install so this
 * folder adds no dependency of its own. It drives the pinned `claude` binary in the image.
 */
import type * as Sdk from "../../apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";

export type * from "../../apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";

const sdkModule = new URL(
  "../../apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  import.meta.url,
).href;
const sdk = (await import(sdkModule)) as typeof Sdk;
export const query = sdk.query;

export const CLAUDE_BINARY = "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
