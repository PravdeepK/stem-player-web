import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // next dev would otherwise write an AGENTS.md into the app on every start.
  agentRules: false,
  // core has no build step, so Next compiles its TypeScript source directly.
  transpilePackages: ["@stem-player-web/core"],
};

export default config;
