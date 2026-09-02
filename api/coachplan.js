// Stores the weekly "coach plan" so the app's 载入教练计划 button can pull the
// latest plan without a code deploy. A scheduled Sunday review job POSTs next
// week's plan here; the button GETs it. Backed by the existing Upstash Redis.
//
//   GET                                 -> { plan, note, ts }
//   POST { plan: [{type,note}x7], note } -> save (needs matching COACH_KEY if set)

import Redis from "ioredis";
import { requireAuth } from "../lib/auth.js";

const KEY = "coachplan";

let client;
function getClient() {
  if (!client) client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  return client;
}

export default async function handler(req, res) {
  if (!process.env.REDIS_URL) {
    return res.status(500).json({ error: "Server is missing REDIS_URL." });
  }
  // The briefing is a detailed personal health analysis — keep it behind the PIN.
  if (!(await requireAuth(req, res))) return;
  try {
    const redis = getClient();

    if (req.method === "GET") {
      const raw = await redis.get(KEY);
      if (!raw) return res.status(200).json({ plan: null, note: "", ts: 0 });
      try {
        const obj = JSON.parse(raw);
        return res.status(200).json({ plan: obj.plan || null, note: obj.note || "", note_en: obj.note_en || "", ts: obj.ts || 0 });
      } catch {
        return res.status(200).json({ plan: null, note: "", ts: 0 });
      }
    }

    if (req.method === "POST") {
      // Optional shared secret: if COACH_KEY is set, require it (so only the
      // scheduled job can write). If unset, allow (personal app).
      const secret = process.env.COACH_KEY;
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      if (secret && body.key !== secret) return res.status(403).json({ error: "Forbidden" });
      if (!Array.isArray(body.plan) || body.plan.length !== 7) {
        return res.status(400).json({ error: "plan must be an array of 7 {type,note}" });
      }
      const clean = body.plan.map(d => ({ type: String(d.type || "rest"), note: String(d.note || ""), note_en: String(d.note_en || "") }));
      const ts = Number(body.ts) || Date.now();
      await redis.set(KEY, JSON.stringify({ plan: clean, note: String(body.note || ""), note_en: String(body.note_en || ""), ts }));
      return res.status(200).json({ ok: true, ts });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
