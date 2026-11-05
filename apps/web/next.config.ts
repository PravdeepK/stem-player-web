import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // core has no build step, so Next compiles its TypeScript source directly.
  transpilePackages: ["@stem-player-web/core"],
};

export default config;
