import type { VercelConfig } from "@vercel/config/v1";

// The Vercel project's root directory is apps/marketing and deploys come from
// the Git integration on j5/main. Install runs from the workspace root so vp
// resolves the pnpm workspace and its catalog.
export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
  // A thread prompt link, j5.codes/<environment>/<thread>?prompt=…, shows the /new page, and a
  // copied thread link, j5.codes/threads/<environment>/<thread>, the /threads page, which also
  // explains a malformed one. Both pages read the thread from the address. Vercel serves the
  // site's own pages before any rewrite.
  rewrites: [
    { source: "/threads/:path*", destination: "/threads/index.html" },
    {
      source: "/:environment/:thread",
      has: [{ type: "query", key: "prompt" }],
      destination: "/new/index.html",
    },
  ],
  // The linking page was /peering, and released apps still link there. Released apps also link to
  // /whats-new/0-1-3, whose T3 Code roundup is now a section of the 0.0.52 page.
  redirects: [
    { source: "/peering", destination: "/linking", permanent: true },
    { source: "/whats-new/0-1-3", destination: "/whats-new/0-0-52#t3-code", permanent: true },
  ],
  // `curl … | sh` needs the installer served as a plain shell script. Caches may
  // keep it for up to five minutes, so a changed installer reaches everyone
  // within five minutes of a deploy.
  headers: [
    {
      source: "/install.sh",
      headers: [
        { key: "Content-Type", value: "text/x-shellscript; charset=utf-8" },
        { key: "Cache-Control", value: "public, max-age=300" },
      ],
    },
  ],
};
