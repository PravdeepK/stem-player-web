import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // next dev writes an AGENTS.md into the app when it thinks a coding agent is running it.
  agentRules: false,
  // core has no build step, so Next compiles its TypeScript source directly.
  transpilePackages: ["@stem-player-web/core"],
};

export default config;
