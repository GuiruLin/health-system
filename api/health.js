// Serverless store for Apple Health data pushed from the iOS Shortcut.
//
// Why this exists: the iPhone home-screen PWA and the Safari tab have SEPARATE
// localStorage. A Shortcut that opens a URL writes to Safari only, so the
// installed app never sees it. Instead the Shortcut POSTs here, the data is
// kept server-side (one Redis hash, field = date), and the app GETs it on load
// and merges it into its own local records — so both views stay in sync.
//
//   POST { date?, hrv?, rhr?, sleep?, deep?, rem? }  -> merge & store for that day
//   GET                                              -> { data: { "YYYY-MM-DD": {...} } }
//
// Storage uses the Redis connection string REDIS_URL, injected by Vercel when an
// Upstash Redis store is connected to the project.

import Redis from "ioredis";
import { requireAuth } from "../lib/auth.js";

const HKEY = "health"; // Redis hash: field = date, value = JSON of that day's metrics
const FIELDS = ["hrv", "rhr", "sleep", "deep", "rem"];
// Physiologically plausible ranges. A bad Apple Health sync has twice written
// garbage (RHR ~5.4e8, HRV 207ms) — reject anything out of range at the door so
// it never reaches storage, the trends, or the coach.
const BOUNDS = { hrv: [5, 150], rhr: [25, 150], sleep: [0, 20], deep: [0, 20], rem: [0, 20] };

// Reuse one client across warm invocations.
let client;
function getClient() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
  }
  return client;
}

const today = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  if (!process.env.REDIS_URL) {
    return res.status(500).json({
      error: "Server is missing REDIS_URL. Connect an Upstash Redis store to this project.",
    });
  }

  try {
    const redis = getClient();

    if (req.method === "GET") {
      // Reads are limited to same-origin (your own app); other sites are blocked.
      if (!sameOrigin(req)) return res.status(403).json({ error: "Forbidden" });
      // Writes use APP_SECRET (the iOS Shortcut); reads use the app's PIN.
      if (!(await requireAuth(req, res))) return;
      const obj = await redis.hgetall(HKEY); // { "2026-05-31": "{...}", ... }
      const data = {};
      for (const [date, json] of Object.entries(obj || {})) {
        try { data[date] = JSON.parse(json); } catch { /* skip bad entry */ }
      }
      return res.status(200).json({ data });
    }

    if (req.method === "POST") {
      // Writes require the shared secret (the iOS Shortcut sends ?key=...).
      // Only enforced once APP_SECRET is set in Vercel, so it can't break sync before setup.
      if (!secretOk(req)) return res.status(401).json({ error: "Unauthorized" });
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const date = (body.date && String(body.date).slice(0, 10)) || today();

      // Keep only valid numeric fields. Empty / non-numeric (e.g. an unfilled
      // Shortcut variable) are dropped, never fabricated.
      // Accept keys in any case (the Shortcut sends "HRV"/"RHR").
      const lower = {};
      for (const [k, v] of Object.entries(body)) lower[String(k).toLowerCase()] = v;
      const patch = {};
      const dropped = [];
      for (const k of FIELDS) {
        const raw = lower[k];
        if (raw == null || raw === "") continue;
        const n = parseFloat(raw);
        if (isNaN(n)) continue;
        const [lo, hi] = BOUNDS[k] || [-Infinity, Infinity];
        if (n < lo || n > hi) { dropped.push({ field: k, value: n }); continue; } // implausible reading — drop it
        patch[k] = n;
      }
      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: "No valid in-range numeric fields in body", received: body, dropped });
      }

      // Merge with whatever is already stored for that day.
      let existing = {};
      const curJson = await redis.hget(HKEY, date);
      if (curJson) { try { existing = JSON.parse(curJson); } catch { /* ignore */ } }
      const merged = { ...existing, ...patch };
      await redis.hset(HKEY, date, JSON.stringify(merged));

      return res.status(200).json({ ok: true, date, saved: merged, ...(dropped.length ? { dropped } : {}) });
    }

    if (req.method === "DELETE") {
      if (!secretOk(req)) return res.status(401).json({ error: "Unauthorized" });
      const date = req.query?.date;
      if (!date) return res.status(400).json({ error: "Missing ?date=YYYY-MM-DD" });
      await redis.hdel(HKEY, String(date).slice(0, 10));
      return res.status(200).json({ ok: true, deleted: date });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

// Writes need this secret. Not enforced until APP_SECRET is set in Vercel,
// so deploying this never breaks an existing Shortcut before you've set it up.
function secretOk(req) {
  const secret = process.env.APP_SECRET;
  if (!secret) return true;
  return (req.query && req.query.key) === secret;
}

// Allow same-origin (your own app) and header-less clients; block other sites.
function sameOrigin(req) {
  const host = req.headers.host;
  const ref = req.headers.origin || req.headers.referer || "";
  if (!ref) return true;
  try { return new URL(ref).host === host; } catch { return false; }
}
