import type { CreateIssue } from "./github";

// Previews and local runs never hold the GitHub App's keys, so their reports
// end here instead of in the real repo. Issue #0 never exists, so nobody takes
// the answer for a real issue.
export const createPreviewIssue: CreateIssue = async ({ labels }) => ({
  number: 0,
  url: "https://github.com/PravdeepK/stem-player-web/issues/0",
  labels,
});
