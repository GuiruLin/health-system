// Cloud backup of the whole app's local data, so nothing is lost when the
// browser cache is cleared, the phone changes, or the home-screen app is
// deleted and re-added. Stored as one JSON blob in Redis (REDIS_URL / Upstash).
//
//   POST { data: {<localStorage key>: <string>, ...}, ts } -> save snapshot
//   GET                                                    -> { data, ts }

import Redis from "ioredis";
import { requireAuth } from "../lib/auth.js";

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
  // This snapshot is the entire health record — never serve it unauthenticated.
  if (!(await requireAuth(req, res))) return;
  try {
    const redis = getClient();

    if (req.method === "GET") {
      const raw = await redis.get(KEY);
      if (!raw) return res.status(200).json({ data: null, ts: 0 });
      try {
        const obj = JSON.parse(raw);
        let data = obj.data || null;
        // Never expose the Strava refresh token over the public read — strip it
        // so a shared URL can't hand anyone a key into her Strava account.
        // (The server-side weekly job reads the raw Redis blob directly, so it
        //  still has the token; only a fresh reinstall would need to reconnect Strava.)
        if (data && ("hs:strava:refresh" in data)) {
          const { ["hs:strava:refresh"]: _omit, ...safe } = data;
          data = safe;
        }
        return res.status(200).json({ data, ts: obj.ts || 0 });
      } catch {
        return res.status(200).json({ data: null, ts: 0 });
      }
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      if (!body.data || typeof body.data !== "object") {
        return res.status(400).json({ error: "No data" });
      }
      const data = { ...body.data };
      // The GET response strips the Strava token, so a browser that restored
      // from backup holds everything EXCEPT the token. If such a client pushes
      // a backup, don't let it erase the stored token — carry it forward.
      if (!("hs:strava:refresh" in data)) {
        try {
          const curRaw = await redis.get(KEY);
          const curTok = curRaw ? JSON.parse(curRaw)?.data?.["hs:strava:refresh"] : null;
          if (curTok != null) data["hs:strava:refresh"] = curTok;
        } catch { /* best effort */ }
      }
      const ts = Number(body.ts) || Date.now();
      await redis.set(KEY, JSON.stringify({ data, ts }));
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
