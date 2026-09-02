// Shared authentication for the API routes.
//
// This is a single-user personal app, so "auth" is one PIN. The browser hashes
// the PIN (SHA-256) and sends the hash as a bearer token; only the hash is ever
// stored or transmitted, never the PIN itself.
//
// Four ways a request can be authorised:
//   1. no PIN configured yet  -> open, so the first run can set one
//   2. Authorization: Bearer <sha256(pin)>  -> the app, after the user unlocks
//   3. Authorization: Bearer <CRON_SECRET>  -> this project's scheduled jobs
//   4. Authorization: Bearer <AGENT_TOKEN>  -> a trusted external agent that
//      reads the plan on the owner's behalf (a personal assistant bot)
//
// Rule 1 is deliberate: it prevents a lockout before setup. Once a PIN exists
// the read routes stop serving data to anonymous callers, which is what makes
// the deployment URL safe to share.

import Redis from "ioredis";
import { timingSafeEqual } from "node:crypto";

export const PIN_KEY = "auth:pin";

let client;
export function redis() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  }
  return client;
}

// Compare without leaking length/prefix information through timing.
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function bearer(req) {
  const h = req.headers?.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export async function getStoredPin() {
  try { return await redis().get(PIN_KEY); } catch { return null; }
}

// True when the caller may read or write this user's data.
export async function isAuthorised(req) {
  const token = bearer(req);
  const cron = process.env.CRON_SECRET;
  if (cron && (safeEqual(token, cron) || safeEqual(req.query?.key || "", cron))) return true;
  const agent = process.env.AGENT_TOKEN;
  if (agent && token && safeEqual(token, agent)) return true;

  const stored = await getStoredPin();
  if (!stored) return true; // no PIN configured yet — first-run setup
  return !!token && safeEqual(token, stored);
}

// Guard helper: returns true if the handler should continue.
export async function requireAuth(req, res) {
  if (await isAuthorised(req)) return true;
  res.status(401).json({ error: "Unauthorized", locked: true });
  return false;
}
