// PIN setup and unlock.
//
//   GET                              -> { pinSet }
//   POST { action:"setup",  pinHash } -> set the PIN (only while none exists)
//   POST { action:"verify", pinHash } -> { ok }
//   POST { action:"change", pinHash, newPinHash } -> rotate the PIN
//
// The browser sends sha256(PIN); the raw PIN never leaves the device.

import { redis, PIN_KEY, getStoredPin } from "../lib/auth.js";
import { timingSafeEqual } from "node:crypto";

const ATTEMPT_KEY = "auth:fails";
const MAX_FAILS = 20; // per hour, then unlock attempts are refused

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

const isHash = v => typeof v === "string" && /^[a-f0-9]{64}$/i.test(v);

export default async function handler(req, res) {
  if (!process.env.REDIS_URL) {
    return res.status(500).json({ error: "Server is missing REDIS_URL." });
  }
  try {
    if (req.method === "GET") {
      return res.status(200).json({ pinSet: !!(await getStoredPin()) });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const action = body.action;
      const stored = await getStoredPin();

      if (action === "setup") {
        if (stored) return res.status(409).json({ error: "A PIN is already set" });
        if (!isHash(body.pinHash)) return res.status(400).json({ error: "pinHash must be a sha256 hex digest" });
        await redis().set(PIN_KEY, body.pinHash);
        return res.status(200).json({ ok: true });
      }

      if (action === "verify" || action === "change") {
        if (!stored) return res.status(400).json({ error: "No PIN set" });

        // Throttle brute force against a short numeric PIN.
        const bucket = `${ATTEMPT_KEY}:${Math.floor(Date.now() / 3600000)}`;
        const fails = Number(await redis().get(bucket)) || 0;
        if (fails >= MAX_FAILS) {
          return res.status(429).json({ error: "Too many attempts — try again later" });
        }

        const ok = isHash(body.pinHash) && safeEqual(body.pinHash, stored);
        if (!ok) {
          const n = await redis().incr(bucket);
          if (n === 1) await redis().expire(bucket, 3700);
          return res.status(401).json({ ok: false });
        }

        if (action === "change") {
          if (!isHash(body.newPinHash)) return res.status(400).json({ error: "newPinHash must be a sha256 hex digest" });
          await redis().set(PIN_KEY, body.newPinHash);
        }
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
