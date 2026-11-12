import { createRelay, nodeHandler } from "../../server/feedback/relay";

// The relay reads the raw body itself, so the 16 KB cap and the JSON errors
// are its own rather than Next's.
export const config = { api: { bodyParser: false } };

// Vercel sets x-real-ip and x-forwarded-for itself. Anywhere else they could
// be forged to dodge the per-IP limit.
export default nodeHandler(createRelay(), { trustProxy: process.env.VERCEL === "1" });
