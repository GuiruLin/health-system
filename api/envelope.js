// 信封(envelope-budget)财务面板的数据 API。
// 为什么放在 health-system:本项目已连 Upstash Redis(REDIS_URL);
// envelope-budget 是纯静态前端,跨域调这里。数据存 key "envelope:state"。
// 鉴权:Authorization: Bearer <sha256(PIN)> 或 <ENVELOPE_TOKEN>(Hermes/Claude 用)。

import Redis from "ioredis";

const KEY = "envelope:state";
let client;
function getClient() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  }
  return client;
}

const CATS = ["transport", "grocery", "workmeal", "social", "misc", "shopping", "fixed", "visa", "buffer"];
const TX_CATS = ["transport", "grocery", "workmeal", "social", "misc", "shopping", "fixed", "visa"];
const SRCS = ["studio", "student", "other"];

function seedState() {
  return {
    pinHash: null,
    reserve: 1500.65,
    reserveNote: "Revolut 主户+储蓄袋,2026-07-19 对账",
    months: {
      "2026-07": {
        practice: true,
        budgets: { transport: 100, grocery: 130, workmeal: 80, social: 50, misc: 60, shopping: 0, buffer: 80 },
        savingsTarget: 200,
        savingsMet: false,
        tx: [
          { id: "s1", date: "2026-07-19", cat: "transport", amount: 65.65, note: "TfL 14笔累计(账单核)" },
          { id: "s2", date: "2026-07-16", cat: "transport", amount: 14.95, note: "Uber打车(拖延,已标偏离)" },
          { id: "s3", date: "2026-07-03", cat: "transport", amount: 3.3, note: "Trainpal火车票" },
          { id: "s4", date: "2026-07-10", cat: "transport", amount: 3.3, note: "Trainpal火车票" },
          { id: "s5", date: "2026-07-06", cat: "grocery", amount: 22.05, note: "UberEats Morrisons" },
          { id: "s6", date: "2026-07-13", cat: "grocery", amount: 30.57, note: "UberEats Morrisons" },
          { id: "s7", date: "2026-07-20", cat: "grocery", amount: 44.58, note: "UberEats Morrisons" },
          { id: "s8", date: "2026-07-18", cat: "workmeal", amount: 49.12, note: "快餐11次累计(账单核)" },
          { id: "s9", date: "2026-07-18", cat: "workmeal", amount: 41.18, note: "超市meal deal/饮料16笔累计" },
          { id: "s10", date: "2026-07-08", cat: "workmeal", amount: 6.5, note: "Ohaio New Malden" },
          { id: "s11", date: "2026-07-15", cat: "workmeal", amount: 6.5, note: "Ohaio New Malden" },
          { id: "s12", date: "2026-07-07", cat: "workmeal", amount: 5.5, note: "David Lloyd 店内" },
          { id: "s13", date: "2026-07-06", cat: "social", amount: 15.15, note: "Yogi's" },
          { id: "s14", date: "2026-07-12", cat: "social", amount: 17.19, note: "Sheraton" },
          { id: "s15", date: "2026-07-18", cat: "social", amount: 40.75, note: "Kutir Chelsea" },
          { id: "s16", date: "2026-07-18", cat: "social", amount: 16.41, note: "Thistle 餐(自付)" },
          { id: "s17", date: "2026-07-06", cat: "misc", amount: 19.99, note: "Amazon" },
          { id: "s18", date: "2026-07-16", cat: "misc", amount: 14.98, note: "TK Maxx 文具(合规)" },
          { id: "s19", date: "2026-07-08", cat: "misc", amount: 7.18, note: "Boots ×2" },
          { id: "s20", date: "2026-07-14", cat: "misc", amount: 3.42, note: "Boots" },
          { id: "s21", date: "2026-07-16", cat: "misc", amount: 2.92, note: "Boots" },
          { id: "s22", date: "2026-07-17", cat: "misc", amount: 3.58, note: "Boots" },
          { id: "s23", date: "2026-07-18", cat: "misc", amount: 2.7, note: "Boots" },
          { id: "s24", date: "2026-07-09", cat: "misc", amount: 11.17, note: "Superdrug" },
          { id: "s25", date: "2026-07-17", cat: "misc", amount: 5.0, note: "Wigmore Hall" },
          { id: "s26", date: "2026-07-10", cat: "misc", amount: 1.99, note: "Premier 便利店" },
          { id: "s27", date: "2026-07-03", cat: "misc", amount: 1.0, note: "Clubhouse Wimbledon" },
          { id: "s28", date: "2026-07-08", cat: "shopping", amount: 20.0, note: "Sweaty Betty(退款在途,到账删此笔)" },
        ],
      },
    },
  };
}

async function loadState(redis) {
  const raw = await redis.get(KEY);
  if (!raw) {
    const s = seedState();
    await redis.set(KEY, JSON.stringify(s));
    return s;
  }
  return JSON.parse(raw);
}

function authOk(req, state) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) return false;
  if (process.env.ENVELOPE_TOKEN && token === process.env.ENVELOPE_TOKEN) return true;
  return !!state.pinHash && token === state.pinHash;
}

function monthKey(d) {
  return (d || new Date().toISOString().slice(0, 10)).slice(0, 7);
}

function ensureMonth(state, mk) {
  if (!state.months[mk]) {
    const keys = Object.keys(state.months).sort();
    const prev = keys.length ? state.months[keys[keys.length - 1]] : null;
    state.months[mk] = {
      practice: false,
      budgets: prev ? { ...prev.budgets } : seedState().months["2026-07"].budgets,
      savingsTarget: prev ? prev.savingsTarget : 200,
      savingsMet: false,
      tx: [],
    };
  }
  return state.months[mk];
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (/^https:\/\/envelope-budget[a-z0-9-]*\.vercel\.app$/.test(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!process.env.REDIS_URL) return res.status(500).json({ error: "missing REDIS_URL" });

  try {
    const redis = getClient();
    const state = await loadState(redis);

    if (req.method === "GET") {
      if (!state.pinHash) return res.status(200).json({ needsSetup: true });
      if (!authOk(req, state)) return res.status(401).json({ locked: true });
      return res.status(200).json({ state });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const { action } = body;

      if (action === "setup") {
        if (state.pinHash) return res.status(403).json({ error: "already set" });
        if (!/^[a-f0-9]{64}$/.test(body.pinHash || "")) return res.status(400).json({ error: "bad pinHash" });
        state.pinHash = body.pinHash;
        await redis.set(KEY, JSON.stringify(state));
        return res.status(200).json({ ok: true });
      }

      if (!authOk(req, state)) return res.status(401).json({ locked: true });

      if (action === "resetpin") {
        // 仅限 agent token(Lynn 忘 PIN 时由 Claude/Hermes 代为重置,数据不动)
        const h = req.headers["authorization"] || "";
        const tk = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
        if (!process.env.ENVELOPE_TOKEN || tk !== process.env.ENVELOPE_TOKEN) {
          return res.status(403).json({ error: "agent only" });
        }
        state.pinHash = null;
        await redis.set(KEY, JSON.stringify(state));
        return res.status(200).json({ ok: true });
      }

      if (action === "tx") {
        const amount = Math.round(parseFloat(body.amount) * 100) / 100;
        if (!CATS.includes(body.cat) || !(amount > 0)) return res.status(400).json({ error: "bad tx" });
        const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : new Date().toISOString().slice(0, 10);
        const mk = monthKey(date);
        const m = ensureMonth(state, mk);
        const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        m.tx.push({ id, date, cat: body.cat, amount, note: String(body.note || "").slice(0, 80) });
        await redis.set(KEY, JSON.stringify(state));
        return res.status(200).json({ ok: true, id, month: mk });
      }

      if (action === "deltx") {
        const m = state.months[body.month];
        if (!m) return res.status(404).json({ error: "no month" });
        const before = m.tx.length;
        m.tx = m.tx.filter((t) => t.id !== body.id);
        if (m.tx.length === before) return res.status(404).json({ error: "no tx" });
        await redis.set(KEY, JSON.stringify(state));
        return res.status(200).json({ ok: true });
      }

      if (action === "income") {
        const amount = Math.round(parseFloat(body.amount) * 100) / 100;
        if (!SRCS.includes(body.src) || !(amount > 0)) return res.status(400).json({ error: "bad income" });
        const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : new Date().toISOString().slice(0, 10);
        const mk = monthKey(date);
        const m = ensureMonth(state, mk);
        if (!Array.isArray(m.income)) m.income = [];
        const id = "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        m.income.push({ id, date, src: body.src, amount, note: String(body.note || "").slice(0, 80) });
        await redis.set(KEY, JSON.stringify(state));
        return res.status(200).json({ ok: true, id, month: mk });
      }

      if (action === "delincome") {
        const m = state.months[body.month];
        if (!m || !Array.isArray(m.income)) return res.status(404).json({ error: "no month" });
        const before = m.income.length;
        m.income = m.income.filter((t) => t.id !== body.id);
        if (m.income.length === before) return res.status(404).json({ error: "no income" });
        await redis.set(KEY, JSON.stringify(state));
        return res.status(200).json({ ok: true });
      }

      if (action === "import") {
        // 帐单导入:按 fp(指纹)防重复。跳过 importedFps 已有的条目,新 fp 记录下来。
        const txs = Array.isArray(body.txs) ? body.txs : [];
        const incomes = Array.isArray(body.incomes) ? body.incomes : [];
        if (!Array.isArray(state.importedFps)) state.importedFps = [];
        const seen = new Set(state.importedFps);
        let added = 0, skipped = 0;
        const validDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : new Date().toISOString().slice(0, 10));
        for (const x of txs) {
          const amount = Math.round(parseFloat(x.amount) * 100) / 100;
          const fp = String(x.fp || "").slice(0, 24);
          if (!TX_CATS.includes(x.cat) || !(amount > 0) || !fp) continue;
          if (seen.has(fp)) { skipped++; continue; }
          const date = validDate(x.date);
          const m = ensureMonth(state, monthKey(date));
          const id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          m.tx.push({ id, date, cat: x.cat, amount, note: String(x.note || "").slice(0, 80) });
          seen.add(fp); state.importedFps.push(fp); added++;
        }
        for (const x of incomes) {
          const amount = Math.round(parseFloat(x.amount) * 100) / 100;
          const fp = String(x.fp || "").slice(0, 24);
          if (!SRCS.includes(x.src) || !(amount > 0) || !fp) continue;
          if (seen.has(fp)) { skipped++; continue; }
          const date = validDate(x.date);
          const m = ensureMonth(state, monthKey(date));
          if (!Array.isArray(m.income)) m.income = [];
          const id = "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          m.income.push({ id, date, src: x.src, amount, note: String(x.note || "").slice(0, 80) });
          seen.add(fp); state.importedFps.push(fp); added++;
        }
        if (state.importedFps.length > 3000) state.importedFps = state.importedFps.slice(-3000);
        await redis.set(KEY, JSON.stringify(state));
        return res.status(200).json({ ok: true, added, skipped });
      }

      if (action === "set") {
        const patch = body.patch || {};
        for (const k of ["reserve", "reserveNote"]) {
          if (k in patch) state[k] = patch[k];
        }
        await redis.set(KEY, JSON.stringify(state));
        return res.status(200).json({ ok: true });
      }

      if (action === "month") {
        const m = ensureMonth(state, body.month || monthKey());
        const patch = body.patch || {};
        if (patch.budgets && typeof patch.budgets === "object") {
          for (const c of CATS) {
            if (c in patch.budgets) m.budgets[c] = Math.max(0, parseFloat(patch.budgets[c]) || 0);
          }
        }
        for (const k of ["savingsTarget", "savingsMet", "practice"]) {
          if (k in patch) m[k] = patch[k];
        }
        if (patch.summary && typeof patch.summary === "object") {
          // 历史月汇总口径(无明细):{total, note}
          const total = Math.round(parseFloat(patch.summary.total) * 100) / 100;
          if (total >= 0) m.summary = { total, note: String(patch.summary.note || "").slice(0, 120) };
        }
        if ("reserveEnd" in patch) {
          const v = Math.round(parseFloat(patch.reserveEnd) * 100) / 100;
          if (v >= 0) m.reserveEnd = v;
        }
        await redis.set(KEY, JSON.stringify(state));
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "unknown action" });
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
