# Health System

A local-first personal health PWA with an AI coaching layer — sleep, nutrition,
training and body composition in one place, plus a weekly coach that reads every
signal and writes next week's training plan.

Built around three evidence-based frameworks: Peter Attia (healthspan — Zone 2,
VO2max, strength, stability), Stacy Sims (female physiology — cycle-aware
training and fuelling), and Andrew Huberman (sleep and circadian rhythm).

## Features

- **Five domains, one tab each** — Today, Sleep, Food, Training, Body. Each holds
  both its logging form and its trends.
- **Daily AI coach** — reads the day's readiness, sleep, fuelling and cycle phase,
  then gives one specific recommendation. Follow-up chat included.
- **Weekly auto-coach** — a Sunday cron job pulls the whole week (sleep, HRV/RHR,
  subjective state, meals, body composition, cycle, Strava sessions including
  free-text strength logs), calls Claude, and publishes next week's 7-day plan
  plus a training-first briefing. Loadable in the app with one tap, and you can
  argue with it: ask a question and the coach rewrites the plan table in place.
- **Exercise library** — six routines (four technique/hypertrophy days and two
  max-strength days), each with per-exercise video links and a one-tap copy that
  formats the session for pasting into a Strava description.
- **Strava sync** — OAuth. Runs, pilates and strength sessions flow in
  automatically, with heart-rate zone distribution computed against the athlete's
  real configured zones rather than a percentage-of-max formula.
- **Apple Health sync** — an iOS Shortcut POSTs HRV and resting heart rate each
  morning. Physiologically impossible readings are rejected at the door, so one
  bad sync can't distort a trend or mislead the coach.
- **Meal photo estimation** — photograph a meal, get calories, protein and fibre.
  Images are normalised to JPEG in the browser first, so iPhone HEIC files work.
- **Bilingual** — the whole interface renders in Chinese or English, including
  AI-generated plans and weekly briefings, which are produced in both languages
  in a single pass rather than machine-translated afterwards.

## Architecture

Local-first. Everything is written to `localStorage` first, so the app works
offline and stays fast. A debounced background job mirrors the full dataset to
Redis as a single snapshot, which is restored automatically only when local
storage is completely empty — a fresh install or a cleared browser.

Serverless functions handle everything that needs a secret:

| Route | Purpose |
|---|---|
| `api/auth.js` | PIN setup, unlock, rotation |
| `api/claude.js` | Anthropic proxy — model allowlist, token cap, hourly rate limit |
| `api/weekly.js` | Sunday cron: reads all data, generates next week's plan |
| `api/coachplan.js` | Stores and serves the published weekly plan |
| `api/strava.js` | Strava OAuth exchange, activity sync, HR zone lookup |
| `api/health.js` | Receives Apple Health pushes, validates physiological ranges |
| `api/backup.js` | Cloud snapshot of the local dataset |

API keys live only in server environment variables and never reach the browser.

## Authentication

The app is single-user, so authentication is one PIN. The browser hashes it with
SHA-256 and sends the digest as a bearer token; the PIN itself never leaves the
device and is never stored. Every data route checks it (`lib/auth.js`), so the
deployment URL can be shared without exposing the data behind it.

Three ways a request is authorised:

1. no PIN configured yet — open, so the first run can set one without a lockout
2. `Authorization: Bearer <sha256(pin)>` — the app, after the user unlocks
3. `Authorization: Bearer <CRON_SECRET>` — scheduled server-side jobs

Unlock attempts are throttled (20 failures per hour) and hash comparison is
constant-time.

## Stack

Vite · React 18 · Recharts · vite-plugin-pwa · Vercel serverless functions ·
Upstash Redis · Anthropic API · Strava API

## Running it yourself

```bash
npm install
npm run dev          # UI only; serverless functions do not run
vercel dev           # full stack, with local env vars
```

Deploy to Vercel, connect an Upstash Redis store, then set:

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | AI coach and meal estimation |
| `REDIS_URL` | yes | cloud backup, weekly plan, auth, rate limiting |
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` | optional | Strava sync |
| `CRON_SECRET` | optional | authorises the weekly cron job |
| `APP_SECRET` | optional | protects Apple Health writes |

Set them with `vercel env add`, never in a file.

Note: `vercel.json` sets `maxDuration: 60` on the weekly function — it takes
around 30 seconds and fails on the default limit.

## Personalisation

Several defaults are tuned to one athlete and should be changed for your own
body: the heart-rate zone edges and race date in `src/App.jsx` and
`api/weekly.js`, and the loads in the exercise library. Body weight, protein
target, HRV/RHR baselines, cycle length and race date are all editable in the
app itself.

## Development notes

- `npm run build` only checks the frontend. Run `node --check api/*.js` before
  deploying — a syntax error in a serverless function only surfaces at runtime.
- Server-side writes to the backup snapshot are overwritten by the client on its
  next save, so data changes must be made in the app, not the backend.

## License

MIT — see [LICENSE](LICENSE).
