import { createPreviewIssue } from "../../server/feedback/preview";
import { createRelay, nodeHandler } from "../../server/feedback/relay";

// The relay reads the raw body itself, so the 16 KB cap and the JSON errors
// are its own rather than Next's.
export const config = { api: { bodyParser: false } };

// Only production gets the GitHub App's keys and real Turnstile keys.
// Previews and local runs file nothing, and Cloudflare's test keys they use
// can't say where the widget ran.
const production = process.env.VERCEL_ENV === "production";

// Vercel sets x-real-ip and x-forwarded-for itself. Anywhere else they could
// be forged to dodge the per-IP limit.
export default nodeHandler(createRelay(production ? {} : { createIssue: createPreviewIssue, checkTurnstileSource: false }), {
  trustProxy: process.env.VERCEL === "1",
});
