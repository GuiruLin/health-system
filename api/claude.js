// Serverless proxy for the Anthropic API.
// The API key lives ONLY in the server environment variable ANTHROPIC_API_KEY.
// It is never exposed to the browser/client.
//
// Hardening (a public client app can't hold a real secret, so we do what we can):
//  - same-origin check: blocks other websites from calling this endpoint
//  - model whitelist + max_tokens cap: limits the cost of any single call
//  - rate limit (Redis): caps how many AI calls the URL can make per hour, so a
//    shared/public link can't be spammed to burn the Anthropic budget
//  - your prepaid balance + Auto-reload OFF in the Anthropic console caps total damage

import Redis from "ioredis";

let client;
function getClient() {
  if (!client) client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  return client;
}

const RL_MAX = 40; // max AI calls per hour (generous for normal use, blocks abuse)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!sameOrigin(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in your Vercel project settings." });
  }
  // Rate limit AI calls (hourly bucket) so a public link can't burn the budget.
  if (process.env.REDIS_URL) {
    try {
      const redis = getClient();
      const bucket = "rl:claude:" + Math.floor(Date.now() / 3600000);
      const n = await redis.incr(bucket);
      if (n === 1) await redis.expire(bucket, 3700);
      if (n > RL_MAX) return res.status(429).json({ error: "Too many requests — try again later." });
    } catch { /* if Redis is unavailable, don't block the app */ }
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const model = String(body.model || "");
    if (!model.startsWith("claude-")) {
      return res.status(400).json({ error: "Invalid model" });
    }
    const safeBody = { ...body, model, max_tokens: Math.min(Number(body.max_tokens) || 1000, 2048) };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(safeBody)
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

// Allow same-origin requests (your own app) and header-less clients; block other sites.
function sameOrigin(req) {
  const host = req.headers.host;
  const ref = req.headers.origin || req.headers.referer || "";
  if (!ref) return true;
  try { return new URL(ref).host === host; } catch { return false; }
}
