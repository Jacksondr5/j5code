import type { VercelConfig } from "@vercel/config/v1";

// The Vercel project's root directory is apps/marketing and deploys come from
// the Git integration on j5/main. Install runs from the workspace root so vp
// resolves the pnpm workspace and its catalog.
export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
};
