// Cloud backup of the whole app's local data, so nothing is lost when the
// browser cache is cleared, the phone changes, or the home-screen app is
// deleted and re-added. Stored as one JSON blob in Redis (REDIS_URL / Upstash).
//
//   POST { data: {<localStorage key>: <string>, ...}, ts } -> save snapshot
//   GET                                                    -> { data, ts }

import Redis from "ioredis";

const KEY = "backup";

let client;
function getClient() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  }
  return client;
}

export default async function handler(req, res) {
  if (!process.env.REDIS_URL) {
    return res.status(500).json({ error: "Server is missing REDIS_URL. Connect an Upstash Redis store to this project." });
  }
  if (!sameOrigin(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const redis = getClient();

    if (req.method === "GET") {
      const raw = await redis.get(KEY);
      if (!raw) return res.status(200).json({ data: null, ts: 0 });
      try {
        const obj = JSON.parse(raw);
        return res.status(200).json({ data: obj.data || null, ts: obj.ts || 0 });
      } catch {
        return res.status(200).json({ data: null, ts: 0 });
      }
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      if (!body.data || typeof body.data !== "object") {
        return res.status(400).json({ error: "No data" });
      }
      const ts = Number(body.ts) || Date.now();
      await redis.set(KEY, JSON.stringify({ data: body.data, ts }));
      return res.status(200).json({ ok: true, ts });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

// Allow same-origin (your own app) and header-less clients; block other sites.
function sameOrigin(req) {
  const host = req.headers.host;
  const ref = req.headers.origin || req.headers.referer || "";
  if (!ref) return true;
  try { return new URL(ref).host === host; } catch { return false; }
}
