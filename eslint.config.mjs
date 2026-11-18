import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/node_modules/", "**/.next/", "**/out/", "**/next-env.d.ts", "**/playwright-report/", "**/test-results/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: "apps/web" } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // server/ runs with the GitHub App key, the Turnstile secret and the Redis
    // token. Only the API routes may import it, so none of that code can end up
    // in a page bundle.
    files: ["apps/web/**/*.{ts,tsx}"],
    ignores: ["apps/web/pages/api/**", "apps/web/server/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.{1,2}/(.+/)?server(/|$)",
              message: "Only pages/api may import from server/.",
            },
          ],
        },
      ],
    },
  },
  {
    // core has to run in Node under Vitest, where there is no page. It keeps the
    // DOM's types for AudioContext and Blob, but can't reach for its globals.
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        "window",
        "self",
        "document",
        "navigator",
        "location",
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "AudioContext",
        "OfflineAudioContext",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
);
