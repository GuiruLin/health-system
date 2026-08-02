// Serverless proxy for the Strava API.
// CLIENT_SECRET lives ONLY in the server env var STRAVA_CLIENT_SECRET — never sent to the browser.
//
// Two actions (sent as JSON in the POST body):
//   { action: "exchange", code }            -> first-time authorization, returns tokens + athlete
//   { action: "sync", refresh_token, after } -> refreshes token, returns recent activities

import Redis from "ioredis";

const TOKEN_URL = "https://www.strava.com/oauth/token";
const ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";

// The Strava refresh token is stripped from the public backup read for security,
// so a shared client no longer holds it. When a request doesn't carry the token,
// fall back to reading it server-side from the Redis backup blob (it never leaves
// the server this way).
let _redis;
function redisClient() {
  if (!_redis && process.env.REDIS_URL) _redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  return _redis;
}
async function tokenFromRedis() {
  try {
    const c = redisClient();
    if (!c) return null;
    const raw = await c.get("backup");
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.data?.["hs:strava:refresh"] || null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: "Server is missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET. Set them in Vercel project settings." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const action = body?.action;

    if (action === "exchange") {
      if (!body.code) return res.status(400).json({ error: "Missing code" });
      const tok = await postToken({
        client_id: clientId,
        client_secret: clientSecret,
        code: body.code,
        grant_type: "authorization_code",
      });
      if (tok.errors || !tok.refresh_token) {
        return res.status(400).json({ error: "Strava authorization failed", detail: tok.message || tok });
      }
      return res.status(200).json({
        refresh_token: tok.refresh_token,
        athlete: tok.athlete ? { id: tok.athlete.id, firstname: tok.athlete.firstname, lastname: tok.athlete.lastname } : null,
      });
    }

    if (action === "sync") {
      const refresh = body.refresh_token || await tokenFromRedis();
      if (!refresh) return res.status(400).json({ error: "Missing refresh_token" });
      const tok = await postToken({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refresh,
        grant_type: "refresh_token",
      });
      if (tok.errors || !tok.access_token) {
        return res.status(401).json({ error: "Token refresh failed — reconnect Strava", detail: tok.message || tok });
      }
      const after = Number(body.after) || Math.floor(Date.now() / 1000) - 60 * 86400;
      const url = `${ACTIVITIES_URL}?after=${after}&per_page=100`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const activities = await r.json();
      if (!Array.isArray(activities)) {
        return res.status(r.status).json({ error: "Failed to fetch activities", detail: activities });
      }
      const isStrength = t => /Weight|Workout|Crossfit|HIIT/i.test(t || "");
      const slim = await Promise.all(activities.map(async a => {
        const o = {
          id: a.id,
          name: a.name,
          type: a.sport_type || a.type,
          start_date_local: a.start_date_local || a.start_date,
          moving_time: a.moving_time,
          distance: a.distance,
          average_heartrate: a.average_heartrate,
          max_heartrate: a.max_heartrate,
          suffer_score: a.suffer_score,
          perceived_exertion: a.perceived_exertion ?? null,
        };
        // perceived_exertion (RPE) is only on the detailed activity — fetch it
        // for strength sessions so lifting load reflects your real effort.
        if (o.perceived_exertion == null && isStrength(o.type)) {
          try {
            const dr = await fetch(`${ACTIVITIES_URL.replace("/athlete/activities", "/activities")}/${a.id}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
            const det = await dr.json();
            if (det && det.perceived_exertion != null) o.perceived_exertion = det.perceived_exertion;
          } catch { /* ignore, fall back to default */ }
        }
        return o;
      }));
      return res.status(200).json({ refresh_token: tok.refresh_token, activities: slim });
    }

    if (action === "zones") {
      if (!body.refresh_token || !body.id) return res.status(400).json({ error: "Missing refresh_token or id" });
      const tok = await postToken({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: body.refresh_token,
        grant_type: "refresh_token",
      });
      if (tok.errors || !tok.access_token) {
        return res.status(401).json({ error: "Token refresh failed", detail: tok.message || tok });
      }
      const r = await fetch(`https://www.strava.com/api/v3/activities/${body.id}/zones`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const zones = await r.json();
      return res.status(r.status).json({ refresh_token: tok.refresh_token, zones });
    }

    if (action === "activity") {
      if (!body.refresh_token || !body.id) return res.status(400).json({ error: "Missing refresh_token or id" });
      const tok = await postToken({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: body.refresh_token,
        grant_type: "refresh_token",
      });
      if (tok.errors || !tok.access_token) {
        return res.status(401).json({ error: "Token refresh failed", detail: tok.message || tok });
      }
      const r = await fetch(`https://www.strava.com/api/v3/activities/${body.id}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const detail = await r.json();
      return res.status(r.status).json({ refresh_token: tok.refresh_token, detail });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

async function postToken(params) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return r.json();
}
