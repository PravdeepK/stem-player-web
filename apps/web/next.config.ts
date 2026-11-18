import type { NextConfig } from "next";

// The commit the site was built from, short form, for bug reports. Vercel's
// SHA names the exact commit when its git integration does the build.
// deploy.yml runs `vercel build` in GitHub Actions instead, where that can be
// empty, so GITHUB_SHA fills in.
const siteVersion = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "").slice(0, 7);

const config: NextConfig = {
  reactStrictMode: true,
  // next dev writes an AGENTS.md into the app when it thinks a coding agent is running it.
  agentRules: false,
  // core has no build step, so Next compiles its TypeScript source directly.
  transpilePackages: ["@stem-player-web/core"],
  env: { SITE_VERSION: siteVersion },
};

export default config;
