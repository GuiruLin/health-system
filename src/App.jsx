import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Moon, NotebookPen, LineChart as LineIcon, HeartPulse, Dumbbell, Apple, Activity,
  Camera, Upload, Sparkles, Plus, Trash2, Check, AlertTriangle, RotateCcw, Pencil
} from "lucide-react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell, Legend
} from "recharts";

/* ------------------------------------------------------------------ */
/*  storage (window.storage in claude.ai; in-memory fallback elsewhere) */
/* ------------------------------------------------------------------ */
// Local-first storage in localStorage, automatically mirrored to the cloud
// (/api/backup) so data survives a cleared cache, a new phone, or deleting+
// re-adding the home-screen app. Every change schedules a debounced backup push.
const PFX = "hs:";
const store = {
  async get(k) { try { const v = localStorage.getItem(PFX + k); return v ? JSON.parse(v) : null; } catch { return null; } },
  async set(k, v) { try { localStorage.setItem(PFX + k, JSON.stringify(v)); scheduleBackup(); return { key: k }; } catch (e) { console.error(e); return null; } },
  async del(k) { try { localStorage.removeItem(PFX + k); scheduleBackup(); return { key: k }; } catch { return null; } },
  async list(prefix) {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PFX + prefix)) out.push(key.slice(PFX.length));
    }
    return out;
  },
};

/* ---- automatic cloud backup ---- */
const DATA_PREFIXES = ["profile", "daily:", "training:", "meal:", "metric:", "period:", "supp:", "strava:"];
function snapshotLocal() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PFX)) data[k] = localStorage.getItem(k);
  }
  return data;
}
function localHasData() {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PFX)) continue;
    const rest = k.slice(PFX.length);
    if (DATA_PREFIXES.some(p => rest === p || rest.startsWith(p))) return true;
  }
  return false;
}
let _backupTimer = null;
async function pushBackup() {
  try {
    await fetch("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: snapshotLocal(), ts: Date.now() }),
    });
  } catch { /* offline — will retry on next change */ }
}
function scheduleBackup() {
  if (_backupTimer) clearTimeout(_backupTimer);
  _backupTimer = setTimeout(pushBackup, 1500);
}
// On a fresh/empty app, pull the latest cloud backup back into localStorage.
async function restoreIfEmpty() {
  if (localHasData()) return false;
  try {
    const r = await fetch("/api/backup");
    const j = await r.json();
    if (j && j.data && Object.keys(j.data).length) {
      for (const [k, v] of Object.entries(j.data)) {
        if (typeof k === "string" && k.startsWith(PFX) && typeof v === "string") localStorage.setItem(k, v);
      }
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/* ------------------------------------------------------------------ */
/*  date + cycle helpers                                               */
/* ------------------------------------------------------------------ */
const pad = n => String(n).padStart(2, "0");
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const fmtShort = k => { const [, m, dd] = k.split("-"); return `${m}/${dd}`; };

const CYCLE_PHASES = {
  zh: [
    { phase: "经期", note: "能量偏低，温和训练，补铁补水" },
    { phase: "卵泡期", note: "可上强度 / 大重量，身体修复力强" },
    { phase: "排卵期", note: "力量峰值，注意关节稳定" },
    { phase: "黄体期", note: "偏恢复，多碳水，HRV 自然下降属正常" },
  ],
  en: [
    { phase: "Menstrual", note: "Lower energy; gentle training; iron + hydration" },
    { phase: "Follicular", note: "Can push intensity / heavy lifts; strong recovery" },
    { phase: "Ovulation", note: "Strength peak; mind joint stability" },
    { phase: "Luteal", note: "Lean to recovery; more carbs; HRV dipping is normal" },
  ],
};
function cyclePhase(startDate, length, lang = "zh") {
  if (!startDate) return null;
  const len = length || 28;
  let day = (daysBetween(startDate, todayKey()) % len) + 1;
  if (day <= 0) day += len;
  const idx = day <= 5 ? 0 : day <= 13 ? 1 : day <= 16 ? 2 : 3;
  const { phase, note } = (CYCLE_PHASES[lang] || CYCLE_PHASES.zh)[idx];
  return { day, len, phase, note };
}

/* ------------------------------------------------------------------ */
/*  Anthropic API (works when rendered in claude.ai)                   */
/* ------------------------------------------------------------------ */
// Change this to "claude-opus-4-8" for best quality, or another model id if this one errors.
const MODEL = "claude-sonnet-4-6";
async function callClaude(messages, system, maxTokens = 1000) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
  });
  const data = await res.json();
  return (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
}
// Normalise any picked image (incl. iPhone HEIC/HEIF) to a JPEG data URL, and
// downscale it. Anthropic vision only accepts jpeg/png/gif/webp, so sending a
// raw HEIC file (the iOS camera default) fails with "Could not process image".
function fileToJpegDataUrl(file, maxDim = 1200, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      try { resolve(canvas.toDataURL("image/jpeg", quality)); } catch (err) { reject(err); }
    };
    img.onerror = err => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}
function parseJSON(text) {
  const clean = (text || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch { return null; }
}

const SLEEP_TARGET = 7.5;

/* ------------------------------------------------------------------ */
/*  training load model (Fitness / Fatigue / Form, i.e. CTL/ATL/TSB)  */
/*  Hybrid per-session load:                                          */
/*   - cardio synced from Strava -> its Relative Effort (HR-based),   */
/*     so runs are as precise as Strava.                              */
/*   - strength / manual -> RPE x minutes x 0.15 (scaled to match     */
/*     Relative Effort units), so lifting is included too — which     */
/*     Strava's HR-based model under-counts.                          */
/* ------------------------------------------------------------------ */
function computeLoadModel(trainings) {
  if (!trainings || !trainings.length) return { series: [], today: null };
  const load = {};
  for (const t of trainings) {
    if (!t.date) continue;
    let sessionLoad;
    const effort = Number(t.effort);
    const isStrength = typeof t.type === "string" && (t.type.startsWith("力量") || t.type.startsWith("稳定性") || t.type.startsWith("爆发力"));
    if (!isStrength && t.effort != null && !isNaN(effort) && effort > 0) {
      sessionLoad = effort; // cardio: Strava's HR-based Relative Effort
    } else {
      const rpe = Number(t.rpe) || 5; // strength / no-HR: RPE x minutes (HR under-counts lifting)
      const dur = Number(t.duration) || 0;
      sessionLoad = rpe * dur * 0.15;
    }
    load[t.date] = (load[t.date] || 0) + sessionLoad;
  }
  const dates = Object.keys(load).sort();
  const series = [];
  let ctl = 0, atl = 0;
  const d = new Date(dates[0] + "T00:00:00");
  const end = new Date(todayKey() + "T00:00:00");
  while (d <= end) {
    const key = keyOf(d);
    const L = load[key] || 0;
    ctl = ctl + (L - ctl) / 42;
    atl = atl + (L - atl) / 7;
    series.push({ x: fmtShort(key), date: key, fitness: Math.round(ctl), fatigue: Math.round(atl), form: Math.round(ctl - atl) });
    d.setDate(d.getDate() + 1);
  }
  const last = series[series.length - 1] || null;
  return { series, today: last ? { fitness: last.fitness, fatigue: last.fatigue, form: last.form } : null };
}

// Aerobic efficiency = metres per minute per heart-beat, per day (cardio only).
// Rising over time = running faster at the same HR = better aerobic base (Attia).
function computeAerobicEfficiency(trainings) {
  const byDay = {};
  for (const t of trainings) {
    const km = Number(t.km), dur = Number(t.duration), hr = Number(t.hr);
    if (!km || km <= 0 || !dur || !hr) continue;
    (byDay[t.date] = byDay[t.date] || []).push((km * 1000 / dur) / hr);
  }
  return Object.keys(byDay).sort().map(d => ({
    x: fmtShort(d), date: d,
    ef: +(byDay[d].reduce((a, b) => a + b, 0) / byDay[d].length).toFixed(2),
  }));
}

// Cardio intensity split by average HR vs estimated max HR (from observed data).
// Absolute HR zone edges matching Lynn's Strava setup (max HR ~185):
// Z1<121 · Z2 121-150 · Z3 151-165 · Z4 166-179 · Z5 180+
// Z1 <125 · Z2 125-154 · Z3 155-169 · Z4 170-184 · Z5 185+
const HR_ZONE_EDGES = [120, 150, 165, 179];
function computeZones(trainings) {
  const b = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  for (const t of trainings) {
    const km = Number(t.km), dur = Number(t.duration), hr = Number(t.hr);
    if (!km || km <= 0 || !dur || !hr) continue;
    const z = hr <= HR_ZONE_EDGES[0] ? "z1" : hr <= HR_ZONE_EDGES[1] ? "z2"
      : hr <= HR_ZONE_EDGES[2] ? "z3" : hr <= HR_ZONE_EDGES[3] ? "z4" : "z5";
    b[z] += dur;
  }
  const total = b.z1 + b.z2 + b.z3 + b.z4 + b.z5;
  return { ...b, total };
}

// Per-run series for the Running view: pace (min/km), avg HR, aerobic efficiency, distance.
function computeRunSeries(trainings) {
  return trainings
    .filter(t => Number(t.km) > 0 && Number(t.duration) > 0)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(t => {
      const km = Number(t.km), dur = Number(t.duration), hr = Number(t.hr) || null;
      return {
        x: fmtShort(t.date), date: t.date,
        pace: +(dur / km).toFixed(2),
        hr,
        ef: hr ? +((km * 1000 / dur) / hr).toFixed(2) : null,
        km,
      };
    });
}

/* ------------------------------------------------------------------ */
/*  i18n — language context + full string table                        */
/* ------------------------------------------------------------------ */
// Enum "key" stays the original bilingual string so existing stored records
// keep matching; only the DISPLAYED label is localized.
const TRAIN_TYPES = [
  { key: "力量 Strength", zh: "力量", en: "Strength" },
  { key: "稳定性 Stability", zh: "稳定性", en: "Stability" },
  { key: "爆发力/跳跃 Power", zh: "爆发力 / 跳跃", en: "Power / Plyometrics" },
  { key: "轻松有氧 Zone 2", zh: "轻松有氧 (Zone 2)", en: "Easy aerobic (Zone 2)" },
  { key: "高强度/间歇 VO2", zh: "高强度 / 间歇 (VO2)", en: "Intervals (VO2)" },
  { key: "恢复/灵活性", zh: "恢复 / 灵活性", en: "Recovery / Mobility" },
  { key: "Other activity", zh: "其他活动", en: "Other activity" },
];
const METRIC_TYPES = [
  { key: "VO2 max", zh: "VO2 max", en: "VO2 max" },
  { key: "体重 (kg)", zh: "体重 (kg)", en: "Weight (kg)" },
  { key: "体脂 (%)", zh: "体脂 (%)", en: "Body fat (%)" },
  { key: "肌肉量 (kg)", zh: "肌肉量 (kg)", en: "Muscle mass (kg)" },
  { key: "相位角 (°)", zh: "相位角 (°)", en: "Phase angle (°)" },
  { key: "内脏脂肪 (cm²)", zh: "内脏脂肪 (cm²)", en: "Visceral fat (cm²)" },
  { key: "BMR (kcal)", zh: "BMR (kcal)", en: "BMR (kcal)" },
  { key: "ApoB", zh: "ApoB", en: "ApoB" },
  { key: "空腹血糖 (mmol/L)", zh: "空腹血糖 (mmol/L)", en: "Fasting glucose (mmol/L)" },
  { key: "HbA1c (%)", zh: "HbA1c (%)", en: "HbA1c (%)" },
  { key: "空腹胰岛素 (mIU/L)", zh: "空腹胰岛素 (mIU/L)", en: "Fasting insulin (mIU/L)" },
  { key: "其他", zh: "其他", en: "Other" },
];
const SUPP_PRESETS = [
  { key: "蛋白粉", zh: "蛋白粉 · 早上", en: "Protein · AM" },
  { key: "肌酸", zh: "肌酸 · 早上", en: "Creatine · AM" },
  { key: "鱼油+维D", zh: "鱼油 · 午餐", en: "Fish oil · lunch" },
  { key: "镁", zh: "镁 · 睡前", en: "Magnesium · night" },
  { key: "铁", zh: "铁", en: "Iron" },
  { key: "钙", zh: "钙", en: "Calcium" },
  { key: "维生素B12", zh: "维生素 B12", en: "Vitamin B12" },
  { key: "电解质", zh: "电解质", en: "Electrolytes" },
  { key: "胶原蛋白", zh: "胶原蛋白", en: "Collagen" },
  { key: "益生菌", zh: "益生菌", en: "Probiotics" },
  { key: "维生素C", zh: "维生素 C", en: "Vitamin C" },
  { key: "锌", zh: "锌", en: "Zinc" },
  { key: "维D3+K2", zh: "维 D3+K2 · 午餐", en: "Vit D3+K2 · lunch" },
  { key: "南非醉茄", zh: "南非醉茄 · 睡前", en: "Ashwagandha · night" },
];
const DEFAULT_SUPP_KEYS = ["蛋白粉", "肌酸", "鱼油+维D", "镁"];
const SUGGESTED_SUPP_KEYS = ["维D3+K2", "南非醉茄", "铁", "钙", "维生素B12", "电解质", "胶原蛋白", "益生菌", "维生素C", "锌"];
// localize an enum key for display; falls back to the raw key (user-typed values)
function enumLabel(list, key, lang) {
  const hit = list.find(o => o.key === key);
  return hit ? hit[lang] : key;
}

/* ------------------------------------------------------------------ */
/*  Marathon weekly plan — auto-progressing long run + taper by race    */
/* ------------------------------------------------------------------ */
// Long-run distance for a given number of weeks-to-race, peaking ~4 weeks
// out then tapering. Cutback (easier) every 3rd build week.
function planLongKm(weeks, peak) {
  peak = Number(peak) || 30;
  if (weeks == null || weeks <= 0) return null;
  if (weeks === 1) return Math.round(peak * 0.45); // taper
  if (weeks === 2) return Math.round(peak * 0.65); // taper
  if (weeks === 3) return Math.round(peak * 0.85); // last long
  const fromPeak = weeks - 4;
  let km = peak - fromPeak * 2;
  if (fromPeak % 3 === 2) km -= 3; // cutback week
  return Math.max(12, Math.min(peak, Math.round(km)));
}
// Quality session type: short sharpener during taper, else alternate
// threshold (Z4) and VO2max (Z5) week to week.
function planQuality(weeks) {
  if (weeks != null && weeks > 0 && weeks <= 2) return "sharpen";
  return (weeks != null && weeks % 2 === 0) ? "threshold" : "vo2";
}
// Default weekly structure (Mon..Sun); editable via profile.planDays.
const DEFAULT_PLAN = [
  { type: "strength", note: "下肢 · 大重量" },       // 周一
  { type: "z2", note: "8-10K · 心率130-145" },       // 周二
  { type: "pilates", note: "Barre · 核心" },         // 周三
  { type: "quality", note: "5×3min 冲166+" },        // 周四
  { type: "strength", note: "上半身 + 核心" },        // 周五
  { type: "long", note: "22K · Z2 负分割" },          // 周六
  { type: "rest", note: "完全休息" },                 // 周日
];
// Weekly plan with the long run + quality auto-filled from race date.
function buildWeekPlan(profile) {
  const base = (Array.isArray(profile?.planDays) && profile.planDays.length === 7) ? profile.planDays : DEFAULT_PLAN;
  let weeks = null;
  if (profile?.eventDate) {
    const dleft = daysBetween(todayKey(), profile.eventDate);
    if (dleft >= 0) weeks = Math.ceil((dleft + 1) / 7);
  }
  const peak = Number(profile?.planPeakKm) || 30;
  const longKm = weeks ? planLongKm(weeks, peak) : null;
  const qual = weeks ? planQuality(weeks) : null;
  const todayIdx = (new Date().getDay() + 6) % 7; // Mon=0 .. Sun=6
  const taper = weeks != null && weeks > 0 && weeks <= 2;
  return {
    weeks, taper, todayIdx,
    rows: base.map((d, i) => ({
      idx: i, type: d.type, note: d.note || "", min: null,
      km: d.type === "long" ? longKm : null,
      qual: d.type === "quality" ? qual : null,
      isToday: i === todayIdx,
    })),
  };
}
// Localised { name, tgt } for one plan row (user note overrides defaults).
function planText(r, L) {
  const name = r.type === "rest" ? L.pRest : r.type === "strength" ? L.pStrength
    : r.type === "z2" ? L.pZ2 : r.type === "long" ? L.pLong
    : r.type === "pilates" ? L.pPilates : L.pQuality;
  let tgt;
  if (r.type === "long") tgt = r.note ? r.note : (r.km ? `${r.km}km · Z2` : "Z2");
  else if (r.note) tgt = r.note;
  else if (r.type === "rest") tgt = L.pRestNote;
  else if (r.type === "strength") tgt = L.pStrengthNote;
  else if (r.type === "z2") tgt = `${r.min || 40}min · Z2`;
  else if (r.type === "pilates") tgt = L.pPilatesNote;
  else tgt = r.qual === "threshold" ? L.pThr : r.qual === "vo2" ? L.pVo2 : r.qual === "sharpen" ? L.pSharp : L.pQualityGen;
  return { name, tgt };
}
function planTone(type) {
  return type === "long" || type === "z2" ? "z2" : type === "quality" ? "q"
    : type === "strength" ? "str" : type === "pilates" ? "pil" : "rest";
}

const STR = {
  zh: {
    appKicker: "Personal Health System", today: "今日", log: "记录", trends: "趋势", body: "身体",
    loading: "载入中…",
    foot: "BIA / 手表分期看趋势、单晚精度有限 · HRV 个体化只看相对基线 · AI 估蛋白质为方向性参考",
    healthSynced: "已从 Apple 健康同步：",
    // today
    statusTitle: "今日状态", readiness: "readiness", sleep: "睡眠", protein: "蛋白", fibre: "纤维",
    yProtein: "昨天蛋白", yFibre: "昨天纤维", race: "赛事", daysLeft: "还有", days: "天",
    getCoach: "获取今日教练建议", coaching: "教练分析中…",
    myReq: "✎ 我的回答要求", setReq: "＋ 设置回答要求", collapse: "收起",
    reqPlaceholder: "用你的话告诉教练怎么答。例：直接给动作和组数；膝盖旧伤避免深蹲；答简短点。",
    saveReq: "保存要求", cRead: "读身体", cTrain: "训练", cFuel: "补给",
    sleepCard: "睡眠", totalSleep: "睡眠总时长", energy: "精力", soreness: "酸痛(高=酸)", mood: "情绪",
    saveToday: "保存今日", save: "保存",
    hrCard: "心率", optional: "可选", baseline: "基线",
    // ea
    eaNoFood: "今天还没记录饮食", eaLow: "能量可用性偏低", eaLowMsg: "猛练 + 蛋白不足 + 没补给 — 先把饭吃够",
    eaGood: "补给充足", eaGoodMsg: "蛋白质达标", eaUnder: "蛋白质未达标", eaUnderMsg1: "还差", eaUnderMsg2: "g",
    // log / training
    training: "训练", type: "类型", otherName: "名称(普拉提 / 攀岩 / 徒步…)",
    duration: "时长 (min)", addTraining: "添加训练", noTrain7: "今天 / 昨天没有训练记录",
    // log / food
    food: "饮食", snap: "拍一餐", photo: "拍照 / 选图", manualAdd: "手动添加",
    proteinG: "蛋白质 (g)", fibreG: "纤维 (g)", kcalG: "热量 (kcal)", kcal: "热量", note: "备注", noteOpt: "备注(可选)",
    egMeal: "例：鸡胸 + 米饭", fuelled: "训练前后补给", saveMeal: "记录这一餐",
    analyzing: "AI 估算中…", kcalNote: "", todayProtein: "今日蛋白", todayFibre: "今日纤维", todayCal: "今日热量", calRef: "参考:休息~2100 · 训练~2500 · 长跑~3100",
    cancel: "取消",
    // supplements
    supps: "补剂", editList: "编辑清单", done: "完成", otherFill: "其他·自己填", add: "添加",
    // goals
    goals: "目标", weight: "体重 (kg)", proteinPerKg: "蛋白 g/kg", fibreTarget: "纤维目标 (g/天)",
    hrvBaseL: "HRV 基线", rhrBaseL: "RHR 基线", baselineNote: "默认基线 HRV 40 / RHR 54,教练拿它对比。想改随时在这里填,填了以你的为准。",
    proteinTargetTxt: "→ 蛋白质目标", perDay: "g/天", saveGoals: "保存目标",
    // race
    raceTitle: "备赛", raceName: "赛事名称", raceNamePh: "例：半马 / 比赛名", raceDate: "赛事日期",
    raceUntil1: "距【", raceUntil2: "】还有", raceUntil3: "天", racePast: "已过去",
    // strava
    stravaConnect: "连接 Strava,训练自动同步进来并喂给 AI 教练。", stravaConnecting: "连接中…",
    stravaConnectBtn: "连接 Strava", stravaConnected: "已连接", stravaLastSync: " · 上次同步 ",
    stravaSyncing: "同步中…", stravaSyncBtn: "立即同步", stravaDisconnect: "断开连接",
    // trends
    chart: "图表", byDay: "按日", all: "全部", recentN: d => `近 ${d} 天`,
    sleepTrend: "(总时长 / 深睡)", hrTrend: "HRV / RHR 趋势", weekMix: "本周训练配比(分钟)",
    dietGoal: "饮食目标 · 蛋白质 & 纤维", dashTargets: "虚线为目标：蛋白",
    // body
    periodicMetrics: "周期性指标", record: "记录",
    metricsNote: "north-star 是功能能力与代谢/细胞质量(VO2max、肌肉量、相位角),不是步数和卡路里。",
    noMetrics: "还没有指标记录", cycleTitle: "月经周期规律", periodStart: "月经开始日",
    logPeriod: "记录这次月经", sinceLast1: "距上次", sinceLastNone: "尚无记录",
    cycleLen: "周期长度 (天)", cycleEvery: "周期", cycleLast: "最近一次",
    regular: "规律", fluctuate: "波动", watch: "留意",
    needTwoPeriods: "记录至少两次月经,即可看到周期长度与规律性。记录后首页的周期 phase 会自动锚定到最近一次。",
    // history
    pickDate: "选择日期", jumpDate: "跳到有记录的日子", pick: "选择…",
    noDayData: "这一天没有记录。", dayStatus: "当日状态", bodyMetrics: "身体指标",
    none: "无", protein2: "蛋白", fibre2: "纤维",
    clearConfirm: "清空所有数据?不可恢复。",
    backupTitle: "数据备份", exportBtn: "导出备份", importBtn: "导入备份",
    backupNote: "导出全部数据存成文件；换手机或清缓存后,用导入恢复。",
    importConfirm: "用这个备份覆盖当前数据?", importDone: "已恢复", importBad: "文件无法识别",
    loadTitle: "体能 · 疲劳 · 状态", mFitness: "体能", mFatigue: "疲劳", mForm: "状态",
    formFresh: "偏新鲜,可以上强度", formBalanced: "状态均衡", formTired: "偏疲劳,注意恢复",
    loadNote: "体能=长期底子 · 疲劳=近期累积 · 状态=体能−疲劳(正=新鲜,负=疲劳)。已含力量训练。",
    efTitle: "有氧效率", efNote: "越高越好:同样心率下跑得更快,说明有氧底子在变好。",
    zoneTitle: "跑步强度分区", z1: "Z1 恢复", z2: "Z2 有氧", z3: "Z3 灰区", z4: "Z4 阈值", z5: "Z5 最大",
    zoneNote: "目标:大量时间在 Z2 有氧,少量 Z4/Z5,少泡 Z3 灰区。按 Strava 跑步平均心率估算。",
    planTitle: "本周计划", weeksLeft: n => `还有 ${n} 周`, taperTag: "减量期",
    pRest: "休息", pStrength: "力量", pZ2: "轻松 Z2", pLong: "长距离 Z2", pQuality: "间歇",
    pRestNote: "休息 / 放松", pStrengthNote: "大重量", pQualityGen: "间歇训练",
    pThr: "阈值 (Z4)", pVo2: "最大摄氧 (Z5)", pSharp: "赛前短刺激",
    planPeak: "长距离峰值 (km)", planNeedDate: "在下方「备赛」设置比赛日期,自动生成马拉松进阶计划。",
    planExpand: "展开本周计划", planCollapse: "收起", planAskPh: "问教练这份计划…",
    briefShow: "展开本周周报", briefHide: "收起周报", planUpdated: "（计划表已更新）", clearChat: "清空对话",
    planAutoNote: "长距离随赛期自动进阶、赛前自动减量。计划是参考:HRV 低或经期就把间歇/Tempo 换成 Z2。",
    todayPlan: "今日计划", dow: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
    pPilates: "普拉提", pPilatesNote: "放松 / 恢复", planNotePh: "备注(如 下肢 / 30–45min)",
    editPlan: "编辑计划", planDone: "完成", loadCoach: "载入教练计划",
    refreshAnalysis: "更新本周分析", refreshingWk: "分析中…约30秒", refreshDone: "已更新。往上看新的本周分析,再点「载入教练计划」应用新计划。", refreshFail: "更新失败,请稍后再试。", refreshCooled: n => `刚更新过,${n} 分钟后可再更新(上方已是最新)。`,
    askYou: "你:", askCoachLbl: "教练:", askPh: "就这些建议追问…", askSend: "问",
    runView: "跑步", paceTitle: "配速 (分钟/公里)", paceNote: "越低=越快", runHrTitle: "跑步心率 (平均)",
    distTitle: "跑步距离 (公里)", noRuns: "这个范围内没有跑步记录",
  },
  en: {
    appKicker: "Personal Health System", today: "Today", log: "Log", trends: "Trends", body: "Body",
    loading: "Loading…",
    foot: "BIA / watch stages show trends, single-night precision is limited · HRV is personal, read vs your own baseline · AI protein estimate is directional",
    healthSynced: "Synced from Apple Health: ",
    statusTitle: "Today", readiness: "readiness", sleep: "Sleep", protein: "Protein", fibre: "Fibre",
    yProtein: "Yest. protein", yFibre: "Yest. fibre", race: "Race", daysLeft: "in", days: "d",
    getCoach: "Get today's coaching", coaching: "Analyzing…",
    myReq: "✎ My answer preferences", setReq: "＋ Set answer preferences", collapse: "Collapse",
    reqPlaceholder: "Tell the coach how to answer. E.g. give exact moves & sets; avoid squats (knee); keep it short.",
    saveReq: "Save", cRead: "Read", cTrain: "Train", cFuel: "Fuel",
    sleepCard: "Sleep", totalSleep: "Total sleep", energy: "Energy", soreness: "Soreness (high=sore)", mood: "Mood",
    saveToday: "Save today", save: "Save",
    hrCard: "Heart rate", optional: "optional", baseline: "baseline",
    eaNoFood: "No food logged yet today", eaLow: "Low energy availability", eaLowMsg: "Hard training + low protein + unfueled — eat enough first",
    eaGood: "Well fueled", eaGoodMsg: "Protein on target", eaUnder: "Protein below target", eaUnderMsg1: "", eaUnderMsg2: "g to go",
    training: "Training", type: "Type", otherName: "Name (pilates / climbing / hike…)",
    duration: "Duration (min)", addTraining: "Add training", noTrain7: "No training today or yesterday",
    food: "Food", snap: "Snap a meal", photo: "Photo / pick", manualAdd: "Add manually",
    proteinG: "Protein (g)", fibreG: "Fibre (g)", kcalG: "Calories (kcal)", kcal: "Calories", note: "Note", noteOpt: "Note (optional)",
    egMeal: "e.g. chicken breast + rice", fuelled: "Pre/post-workout fuel", saveMeal: "Save meal",
    analyzing: "AI estimating…", kcalNote: "", todayProtein: "Protein today", todayFibre: "Fibre today", todayCal: "Calories today", calRef: "ref: rest ~2100 · training ~2500 · long run ~3100",
    cancel: "Cancel",
    supps: "Supplements", editList: "Edit list", done: "Done", otherFill: "Other (type your own)", add: "Add",
    goals: "Goals", weight: "Weight (kg)", proteinPerKg: "Protein g/kg", fibreTarget: "Fibre target (g/day)",
    hrvBaseL: "HRV baseline", rhrBaseL: "RHR baseline", baselineNote: "Defaults to HRV 40 / RHR 54, which the coach compares against. Type your own here any time and yours wins.",
    proteinTargetTxt: "→ Protein target", perDay: "g/day", saveGoals: "Save goals",
    raceTitle: "Race", raceName: "Race name", raceNamePh: "e.g. half marathon", raceDate: "Race date",
    raceUntil1: "", raceUntil2: " — ", raceUntil3: " days to go", racePast: "passed",
    stravaConnect: "Connect Strava — workouts sync in and feed the AI coach.", stravaConnecting: "Connecting…",
    stravaConnectBtn: "Connect Strava", stravaConnected: "Connected", stravaLastSync: " · last sync ",
    stravaSyncing: "Syncing…", stravaSyncBtn: "Sync now", stravaDisconnect: "Disconnect",
    chart: "Charts", byDay: "By day", all: "All", recentN: d => `Last ${d} days`,
    sleepTrend: "(total / deep)", hrTrend: "HRV / RHR trend", weekMix: "This week's training mix (min)",
    dietGoal: "Diet goals · Protein & Fibre", dashTargets: "Dashed = target: protein",
    periodicMetrics: "Periodic metrics", record: "Add",
    metricsNote: "North-star is function & metabolic/cellular quality (VO2max, muscle, phase angle) — not steps or calories.",
    noMetrics: "No metrics logged yet", cycleTitle: "Cycle regularity", periodStart: "Period start date",
    logPeriod: "Log this period", sinceLast1: "since last", sinceLastNone: "no record yet",
    cycleLen: "Cycle length (days)", cycleEvery: "cycle", cycleLast: "most recent",
    regular: "Regular", fluctuate: "Variable", watch: "Watch",
    needTwoPeriods: "Log at least two periods to see cycle length & regularity. The home-page phase anchors to the latest one.",
    pickDate: "Pick a date", jumpDate: "Jump to a day with data", pick: "Select…",
    noDayData: "No records for this day.", dayStatus: "That day", bodyMetrics: "Body metrics",
    none: "none", protein2: "protein", fibre2: "fibre",
    clearConfirm: "Clear all data? This cannot be undone.",
    backupTitle: "Backup", exportBtn: "Export backup", importBtn: "Import backup",
    backupNote: "Export all data to a file; restore with Import after switching phones or clearing cache.",
    importConfirm: "Overwrite current data with this backup?", importDone: "Restored", importBad: "Couldn't read this file",
    loadTitle: "Fitness · Fatigue · Form", mFitness: "Fitness", mFatigue: "Fatigue", mForm: "Form",
    formFresh: "Fresh — you can push", formBalanced: "Balanced", formTired: "Fatigued — ease off",
    loadNote: "Fitness = long-term base · Fatigue = recent load · Form = fitness − fatigue (positive = fresh, negative = tired). Strength training included.",
    efTitle: "Aerobic efficiency", efNote: "Higher is better: faster at the same heart rate means your aerobic base is improving.",
    zoneTitle: "Cardio zones", z1: "Z1 Recovery", z2: "Z2 Aerobic", z3: "Z3 Grey", z4: "Z4 Threshold", z5: "Z5 Max",
    zoneNote: "Aim for lots of Z2 aerobic + a little Z4/Z5, avoid the Z3 grey zone. Estimated from Strava average HR.",
    planTitle: "This week", weeksLeft: n => `${n} wks to race`, taperTag: "Taper",
    pRest: "Rest", pStrength: "Strength", pZ2: "Easy Z2", pLong: "Long Z2", pQuality: "Intervals",
    pRestNote: "Rest / mobility", pStrengthNote: "Heavy", pQualityGen: "Interval work",
    pThr: "Threshold (Z4)", pVo2: "VO2max (Z5)", pSharp: "Pre-race strides",
    planPeak: "Long-run peak (km)", planNeedDate: "Set a race date under Race below to auto-build a marathon plan.",
    planExpand: "Show full week", planCollapse: "Collapse", planAskPh: "Ask the coach about this plan…",
    briefShow: "Show weekly report", briefHide: "Hide report", planUpdated: "(plan table updated)", clearChat: "Clear chat",
    planAutoNote: "Long run auto-progresses and tapers before race day. It's a guide: swap quality for Z2 when HRV is low or during your period.",
    todayPlan: "Today's plan", dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    pPilates: "Pilates", pPilatesNote: "Recovery", planNotePh: "Note (e.g. lower / 30–45min)",
    editPlan: "Edit plan", planDone: "Done", loadCoach: "Load coach plan",
    refreshAnalysis: "Refresh weekly analysis", refreshingWk: "Analyzing… ~30s", refreshDone: "Updated. See the new analysis above, then tap Load coach plan to apply.", refreshFail: "Update failed, try again later.", refreshCooled: n => `Just updated — try again in ${n} min (latest shown above).`,
    askYou: "You: ", askCoachLbl: "Coach: ", askPh: "Ask about this advice…", askSend: "Ask",
    runView: "Running", paceTitle: "Pace (min/km)", paceNote: "Lower = faster", runHrTitle: "Running HR (avg)",
    distTitle: "Distance (km)", noRuns: "No runs in this range",
  },
};
const LangCtx = React.createContext({ lang: "zh", L: STR.zh });
const useLang = () => React.useContext(LangCtx);

/* ------------------------------------------------------------------ */
/*  Strava (OAuth via /api/strava — client secret stays server-side)   */
/* ------------------------------------------------------------------ */
const STRAVA_CLIENT_ID = "253673";
const STRAVA_SCOPE = "activity:read_all";
function stravaAuthUrl() {
  const redirect = window.location.origin + window.location.pathname;
  const p = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    redirect_uri: redirect,
    response_type: "code",
    approval_prompt: "force",
    scope: STRAVA_SCOPE,
  });
  return "https://www.strava.com/oauth/authorize?" + p.toString();
}
async function stravaCall(payload) {
  const r = await fetch("/api/strava", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}
function mapStravaType(t) {
  if (!t) return "Other activity";
  if (/Weight|Workout|Crossfit|HIIT/i.test(t)) return "力量 Strength";
  if (/Yoga|Pilates|Stretch|Mobility/i.test(t)) return "恢复/灵活性";
  if (/Run|Ride|Walk|Hike|Swim|Row|Elliptical/i.test(t)) return "轻松有氧 Zone 2";
  return "Other activity";
}
function stravaToTraining(a) {
  const start = a.start_date_local || a.start_date;
  return {
    id: Date.parse(start),
    strava_id: a.id,
    date: keyOf(new Date(start)),
    type: mapStravaType(a.type),
    label: a.name || a.type || "Strava",
    duration: Math.round((a.moving_time || 0) / 60),
    rpe: (a.perceived_exertion != null ? a.perceived_exertion : ""),
    km: a.distance ? +(a.distance / 1000).toFixed(1) : null,
    hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
    maxhr: a.max_heartrate ? Math.round(a.max_heartrate) : null,
    effort: a.suffer_score ?? null,
    source: "strava",
  };
}

/* ================================================================== */
/*  App                                                                */
/* ================================================================== */
export default function App() {
  const [tab, setTab] = useState("today");
  const [lang, setLang] = useState(() => { try { return localStorage.getItem("hs:lang") || "zh"; } catch { return "zh"; } });
  const L = STR[lang] || STR.zh;
  const toggleLang = () => { const n = lang === "zh" ? "en" : "zh"; setLang(n); try { localStorage.setItem("hs:lang", n); } catch { /* ignore */ } };
  const [profile, setProfile] = useState(null);
  const [daily, setDaily] = useState({});            // today's daily log
  const [history, setHistory] = useState([]);        // [{date, ...daily}]
  const [trainings, setTrainings] = useState([]);
  const [meals, setMeals] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [coach, setCoach] = useState(null);
  const [loading, setLoading] = useState(true);
  const [strava, setStrava] = useState({ connected: false, name: "", last: null, syncing: false, msg: "" });
  const [healthMsg, setHealthMsg] = useState("");

  const tk = todayKey();
  const restored = useRef(false);

  /* ---- load everything ---- */
  const reload = useCallback(async () => {
    if (!restored.current) { restored.current = true; await restoreIfEmpty(); }
    const prof = (await store.get("profile")) || { weight: 53, proteinPerKg: 2.0, cycleStart: "", cycleLen: 28, eventDate: "" };
    setProfile(prof);
    setDaily((await store.get(`daily:${tk}`)) || {});
    setCoach(await store.get(`coach:${tk}`));

    const dk = await store.list("daily:");
    const hist = (await Promise.all(dk.map(async k => ({ date: k.slice(6), ...(await store.get(k)) }))))
      .sort((a, b) => a.date.localeCompare(b.date));
    setHistory(hist);

    const tkeys = await store.list("training:");
    setTrainings((await Promise.all(tkeys.map(k => store.get(k)))).filter(Boolean).sort((a, b) => b.id - a.id));
    const mkeys = await store.list("meal:");
    setMeals((await Promise.all(mkeys.map(k => store.get(k)))).filter(Boolean).sort((a, b) => b.id - a.id));
    const xkeys = await store.list("metric:");
    setMetrics((await Promise.all(xkeys.map(k => store.get(k)))).filter(Boolean).sort((a, b) => b.id - a.id));
    setLoading(false);
  }, [tk]);

  useEffect(() => { reload(); }, [reload]);

  /* ---- Strava: connection state, sync, OAuth redirect ---- */
  const refreshStrava = useCallback(async () => {
    const refresh = await store.get("strava:refresh");
    const ath = await store.get("strava:athlete");
    const last = await store.get("strava:lastSync");
    setStrava(s => ({ ...s, connected: !!refresh, name: ath?.name || "", last }));
  }, []);

  const syncStrava = useCallback(async () => {
    const refresh = await store.get("strava:refresh");
    if (!refresh) return;
    setStrava(s => ({ ...s, syncing: true, msg: "" }));
    try {
      const last = await store.get("strava:lastSync");
      const after = last ? Math.floor(last) : Math.floor(Date.now() / 1000) - 60 * 86400;
      const res = await stravaCall({ action: "sync", refresh_token: refresh, after });
      if (res.error) { setStrava(s => ({ ...s, syncing: false, msg: "同步失败：" + res.error + (res.detail ? " · " + JSON.stringify(res.detail).slice(0, 180) : "") })); return; }
      if (res.refresh_token) await store.set("strava:refresh", res.refresh_token);
      let n = 0;
      for (const a of (res.activities || [])) {
        await store.set(`training:strava-${a.id}`, stravaToTraining(a));
        n++;
      }
      const now = Math.floor(Date.now() / 1000);
      await store.set("strava:lastSync", now);
      setStrava(s => ({ ...s, syncing: false, last: now, msg: n ? `同步了 ${n} 条活动 ✓` : "已是最新，无新活动" }));
      reload();
    } catch {
      setStrava(s => ({ ...s, syncing: false, msg: "同步失败，检查网络" }));
    }
  }, [reload]);

  const connectStrava = () => { window.location.href = stravaAuthUrl(); };
  const disconnectStrava = useCallback(async () => {
    await store.del("strava:refresh"); await store.del("strava:athlete"); await store.del("strava:lastSync");
    setStrava({ connected: false, name: "", last: null, syncing: false, msg: "已断开连接" });
  }, []);

  useEffect(() => { refreshStrava(); }, [refreshStrava]);

  // Handle the redirect back from Strava (?code=...&scope=...)
  useEffect(() => {
    const u = new URL(window.location.href);
    const code = u.searchParams.get("code");
    if (!code || !u.searchParams.get("scope")) return;
    (async () => {
      setStrava(s => ({ ...s, syncing: true, msg: "连接中…" }));
      const res = await stravaCall({ action: "exchange", code });
      window.history.replaceState({}, "", u.origin + u.pathname);
      if (res.error || !res.refresh_token) {
        setStrava(s => ({ ...s, syncing: false, msg: "连接失败：" + (res.error || "未知错误") }));
        return;
      }
      await store.set("strava:refresh", res.refresh_token);
      if (res.athlete) await store.set("strava:athlete", { id: res.athlete.id, name: [res.athlete.firstname, res.athlete.lastname].filter(Boolean).join(" ") });
      await refreshStrava();
      syncStrava();
    })();
  }, [refreshStrava, syncStrava]);

  // Apple Health: pull data the iOS Shortcut POSTed to /api/health on the server.
  // The Shortcut can't reliably write the installed PWA's localStorage (the home
  // screen app and Safari have separate storage), so it sends to the server and
  // we merge it here. Server fields fill only BLANK local fields — any value you
  // typed/corrected by hand wins, so nothing accurate gets overwritten.
  useEffect(() => {
    (async () => {
      let data;
      try {
        const r = await fetch("/api/health");
        if (!r.ok) return;
        ({ data } = await r.json());
      } catch { return; }
      if (!data || typeof data !== "object") return;
      const F = { hrv: "hrv", rhr: "rhr", sleep: "sleepTotal", deep: "deep", rem: "rem" };
      let changed = false;
      for (const [date, v] of Object.entries(data)) {
        if (!v || typeof v !== "object") continue;
        const cur = (await store.get(`daily:${date}`)) || {};
        const next = { ...cur };
        for (const [src, dst] of Object.entries(F)) {
          if (v[src] == null) continue;
          if (next[dst] == null || next[dst] === "") { next[dst] = v[src]; changed = true; }
        }
        if (JSON.stringify(next) !== JSON.stringify(cur)) await store.set(`daily:${date}`, next);
      }
      if (changed) {
        const t = data[tk];
        if (t) {
          const parts = [];
          if (t.sleep != null) parts.push(`${L.sleep} ${t.sleep}h`);
          if (t.hrv != null) parts.push(`HRV ${t.hrv}`);
          if (t.rhr != null) parts.push(`RHR ${t.rhr}`);
          if (parts.length) setHealthMsg(L.healthSynced + parts.join(" · "));
        }
        reload();
      }
    })();
  }, [tk, reload]);

  const saveProfile = async p => { setProfile(p); await store.set("profile", p); };
  const saveDaily = async d => { setDaily(d); await store.set(`daily:${tk}`, d); reload(); };

  /* ---- derived ---- */
  const phase = profile ? cyclePhase(profile.cycleStart, profile.cycleLen, lang) : null;
  const proteinTarget = profile ? Math.round(profile.weight * profile.proteinPerKg) : 0;
  const fibreTarget = Math.round(Number(profile?.fibreTarget) || 35);
  const todayMeals = meals.filter(m => m.date === tk);
  const todayProtein = todayMeals.reduce((s, m) => s + (Number(m.protein) || 0), 0);
  const todayFibre = todayMeals.reduce((s, m) => s + (Number(m.fibre) || 0), 0);
  const todayCal = todayMeals.reduce((s, m) => s + (Number(m.cal) || 0), 0);
  const ydate = keyOf(new Date(Date.now() - 86400000));
  const ydayMeals = meals.filter(m => m.date === ydate);
  const proteinYday = ydayMeals.reduce((s, m) => s + (Number(m.protein) || 0), 0);
  const fibreYday = ydayMeals.reduce((s, m) => s + (Number(m.fibre) || 0), 0);
  const ateToday = todayMeals.length > 0;
  const todayTrain = trainings.filter(t => t.date === tk);
  const hardToday = todayTrain.some(t => t.type.startsWith("力量") || t.type.startsWith("高强度"));
  const fuelled = todayMeals.length ? todayMeals.some(m => m.fuelled) : false;

  // energy availability flag
  let ea = { label: "—", tone: "muted", msg: L.eaNoFood };
  if (todayMeals.length) {
    if (hardToday && todayProtein < 0.8 * proteinTarget && !fuelled) ea = { label: L.eaLow, tone: "clay", msg: L.eaLowMsg };
    else if (todayProtein >= proteinTarget) ea = { label: L.eaGood, tone: "pine", msg: L.eaGoodMsg };
    else ea = { label: L.eaUnder, tone: "amber", msg: `${L.eaUnderMsg1}${Math.max(0, proteinTarget - todayProtein)}${L.eaUnderMsg2}` };
  }

  // baselines from history (last 14 entries with values)
  const recent = history.slice(-14);
  const avg = (arr, f) => { const v = arr.map(f).filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  // Baseline: what she types in the Goals card wins; otherwise her stated
  // baseline (HRV 40 / RHR 54), which is steadier than a bouncing 14-day average.
  const hrvBase = Number(profile?.hrvBase) || 40;
  const rhrBase = Number(profile?.rhrBase) || 54;

  // simple readiness score
  function readiness() {
    let n = 0, sum = 0;
    if (daily.sleepTotal) { sum += Math.min(100, (Number(daily.sleepTotal) / SLEEP_TARGET) * 100); n++; }
    if (daily.hrv && hrvBase) { sum += Math.max(0, Math.min(100, 50 + (Number(daily.hrv) - hrvBase) / hrvBase * 200)); n++; }
    if (daily.rhr && rhrBase) { sum += Math.max(0, Math.min(100, 50 - (Number(daily.rhr) - rhrBase) / rhrBase * 200)); n++; }
    if (daily.energy) { sum += (Number(daily.energy) / 5) * 100; n++; }
    if (daily.mood) { sum += (Number(daily.mood) / 5) * 100; n++; }
    if (daily.soreness) { sum += ((6 - Number(daily.soreness)) / 5) * 100; n++; }
    return n ? Math.round(sum / n) : null;
  }
  const score = readiness();
  const scoreTone = score == null ? "muted" : score >= 70 ? "pine" : score >= 50 ? "amber" : "clay";

  /* ---- AI coach ---- */
  const coachCtx = () => ({
    today: { date: tk, ...daily, readiness_score: score },
    baselines: { hrv: hrvBase ? Math.round(hrvBase) : null, rhr: rhrBase ? Math.round(rhrBase) : null, sleep_target: SLEEP_TARGET },
    cycle: phase ? { day: phase.day, phase: phase.phase } : null,
    last7_training: trainings.filter(t => daysBetween(t.date, tk) < 7).map(t => ({ type: t.type, min: t.duration, rpe: t.rpe || null, km: t.km || null, hr: t.hr || null, effort: t.effort ?? null })),
    calories_today: todayCal || null, protein_today_g: todayProtein, protein_target_g: proteinTarget,
    fibre_today_g: todayFibre, fibre_target_g: fibreTarget,
    protein_yesterday_g: proteinYday, fibre_yesterday_g: fibreYday,
    recent_sleep: recent.slice(-7).map(d => ({ date: d.date, hrs: d.sleepTotal, deep: d.deep })),
    event_date: profile.eventDate || null,
    subjective_scale: "energy/mood/soreness 均为1-5分制(不是10分制):energy/mood 5=最好;soreness 1=不酸、5=很酸",
  });
  const [coaching, setCoaching] = useState(false);
  async function getCoaching() {
    setCoaching(true);
    try {
      const ctx = coachCtx();
      const systemZh =
        "你是一位结合 Peter Attia (Outlive / healthspan) 与 Stacy Sims (女性生理) 框架的训练与恢复教练。" +
        "用户是长期力量训练者(也跑步),目标是科学健康地训练。关键原则:" +
        "(1) HRV/RHR 只看相对个人基线的偏离,且黄体期 HRV 自然下降不视为需要休息;" +
        "(2) 强调力量+爆发力+稳定性,而非单纯堆量;" +
        "(3) 警惕能量可用性偏低(吃不够),鼓励充足补给而非节食;若今日蛋白/纤维为 0(通常是清晨还没吃),补给建议要基于'昨日实际摄入'与'今日目标'来给(例:昨天蛋白没达标,今天注意补够),不要因今日为 0 就判定吃不足;" +
        "(4) 关注近 7 天训练类型配比是否失衡。" +
        (profile.coachPrompt ? "用户的额外要求(优先满足,只要不违背安全):" + profile.coachPrompt + " " : "") +
        "仅返回 JSON,无其他文字,格式:" +
        '{"read":"一句话读懂今天身体状态","sleep":"今晚睡眠建议(结合近期睡眠债/深睡,给今晚怎么调,简短)","training":"今日训练建议(具体类型)","fueling":"补给提示","flag":"一条需要注意的(无则空字符串)"}。中文,每条简短。';
      const systemEn =
        "You are a training & recovery coach blending Peter Attia (Outlive / healthspan) and Stacy Sims (female physiology). " +
        "The user is a long-term strength trainer who also runs; the goal is to train healthily and scientifically. Key principles: " +
        "(1) Read HRV/RHR only relative to the personal baseline; a luteal-phase HRV dip is NOT a reason to rest. " +
        "(2) Emphasize strength + power + stability over piling on volume. " +
        "(3) Watch for low energy availability (under-eating); encourage adequate fueling, not dieting. If today's protein/fibre is 0 (usually early morning, not eaten yet), base fueling advice on YESTERDAY's actual intake vs targets (e.g. you missed protein yesterday, top up today) — do NOT call it under-eating just because today is 0. " +
        "(4) Watch whether the last 7 days' training mix is unbalanced. " +
        (profile.coachPrompt ? "User's extra preferences (satisfy first, as long as safe): " + profile.coachPrompt + " " : "") +
        'Return JSON ONLY, no other text, format: {"read":"one line reading today\'s body state","sleep":"tonight\'s sleep tip (factor recent sleep debt / deep sleep; how to adjust tonight; short)","training":"today\'s training suggestion (specific type)","fueling":"fueling tip","flag":"one thing to watch (empty string if none)"}. In English, each item short.';
      const userMsg = (lang === "en" ? "My data:\n" : "我的数据:\n") + JSON.stringify(ctx, null, 2);
      const text = await callClaude([{ role: "user", content: userMsg }], lang === "en" ? systemEn : systemZh, 700);
      const j = parseJSON(text) || { read: text, training: "", fueling: "", flag: "" };
      setCoach(j); await store.set(`coach:${tk}`, j);
    } catch (e) {
      setCoach({ read: lang === "en" ? "Can't reach AI (check network & API key)." : "无法连接 AI(检查网络与 API key 设置)。", training: "", fueling: "", flag: "" });
    }
    setCoaching(false);
  }

  /* ---- coach follow-up chat ---- */
  const [coachChat, setCoachChat] = useState([]);
  const [coachAsking, setCoachAsking] = useState(false);
  async function askCoach(raw) {
    const question = (raw || "").trim();
    if (!question || coachAsking) return;
    setCoachAsking(true);
    setCoachChat(c => [...c, { role: "user", text: question }]);
    const prior = coachChat;
    try {
      const primer = (lang === "en" ? "My data today:\n" : "我今天的数据:\n") + JSON.stringify(coachCtx())
        + (coach ? (lang === "en" ? "\n\nYour earlier advice: " : "\n\n你之前给我的建议:") + JSON.stringify(coach) : "");
      const sys = lang === "en"
        ? "You are the user's personal training & recovery coach, blending Peter Attia (healthspan) and Stacy Sims (female physiology), and you know she's training healthily for a sub-4h marathon on 2026-09-13. Based on her data and your earlier advice, answer her follow-up questions conversationally in English — concise, specific, actionable. No JSON, no long essays."
        : "你是用户的私人训练与恢复教练,融合 Peter Attia(健康寿命)与 Stacy Sims(女性生理)框架,也懂她在健康地备战 2026-09-13 的全马(目标轻松进 4 小时)。基于她的数据和你之前给的建议,用中文口语、简洁、具体、可执行地回答她的追问。不要用 JSON,不要长篇大论。"
        + (profile.coachPrompt ? "用户的额外要求(优先满足,只要安全):" + profile.coachPrompt : "");
      const msgs = [
        { role: "user", content: primer },
        { role: "assistant", content: lang === "en" ? "Got it — ask away." : "好的,你问吧。" },
        ...prior.map(m => ({ role: m.role, content: m.text })),
        { role: "user", content: question },
      ];
      const text = await callClaude(msgs, sys, 500);
      setCoachChat(c => [...c, { role: "assistant", text: text || "…" }]);
    } catch {
      setCoachChat(c => [...c, { role: "assistant", text: lang === "en" ? "Can't reach AI right now." : "暂时连不上 AI(检查网络/API key)。" }]);
    }
    setCoachAsking(false);
  }

  if (loading || !profile) return <div className="hs-root"><Style /><div className="hs-load">{L.loading}</div></div>;

  return (
    <LangCtx.Provider value={{ lang, L }}>
    <div className="hs-root">
      <Style />
      <header className="hs-head">
        <div>
          <div className="hs-kicker">{L.appKicker}</div>
          <h1 className="hs-title">{L.today} · {tk}</h1>
        </div>
        <div className="hs-head-r">
          {phase && (
            <div className="hs-phase">
              <span className="hs-phase-day">D{phase.day}</span>
              <span className="hs-phase-name">{phase.phase}</span>
            </div>
          )}
          <button className="hs-lang" onClick={toggleLang}>{lang === "zh" ? "EN" : "中"}</button>
        </div>
      </header>

      {healthMsg && (
        <div className="hs-health-banner" onClick={() => setHealthMsg("")}>
          <Check size={14} /> {healthMsg}
        </div>
      )}

      <nav className="hs-nav">
        {[["today", L.today, HeartPulse], ["sleep", L.sleep, Moon], ["diet", L.food, Apple], ["training", L.training, Dumbbell], ["body", L.body, Activity]]
          .map(([id, label, Icon]) => (
            <button key={id} className={"hs-tab" + (tab === id ? " on" : "")} onClick={() => setTab(id)}>
              <Icon size={16} /><span>{label}</span>
            </button>
          ))}
      </nav>

      <main className="hs-main">
        {tab === "today" && (
          <Today {...{ daily, score, scoreTone, phase, ea, proteinTarget, todayProtein,
            fibreTarget, todayFibre, proteinYday, fibreYday, ateToday, coach, getCoaching, coaching,
            coachChat, askCoach, coachAsking,
            profile, saveProfile, history, trainings, meals, metrics, tk }} />
        )}
        {tab === "sleep" && (
          <SleepPage {...{ daily, saveDaily, hrvBase, rhrBase, history }} />
        )}
        {tab === "diet" && (
          <DietPage {...{ tk, meals, history, reload, proteinTarget, fibreTarget, profile, saveProfile }} />
        )}
        {tab === "training" && (
          <TrainingPage {...{ tk, trainings, reload, profile, saveProfile,
            strava, connectStrava, disconnectStrava, syncStrava }} />
        )}
        {tab === "body" && (
          <Body {...{ metrics, reload, profile, saveProfile }} />
        )}
      </main>
      <footer className="hs-foot">
        {L.foot}
      </footer>
    </div>
    </LangCtx.Provider>
  );
}

/* ================================================================== */
/*  TODAY                                                               */
/* ================================================================== */
function Today({ daily, score, scoreTone, phase, ea, proteinTarget, todayProtein, fibreTarget, todayFibre, proteinYday, fibreYday, ateToday, coach, getCoaching, coaching, coachChat, askCoach, coachAsking, profile, saveProfile, history, trainings, meals, metrics, tk }) {
  const { L } = useLang();
  const [coachQ, setCoachQ] = useState("");

  // sleep summary for the status chips (last night's total vs target)
  const sleepH = Number(daily.sleepTotal) || 0;
  const sleepTone = !daily.sleepTotal ? "muted" : sleepH >= SLEEP_TARGET ? "pine" : sleepH >= SLEEP_TARGET - 1 ? "amber" : "clay";

  // today's planned session (from the marathon week plan)
  const wplan = buildWeekPlan(profile);
  const todayP = planText(wplan.rows[wplan.todayIdx], L);

  // Inline editor for the AI coach's custom requirements.
  const [showReq, setShowReq] = useState(false);
  const [req, setReq] = useState(profile?.coachPrompt || "");
  useEffect(() => setReq(profile?.coachPrompt || ""), [profile?.coachPrompt]);
  const saveReq = () => { saveProfile({ ...profile, coachPrompt: req }); setShowReq(false); };

  // 按日 history browser (collapsed by default)
  const [showHist, setShowHist] = useState(false);

  return (
    <>
    <div className="hs-grid">
      {/* readiness hero */}
      <Card span2>
        <div className="hs-ready">
          <div className={"hs-dial tone-" + scoreTone}>
            <span className="hs-dial-n">{score ?? "—"}</span>
            <span className="hs-dial-l">readiness</span>
          </div>
          <div className="hs-ready-side">
            <SectionTitle>{L.statusTitle}</SectionTitle>
            <div className="hs-chips">
              <Chip tone={sleepTone}>{L.sleep} {daily.sleepTotal ? sleepH + "h" : "—"}</Chip>
              <Chip tone={ea.tone}>{ea.label}</Chip>
              {phase && <Chip tone="line">{phase.phase}</Chip>}
              <Chip tone="line">{ateToday ? L.protein : L.yProtein} {ateToday ? todayProtein : proteinYday}/{proteinTarget}g</Chip>
              <Chip tone="line">{ateToday ? L.fibre : L.yFibre} {ateToday ? todayFibre : fibreYday}/{fibreTarget}g</Chip>
              {profile?.eventDate && daysBetween(todayKey(), profile.eventDate) >= 0 && (
                <Chip tone="clay">{profile.eventName || L.race} · {L.daysLeft} {daysBetween(todayKey(), profile.eventDate)} {L.days}</Chip>
              )}
            </div>
            <p className="hs-muted-sm">{ea.msg}{phase ? " · " + phase.note : ""}</p>
            <p className="hs-plan-today"><b>{L.todayPlan}</b> {todayP.name} · {todayP.tgt}</p>
            <button className="hs-btn primary" onClick={getCoaching} disabled={coaching}>
              <Sparkles size={15} />{coaching ? L.coaching : L.getCoach}
            </button>
            <button className="hs-btn-link" onClick={() => setShowReq(s => !s)}>
              {showReq ? L.collapse : (profile?.coachPrompt ? L.myReq : L.setReq)}
            </button>
            {showReq && (
              <div className="hs-req">
                <textarea className="hs-input" rows={3}
                  placeholder={L.reqPlaceholder}
                  value={req} onChange={e => setReq(e.target.value)} />
                <button className="hs-btn" onClick={saveReq}><Check size={14} />{L.saveReq}</button>
              </div>
            )}
          </div>
        </div>

        {coach && (
          <div className="hs-coach">
            {coach.read && <p><b>{L.cRead}</b>{coach.read}</p>}
            {coach.sleep && <p><b>{L.sleep}</b>{coach.sleep}</p>}
            {coach.training && <p><b>{L.cTrain}</b>{coach.training}</p>}
            {coach.fueling && <p><b>{L.cFuel}</b>{coach.fueling}</p>}
            {coach.flag && <p className="flag"><AlertTriangle size={13} /> {coach.flag}</p>}
            {coachChat.map((m, i) => (
              <p key={i} className={m.role === "user" ? "hs-ask-q" : "hs-ask-a"}>
                <b>{m.role === "user" ? L.askYou : L.askCoachLbl}</b>{m.text}
              </p>
            ))}
            {coachAsking && <p className="hs-muted-sm">{L.coaching}</p>}
            <div className="hs-askbox">
              <input className="hs-input" placeholder={L.askPh} value={coachQ}
                onChange={e => setCoachQ(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { askCoach(coachQ); setCoachQ(""); } }} />
              <button className="hs-btn" onClick={() => { askCoach(coachQ); setCoachQ(""); }} disabled={coachAsking}>
                <Sparkles size={14} />{L.askSend}
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* 按日回顾 entry */}
      <Card span2>
        <button className="hs-btn-link" onClick={() => setShowHist(s => !s)}>{showHist ? L.collapse : L.byDay}</button>
      </Card>
    </div>
    {showHist && <History {...{ history, trainings, meals, metrics, tk }} />}
    </>
  );
}

/* ================================================================== */
/*  SLEEP  (record + trends)                                           */
/* ================================================================== */
function SleepPage({ daily, saveDaily, hrvBase, rhrBase, history }) {
  const { L } = useLang();
  const [d, setD] = useState(daily);
  useEffect(() => setD(daily), [daily]);
  const set = (k, v) => setD(p => ({ ...p, [k]: v }));
  const commit = () => saveDaily(d);

  const C = { pine: "#34503F", clay: "#B0542E", amber: "#C29A3B", ink: "#1C1B17", line: "#DED9CC" };
  const RANGES = [[`14${L.days}`, 14], [`30${L.days}`, 30], [`90${L.days}`, 90], [L.all, 99999]];
  const [range, setRange] = useState(14);
  const last = range >= 99999 ? history : history.slice(-range);
  // Guard against corrupt data points (e.g. a bad Apple Health sync writing a raw
  // sensor value): keep only physiologically plausible numbers so one garbage
  // reading can't blow up the whole trend's axis.
  const inRange = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const sleepData = last.map(h => ({ x: fmtShort(h.date), total: inRange(h.sleepTotal, 0, 20) || 0, deep: inRange(h.deep, 0, 20) || 0 }));
  const hrData = last.filter(h => h.hrv || h.rhr).map(h => ({ x: fmtShort(h.date), hrv: inRange(h.hrv, 5, 300), rhr: inRange(h.rhr, 25, 150) }));

  return (
    <div className="hs-grid">
      {/* 睡眠 */}
      <Card>
        <SectionTitle>{L.sleepCard}</SectionTitle>
        <HM label={L.totalSleep} v={d.sleepTotal} onChange={v => set("sleepTotal", v)} />
        <div className="hs-row3">
          <Slider label={L.energy} v={d.energy} onChange={v => set("energy", v)} />
          <Slider label={L.soreness} v={d.soreness} onChange={v => set("soreness", v)} />
          <Slider label={L.mood} v={d.mood} onChange={v => set("mood", v)} />
        </div>
        <div className="hs-stages">
          <HM label="REM" v={d.rem} onChange={v => set("rem", v)} small />
          <HM label="Deep" v={d.deep} onChange={v => set("deep", v)} small />
        </div>
        <button className="hs-btn" onClick={commit}><Check size={15} />{L.saveToday}</button>
      </Card>

      {/* 心率 */}
      <Card>
        <SectionTitle>{L.hrCard} <span className="hs-opt">{L.optional}</span></SectionTitle>
        {(hrvBase || rhrBase) && (
          <p className="hs-muted-sm">{L.baseline} · HRV {Math.round(hrvBase)} · RHR {Math.round(rhrBase)}</p>
        )}
        <div className="hs-row2">
          <Num label="HRV (ms)" v={d.hrv} onChange={v => set("hrv", v)} />
          <Num label="RHR (bpm)" v={d.rhr} onChange={v => set("rhr", v)} />
        </div>
        <button className="hs-btn" onClick={commit}><Check size={15} />{L.save}</button>
      </Card>

      {/* range selector */}
      <Card span2>
        <div className="hs-range-row">
          {RANGES.map(([lab, v]) => (
            <button key={v} className={"hs-range-btn" + (range === v ? " on" : "")} onClick={() => setRange(v)}>{lab}</button>
          ))}
        </div>
      </Card>

      {/* sleep trend */}
      <Card span2>
        <SectionTitle>{L.sleep} · {range >= 99999 ? L.all : L.recentN(range)} {L.sleepTrend}</SectionTitle>
        <ChartWrap>
          <BarChart data={sleepData}>
            <CartesianGrid stroke={C.line} vertical={false} />
            <XAxis dataKey="x" tick={{ fontSize: 11, fill: C.ink }} /><YAxis tick={{ fontSize: 11, fill: C.ink }} />
            <Tooltip /><ReferenceLine y={SLEEP_TARGET} stroke={C.clay} strokeDasharray="4 4" />
            <Bar dataKey="total" fill={C.pine} radius={[3, 3, 0, 0]} />
            <Bar dataKey="deep" fill={C.amber} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartWrap>
      </Card>

      {/* HRV / RHR trend */}
      <Card span2>
        <SectionTitle>{L.hrTrend}</SectionTitle>
        <ChartWrap>
          <LineChart data={hrData}>
            <CartesianGrid stroke={C.line} vertical={false} />
            <XAxis dataKey="x" tick={{ fontSize: 11, fill: C.ink }} /><YAxis tick={{ fontSize: 11, fill: C.ink }} />
            <Tooltip />
            <Line dataKey="hrv" stroke={C.pine} strokeWidth={2} dot={false} connectNulls />
            <Line dataKey="rhr" stroke={C.clay} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ChartWrap>
      </Card>
    </div>
  );
}

/* ================================================================== */
/*  LOG  (training + meal photo)                                        */
/* ================================================================== */
function DietPage({ tk, meals, history, reload, proteinTarget, fibreTarget, profile, saveProfile }) {
  const { L, lang } = useLang();

  /* meal photo */
  const fileRef = useRef();
  const [analyzing, setAnalyzing] = useState(false);
  const [thumb, setThumb] = useState(null);
  const [est, setEst] = useState(null);
  const [fuelled, setFuelled] = useState(false);
  const [manual, setManual] = useState(false);
  const [mForm, setMForm] = useState({ protein: "", fibre: "", cal: "", note: "", fuelled: false });
  const [editMeal, setEditMeal] = useState(null);
  const delEntry = async (prefix, id) => { await store.del(`${prefix}:${id}`); reload(); };

  const onPhoto = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    setAnalyzing(true); setEst(null);
    try {
      // Convert to JPEG in-browser first (handles iPhone HEIC + shrinks payload).
      let dataUrl;
      try { dataUrl = await fileToJpegDataUrl(file); }
      catch { const r = new FileReader(); dataUrl = await new Promise((res, rej) => { r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
      setThumb(dataUrl);
      const b64 = dataUrl.split(",")[1];
      const media_type = (dataUrl.match(/^data:([^;]+);/) || [])[1] || "image/jpeg";
      const text = await callClaude(
        [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type, data: b64 } },
          { type: "text", text: lang === "en"
            ? "Estimate this meal's calories (kcal), protein (g) and fibre (g), plus a short nutrition note (English). Return JSON ONLY, no other text: {\"cal\":number,\"protein\":number,\"fibre\":number,\"note\":\"...\"}. Note: estimates are directional."
            : "估算这餐的热量(kcal)、蛋白质(g)和纤维(g),给一句简短的营养备注(中文)。仅返回 JSON,无其他文字:{\"cal\":数字,\"protein\":数字,\"fibre\":数字,\"note\":\"...\"}。提醒:估算是方向性的。" },
        ] }], lang === "en" ? "You are a nutrition estimator, return JSON only." : "你是营养估算助手,只返回 JSON。", 400);
      const j = parseJSON(text);
      setEst(j || { cal: 0, protein: 0, fibre: 0, note: lang === "en" ? "Couldn't parse (check /api/claude & API key)" : "无法解析(检查 /api/claude 与 API key)" });
    } catch { setEst({ cal: 0, protein: 0, fibre: 0, note: lang === "en" ? "Couldn't reach AI (check network / deploy / API key)" : "无法连接 AI(检查网络/部署/API key)" }); }
    setAnalyzing(false);
  };
  const saveMeal = async () => {
    if (!est) return;
    const id = Date.now();
    await store.set(`meal:${id}`, { id, date: tk, cal: Number(est.cal) || 0, protein: Number(est.protein) || 0, fibre: Number(est.fibre) || 0, note: est.note || "", fuelled });
    setEst(null); setThumb(null); setFuelled(false); reload();
  };
  const saveManual = async () => {
    if (!mForm.protein && !mForm.fibre && !mForm.cal) return;
    const id = Date.now();
    await store.set(`meal:${id}`, { id, date: tk, cal: Number(mForm.cal) || 0, protein: Number(mForm.protein) || 0, fibre: Number(mForm.fibre) || 0, note: mForm.note || (lang === "en" ? "manual" : "手动"), fuelled: mForm.fuelled });
    setMForm({ protein: "", fibre: "", cal: "", note: "", fuelled: false }); setManual(false); reload();
  };
  const startEdit = m => setEditMeal({ id: m.id, date: m.date, cal: m.cal ?? "", protein: m.protein ?? "", fibre: m.fibre ?? "", note: m.note ?? "", fuelled: !!m.fuelled });
  const saveEdit = async () => {
    const e = editMeal;
    await store.set(`meal:${e.id}`, { id: e.id, date: e.date, cal: Number(e.cal) || 0, protein: Number(e.protein) || 0, fibre: Number(e.fibre) || 0, note: e.note || "", fuelled: e.fuelled });
    setEditMeal(null); reload();
  };

  const todayMeals = meals.filter(m => m.date === tk);
  const cSum = todayMeals.reduce((s, m) => s + (Number(m.cal) || 0), 0);
  const pSum = todayMeals.reduce((s, m) => s + (Number(m.protein) || 0), 0);
  const fSum = todayMeals.reduce((s, m) => s + (Number(m.fibre) || 0), 0);

  // diet trend (protein + fibre by day) over the selected range
  const C = { pine: "#34503F", clay: "#B0542E", amber: "#C29A3B", ink: "#1C1B17", line: "#DED9CC" };
  const RANGES = [[`14${L.days}`, 14], [`30${L.days}`, 30], [`90${L.days}`, 90], [L.all, 99999]];
  const [range, setRange] = useState(14);
  const last = range >= 99999 ? history : history.slice(-range);
  const rLabel = range >= 99999 ? L.all : L.recentN(range);
  const days = [...new Set(last.map(h => h.date))];
  const dietData = days.map(dk => ({
    x: fmtShort(dk),
    protein: meals.filter(m => m.date === dk).reduce((s, m) => s + (Number(m.protein) || 0), 0),
    fibre: meals.filter(m => m.date === dk).reduce((s, m) => s + (Number(m.fibre) || 0), 0),
  }));

  return (
    <div className="hs-grid">
      <Card>
        <SectionTitle>{L.food}</SectionTitle>
        <div className="hs-photo">
          {thumb ? <img src={thumb} alt="" className="hs-thumb" /> :
            <div className="hs-photo-empty"><Camera size={22} /><span>{L.snap}</span></div>}
        </div>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onPhoto} style={{ display: "none" }} />
        <div className="hs-row2">
          <button className="hs-btn" onClick={() => fileRef.current?.click()}><Camera size={15} />{L.photo}</button>
          <button className="hs-btn ghost" onClick={() => setManual(m => !m)}><Plus size={15} />{L.manualAdd}</button>
        </div>
        {manual && (
          <div className="hs-est">
            <Num label={L.kcalG} v={mForm.cal} onChange={v => setMForm(f => ({ ...f, cal: v }))} />
            <div className="hs-row2">
              <Num label={L.proteinG} v={mForm.protein} onChange={v => setMForm(f => ({ ...f, protein: v }))} />
              <Num label={L.fibreG} v={mForm.fibre} onChange={v => setMForm(f => ({ ...f, fibre: v }))} />
            </div>
            <label className="hs-flab">{L.noteOpt}</label>
            <input className="hs-input" placeholder={L.egMeal} value={mForm.note} onChange={e => setMForm(f => ({ ...f, note: e.target.value }))} />
            <label className="hs-check"><input type="checkbox" checked={mForm.fuelled} onChange={e => setMForm(f => ({ ...f, fuelled: e.target.checked }))} />{L.fuelled}</label>
            <button className="hs-btn primary" onClick={saveManual}><Check size={15} />{L.saveMeal}</button>
          </div>
        )}
        {analyzing && <p className="hs-muted-sm">{L.analyzing}</p>}
        {est && (
          <div className="hs-est">
            <div className="hs-est-row"><b>{L.kcal}</b><span>~{est.cal ?? 0} kcal</span></div>
            <div className="hs-est-row"><b>{L.protein}</b><span>~{est.protein} g</span></div>
            <div className="hs-est-row"><b>{L.fibre}</b><span>~{est.fibre ?? 0} g</span></div>
            <p className="hs-muted-sm">{est.note}</p>
            <label className="hs-check"><input type="checkbox" checked={fuelled} onChange={e => setFuelled(e.target.checked)} />{L.fuelled}</label>
            <button className="hs-btn primary" onClick={saveMeal}><Check size={15} />{L.saveMeal}</button>
          </div>
        )}
        <div className="hs-caltot">
          <span>{L.todayCal} <b>{cSum}</b> kcal</span>
          <span className="hs-muted-sm">{L.calRef}</span>
        </div>
        <div className="hs-bar">
          <div className="hs-bar-fill" style={{ width: Math.min(100, proteinTarget ? pSum / proteinTarget * 100 : 0) + "%" }} />
          <span className="hs-bar-t">{L.todayProtein} {pSum}/{proteinTarget}g</span>
        </div>
        <div className="hs-bar" style={{ marginTop: 8 }}>
          <div className="hs-bar-fill fibre" style={{ width: Math.min(100, fibreTarget ? fSum / fibreTarget * 100 : 0) + "%" }} />
          <span className="hs-bar-t">{L.todayFibre} {fSum}/{fibreTarget}g</span>
        </div>
        <div className="hs-list">
          {todayMeals.map(m => (
            editMeal && editMeal.id === m.id ? (
              <div key={m.id} className="hs-est">
                <Num label={L.kcalG} v={editMeal.cal} onChange={v => setEditMeal(s => ({ ...s, cal: v }))} />
                <div className="hs-row2">
                  <Num label={L.proteinG} v={editMeal.protein} onChange={v => setEditMeal(s => ({ ...s, protein: v }))} />
                  <Num label={L.fibreG} v={editMeal.fibre} onChange={v => setEditMeal(s => ({ ...s, fibre: v }))} />
                </div>
                <label className="hs-flab">{L.note}</label>
                <input className="hs-input" value={editMeal.note} onChange={e => setEditMeal(s => ({ ...s, note: e.target.value }))} />
                <label className="hs-check"><input type="checkbox" checked={editMeal.fuelled} onChange={e => setEditMeal(s => ({ ...s, fuelled: e.target.checked }))} />{L.fuelled}</label>
                <div className="hs-row2">
                  <button className="hs-btn primary" onClick={saveEdit}><Check size={15} />{L.save}</button>
                  <button className="hs-btn ghost" onClick={() => setEditMeal(null)}>{L.cancel}</button>
                </div>
              </div>
            ) : (
              <div key={m.id} className="hs-li">
                <span>{m.cal ? `${m.cal} kcal · ` : ""}{m.protein}g {L.protein2}{m.fibre ? ` · ${m.fibre}g ${L.fibre2}` : ""}{m.fuelled ? " · " + L.fuelled + "✓" : ""}</span>
                <span className="hs-li-r">{m.note?.slice(0, 14)}
                  <Pencil size={13} onClick={() => startEdit(m)} />
                  <Trash2 size={13} onClick={() => delEntry("meal", m.id)} /></span>
              </div>
            )
          ))}
        </div>
      </Card>

      <SupplementCard {...{ tk, profile, saveProfile }} />
      <GoalsCard {...{ profile, saveProfile }} />

      {/* range selector */}
      <Card span2>
        <div className="hs-range-row">
          {RANGES.map(([lab, v]) => (
            <button key={v} className={"hs-range-btn" + (range === v ? " on" : "")} onClick={() => setRange(v)}>{lab}</button>
          ))}
        </div>
      </Card>

      {/* diet trend */}
      <Card span2>
        <SectionTitle>{L.dietGoal} ({rLabel})</SectionTitle>
        <ChartWrap>
          <LineChart data={dietData}>
            <CartesianGrid stroke={C.line} vertical={false} />
            <XAxis dataKey="x" tick={{ fontSize: 11, fill: C.ink }} /><YAxis tick={{ fontSize: 11, fill: C.ink }} />
            <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine y={proteinTarget} stroke={C.pine} strokeDasharray="4 4" />
            <ReferenceLine y={fibreTarget} stroke={C.clay} strokeDasharray="4 4" />
            <Line dataKey="protein" name={L.protein} stroke={C.pine} strokeWidth={2} dot={false} connectNulls />
            <Line dataKey="fibre" name={L.fibre} stroke={C.clay} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ChartWrap>
        <p className="hs-muted-sm">{L.dashTargets} {proteinTarget}g · {L.fibre} {fibreTarget}g</p>
      </Card>
    </div>
  );
}

/* ================================================================== */
/*  TRAINING  (record + Strava + race + load/aerobic/zone/run trends)  */
/* ================================================================== */
function TrainingPage({ tk, trainings, reload, profile, saveProfile, strava, connectStrava, disconnectStrava, syncStrava }) {
  const { L, lang } = useLang();
  const [type, setType] = useState(TRAIN_TYPES[0].key);
  const [label, setLabel] = useState("");
  const [dur, setDur] = useState("");
  const [rpe, setRpe] = useState(6);

  const addTraining = async () => {
    if (!dur) return;
    const id = Date.now();
    await store.set(`training:${id}`, { id, date: tk, type, label, duration: Number(dur), rpe: Number(rpe) });
    setDur(""); setLabel(""); reload();
  };
  const delEntry = async (prefix, id) => { await store.del(`${prefix}:${id}`); reload(); };
  const recentTrain = trainings.filter(t => { const dd = daysBetween(t.date, tk); return dd >= 0 && dd <= 1; }).slice(0, 2);

  /* ---- trends ---- */
  const C = { pine: "#34503F", clay: "#B0542E", amber: "#C29A3B", ink: "#1C1B17", line: "#DED9CC" };
  const RANGES = [[`14${L.days}`, 14], [`30${L.days}`, 30], [`90${L.days}`, 90], [L.all, 99999]];
  const [view, setView] = useState("chart");
  const [range, setRange] = useState(14);
  const rLabel = range >= 99999 ? L.all : L.recentN(range);

  // training mix this week (minutes by type)
  const wk = trainings.filter(t => daysBetween(t.date, todayKey()) < 7);
  const mix = TRAIN_TYPES.map(t => ({ name: t[lang].split(" ")[0], min: wk.filter(x => x.type === t.key).reduce((s, x) => s + (x.duration || 0), 0) })).filter(x => x.min > 0);

  // Fitness / Fatigue / Form (training-load model, includes strength)
  const lm = computeLoadModel(trainings);
  const lmSeries = range >= 99999 ? lm.series : lm.series.slice(-range);
  const formTone = !lm.today ? "muted" : lm.today.form > 5 ? "pine" : lm.today.form < -5 ? "clay" : "amber";
  const formMsg = !lm.today ? "" : lm.today.form > 5 ? L.formFresh : lm.today.form < -5 ? L.formTired : L.formBalanced;

  // aerobic efficiency + cardio intensity zones + running series (over the selected range)
  const rangeTrainings = range >= 99999 ? trainings : trainings.filter(t => { const dd = daysBetween(t.date, tk); return dd >= 0 && dd < range; });
  const efData = computeAerobicEfficiency(rangeTrainings);
  const zones = computeZones(rangeTrainings);
  const zonePct = z => zones.total ? Math.round(z / zones.total * 100) : 0;
  const ZC = [
    { key: "z1", label: L.z1, color: "#CBB45D" }, // 黄
    { key: "z2", label: L.z2, color: "#5C8060" }, // 绿
    { key: "z3", label: L.z3, color: "#9A968C" }, // 灰
    { key: "z4", label: L.z4, color: "#C97B3C" }, // 橙
    { key: "z5", label: L.z5, color: "#A83D3D" }, // 红
  ];
  const runSeries = computeRunSeries(rangeTrainings);

  const plan = buildWeekPlan(profile);
  const [editPlan, setEditPlan] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [pdays, setPdays] = useState(DEFAULT_PLAN);
  useEffect(() => {
    setPdays((Array.isArray(profile?.planDays) && profile.planDays.length === 7) ? profile.planDays : DEFAULT_PLAN);
  }, [profile?.planDays]);
  const setDay = (i, k, v) => setPdays(arr => arr.map((d, j) => j === i ? { ...d, [k]: v } : d));
  const savePlan = () => { saveProfile({ ...profile, planDays: pdays }); setEditPlan(false); };
  const PLAN_TYPES = [["z2", L.pZ2], ["long", L.pLong], ["quality", L.pQuality], ["strength", L.pStrength], ["pilates", L.pPilates], ["rest", L.pRest]];
  const [loadingCoach, setLoadingCoach] = useState(false);
  const [coachNote, setCoachNote] = useState("");
  useEffect(() => {
    let alive = true;
    fetch("/api/coachplan").then(r => r.json()).then(j => { if (alive && j?.note) setCoachNote(j.note); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const loadCoachPlan = async () => {
    setLoadingCoach(true);
    let plan = DEFAULT_PLAN;
    try {
      const r = await fetch("/api/coachplan");
      const j = await r.json();
      if (Array.isArray(j?.plan) && j.plan.length === 7) plan = j.plan;
      if (j?.note) setCoachNote(j.note);
    } catch { /* fall back to built-in default */ }
    saveProfile({ ...profile, planDays: plan });
    setLoadingCoach(false);
  };
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  const refreshAnalysis = async () => {
    setRefreshing(true); setRefreshMsg("");
    try {
      const r = await fetch("/api/weekly");
      const j = await r.json();
      if (j?.note) setCoachNote(j.note);
      setRefreshMsg(j?.cooled ? L.refreshCooled(j.minutes_left) : (j?.ok ? L.refreshDone : L.refreshFail));
    } catch { setRefreshMsg(L.refreshFail); }
    setRefreshing(false);
  };

  /* ---- ask the coach about THIS plan (text advice only) ---- */
  const [planChat, setPlanChat] = useState([]);
  const [planAsking, setPlanAsking] = useState(false);
  const [planQ, setPlanQ] = useState("");
  async function askPlan(raw) {
    const question = (raw || "").trim();
    if (!question || planAsking) return;
    setPlanAsking(true);
    const prior = planChat;
    setPlanChat(c => [...c, { role: "user", text: question }]);
    try {
      const planStr = plan.rows.map(r => { const t = planText(r, L); return `${L.dow[r.idx]}: ${t.name} · ${t.tgt}`; }).join("\n");
      const recent = (trainings || []).slice(-7).map(t => `${t.date} ${enumLabel(TRAIN_TYPES, t.type, lang)}${t.km ? " " + t.km + "km" : ""}${t.duration ? " " + t.duration + "min" : ""}`).join("\n");
      const cyc = profile?.cycleStart ? `${lang === "en" ? "Cycle start" : "周期起点"} ${profile.cycleStart}` : "";
      const primer = (lang === "en" ? "Current weekly plan:\n" : "当前每周计划:\n") + planStr
        + (recent ? (lang === "en" ? "\n\nRecent training:\n" : "\n\n最近训练:\n") + recent : "")
        + (cyc ? "\n\n" + cyc : "");
      const validTypes = ["z2", "long", "quality", "strength", "pilates", "rest"];
      const sys = lang === "en"
        ? "You are the user's personal running coach (Attia healthspan + Stacy Sims female physiology), training her healthily for a sub-4h marathon on 2026-09-13. Weekly hard rules: >=2 strength (one upper, one lower, on separate days); <=3 runs (one hard = interval OR tempo, one long, one easy); >=1 pilates; <=1 full rest day; long run only on Sat/Sun. She asks about or points out problems in the plan above. Return JSON ONLY, no other text: {\"reply\":\"short spoken advice — say which day you changed and why\",\"plan\":[7 items Mon..Sun] or null}. Only include plan when she wants the schedule changed; otherwise null. Each item is {\"type\":\"z2|long|quality|strength|pilates|rest\",\"note\":\"short note\"}. Change only what she asked, keep the other days as-is, and obey every rule."
        : "你是用户的私人跑步教练(融合 Attia 健康寿命 + Stacy Sims 女性生理),帮她健康备战 2026-09-13 全马(目标进 4 小时)。每周硬规则:至少 2 次力量(一次上半身、一次下半身,分不同天);跑步最多 3 次(一次冲刺=间歇或 Tempo、一次长距离、一次轻松);至少 1 次普拉提;最多 1 天完全休息;长距离只放周六/周日。她会针对上面这份计划提问或指出问题。只返回 JSON,不要其他文字:{\"reply\":\"给她的口语建议,简短具体,说你改了哪天、为什么\",\"plan\":[周一..周日共 7 项] 或 null}。只有当她要调整计划时才给 plan,否则为 null。每项是 {\"type\":\"z2|long|quality|strength|pilates|rest\",\"note\":\"简短中文备注\"}。只改她要改的,其余天保持原样,遵守她所有硬规则。"
        + (profile?.coachPrompt ? "用户额外要求(优先满足,只要安全):" + profile.coachPrompt : "");
      const msgs = [
        { role: "user", content: primer },
        { role: "assistant", content: lang === "en" ? "Got it — what do you want to adjust?" : "好的,你想怎么调?" },
        ...prior.map(m => ({ role: m.role, content: m.text })),
        { role: "user", content: question },
      ];
      const out = await callClaude(msgs, sys, 800);
      const j = parseJSON(out);
      let reply = (j && typeof j.reply === "string" && j.reply) ? j.reply : (out || "…");
      const np = j?.plan;
      if (Array.isArray(np) && np.length === 7 && np.every(d => d && validTypes.includes(d.type))) {
        const clean = np.map(d => ({ type: d.type, note: typeof d.note === "string" ? d.note : "" }));
        saveProfile({ ...profile, planDays: clean });
        reply += " " + L.planUpdated;
      }
      setPlanChat(c => [...c, { role: "assistant", text: reply }]);
    } catch {
      setPlanChat(c => [...c, { role: "assistant", text: lang === "en" ? "Can't reach AI right now." : "暂时连不上 AI(检查网络/API key)。" }]);
    }
    setPlanAsking(false);
  }

  return (
    <>
      <div className="hs-grid">
        <Card span2>
          <SectionTitle>
            {L.planTitle}
            {plan.weeks ? <span className="hs-opt"> · {L.weeksLeft(plan.weeks)}</span> : null}
            {plan.taper ? <span className="hs-opt"> · {L.taperTag}</span> : null}
          </SectionTitle>
          {!profile?.eventDate && <p className="hs-muted-sm">{L.planNeedDate}</p>}
          {coachNote && (
            <>
              <button className="hs-plan-toggle" onClick={() => setBriefOpen(o => !o)}>
                {briefOpen ? L.briefHide : L.briefShow}
              </button>
              {briefOpen && <p className="hs-brief">{coachNote}</p>}
            </>
          )}
          {editPlan ? (
            <>
              {pdays.map((d, i) => (
                <div key={i} className="hs-planedit">
                  <span className="hs-pday">{L.dow[i]}</span>
                  <select className="hs-input" value={d.type} onChange={e => setDay(i, "type", e.target.value)}>
                    {PLAN_TYPES.map(([v, lab]) => <option key={v} value={v}>{lab}</option>)}
                  </select>
                  <input className="hs-input" placeholder={L.planNotePh} value={d.note || ""} onChange={e => setDay(i, "note", e.target.value)} />
                </div>
              ))}
              <button className="hs-btn primary" onClick={savePlan}><Check size={15} />{L.planDone}</button>
            </>
          ) : (
            <>
              <div className="hs-plan">
                {plan.rows.map(r => {
                  const t = planText(r, L);
                  return (
                    <div key={r.idx} className={"hs-planrow" + (r.isToday ? " today" : "")}>
                      <span className="hs-pday">{L.dow[r.idx]}</span>
                      <span className={"hs-pdot t-" + planTone(r.type)} />
                      <span className="hs-pname">{t.name}</span>
                      <span className="hs-ptar">{t.tgt}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ maxWidth: 190, marginTop: 10 }}>
                <Num label={L.planPeak} v={profile?.planPeakKm ?? 30} onChange={v => saveProfile({ ...profile, planPeakKm: v })} />
              </div>
              <p className="hs-muted-sm">{L.planAutoNote}</p>
              <button className="hs-btn primary" onClick={refreshAnalysis} disabled={refreshing}><Sparkles size={14} />{refreshing ? L.refreshingWk : L.refreshAnalysis}</button>
              {refreshMsg && <p className="hs-muted-sm">{refreshMsg}</p>}
              <div className="hs-row2">
                <button className="hs-btn" onClick={loadCoachPlan} disabled={loadingCoach}><RotateCcw size={14} />{loadingCoach ? L.coaching : L.loadCoach}</button>
                <button className="hs-btn ghost" onClick={() => setEditPlan(true)}><Pencil size={13} />{L.editPlan}</button>
              </div>
              {planChat.map((m, i) => (
                <p key={i} className={m.role === "user" ? "hs-ask-q" : "hs-ask-a"}>
                  <b>{m.role === "user" ? L.askYou : L.askCoachLbl}</b>{m.text}
                </p>
              ))}
              {planChat.length > 0 && !planAsking && (
                <button className="hs-plan-toggle" onClick={() => setPlanChat([])}>{L.clearChat}</button>
              )}
              {planAsking && <p className="hs-muted-sm">{L.coaching}</p>}
              <div className="hs-askbox">
                <input className="hs-input" placeholder={L.planAskPh} value={planQ}
                  onChange={e => setPlanQ(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { askPlan(planQ); setPlanQ(""); } }} />
                <button className="hs-btn" onClick={() => { askPlan(planQ); setPlanQ(""); }} disabled={planAsking}>
                  <Sparkles size={14} />{L.askSend}
                </button>
              </div>
            </>
          )}
        </Card>

        <Card>
          <SectionTitle>{L.training}</SectionTitle>
          <label className="hs-flab">{L.type}</label>
          <select className="hs-input" value={type} onChange={e => setType(e.target.value)}>
            {TRAIN_TYPES.map(t => <option key={t.key} value={t.key}>{t[lang]}</option>)}
          </select>
          {type === "Other activity" &&
            <input className="hs-input" placeholder={L.otherName} value={label} onChange={e => setLabel(e.target.value)} />}
          <div className="hs-row2">
            <Num label={L.duration} v={dur} onChange={setDur} />
            <Slider label="RPE (1-10)" v={rpe} onChange={setRpe} max={10} />
          </div>
          <button className="hs-btn" onClick={addTraining}><Plus size={15} />{L.addTraining}</button>
          <div className="hs-list">
            {recentTrain.length === 0 && <p className="hs-muted-sm">{L.noTrain7}</p>}
            {recentTrain.map(t => (
              <div key={t.id} className="hs-li">
                <span>{t.date !== tk ? fmtShort(t.date) + " · " : ""}{enumLabel(TRAIN_TYPES, t.type, lang)}{t.label ? ` · ${t.label}` : ""}</span>
                <span className="hs-li-r">{t.duration}min{t.rpe ? ` · RPE${t.rpe}` : ""}{t.km ? ` · ${t.km}km` : ""}
                  <Trash2 size={13} onClick={() => delEntry("training", t.id)} /></span>
              </div>
            ))}
          </div>
        </Card>

        <StravaCard {...{ strava, connectStrava, disconnectStrava, syncStrava }} />
        <RaceCard {...{ profile, saveProfile }} />
      </div>

      {/* trends: chart / run toggle */}
      <div className="hs-range-row" style={{ marginTop: 14, marginBottom: 14 }}>
        <button className={"hs-range-btn" + (view === "chart" ? " on" : "")} onClick={() => setView("chart")}>{L.chart}</button>
        <button className={"hs-range-btn" + (view === "run" ? " on" : "")} onClick={() => setView("run")}>{L.runView}</button>
      </div>

      {view === "run" ? (
        <div className="hs-grid">
          <Card span2>
            <div className="hs-range-row">
              {RANGES.map(([lab, v]) => (
                <button key={v} className={"hs-range-btn" + (range === v ? " on" : "")} onClick={() => setRange(v)}>{lab}</button>
              ))}
            </div>
          </Card>
          {runSeries.length ? (
            <>
              <Card span2>
                <SectionTitle>{L.paceTitle} ({rLabel})</SectionTitle>
                <ChartWrap>
                  <LineChart data={runSeries}>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="x" tick={{ fontSize: 11, fill: C.ink }} /><YAxis domain={["auto", "auto"]} reversed tick={{ fontSize: 11, fill: C.ink }} />
                    <Tooltip />
                    <Line dataKey="pace" name={L.paceTitle} stroke={C.pine} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  </LineChart>
                </ChartWrap>
                <p className="hs-muted-sm">{L.paceNote}</p>
              </Card>
              <Card span2>
                <SectionTitle>{L.runHrTitle} ({rLabel})</SectionTitle>
                <ChartWrap>
                  <LineChart data={runSeries}>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="x" tick={{ fontSize: 11, fill: C.ink }} /><YAxis domain={["auto", "auto"]} tick={{ fontSize: 11, fill: C.ink }} />
                    <Tooltip />
                    <Line dataKey="hr" name={L.runHrTitle} stroke={C.clay} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  </LineChart>
                </ChartWrap>
              </Card>
              <Card span2>
                <SectionTitle>{L.efTitle} ({rLabel})</SectionTitle>
                <ChartWrap>
                  <LineChart data={runSeries}>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="x" tick={{ fontSize: 11, fill: C.ink }} /><YAxis domain={["auto", "auto"]} tick={{ fontSize: 11, fill: C.ink }} />
                    <Tooltip />
                    <Line dataKey="ef" name={L.efTitle} stroke="#6b8f7a" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  </LineChart>
                </ChartWrap>
                <p className="hs-muted-sm">{L.efNote}</p>
              </Card>
              <Card span2>
                <SectionTitle>{L.distTitle} ({rLabel})</SectionTitle>
                <ChartWrap>
                  <BarChart data={runSeries}>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="x" tick={{ fontSize: 11, fill: C.ink }} /><YAxis tick={{ fontSize: 11, fill: C.ink }} />
                    <Tooltip />
                    <Bar dataKey="km" fill={C.amber} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ChartWrap>
              </Card>
            </>
          ) : <Card span2><p className="hs-muted-sm">{L.noRuns}</p></Card>}
        </div>
      ) : (
        <div className="hs-grid">
          <Card span2>
            <div className="hs-range-row">
              {RANGES.map(([lab, v]) => (
                <button key={v} className={"hs-range-btn" + (range === v ? " on" : "")} onClick={() => setRange(v)}>{lab}</button>
              ))}
            </div>
          </Card>
          <Card span2>
            <SectionTitle>{L.loadTitle}</SectionTitle>
            {lm.today ? (
              <>
                <div className="hs-chips">
                  <Chip tone="clay">{L.mFitness} {lm.today.fitness}</Chip>
                  <Chip tone="line">{L.mFatigue} {lm.today.fatigue}</Chip>
                  <Chip tone={formTone}>{L.mForm} {lm.today.form > 0 ? "+" : ""}{lm.today.form}</Chip>
                </div>
                <p className="hs-muted-sm">{formMsg}</p>
                <ChartWrap>
                  <LineChart data={lmSeries}>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="x" tick={{ fontSize: 11, fill: C.ink }} /><YAxis tick={{ fontSize: 11, fill: C.ink }} />
                    <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
                    <ReferenceLine y={0} stroke={C.line} />
                    <Line dataKey="fitness" name={L.mFitness} stroke={C.clay} strokeWidth={2} dot={false} />
                    <Line dataKey="fatigue" name={L.mFatigue} stroke="#9a968c" strokeWidth={2} dot={false} />
                    <Line dataKey="form" name={L.mForm} stroke={C.pine} strokeWidth={2} dot={false} />
                  </LineChart>
                </ChartWrap>
              </>
            ) : <p className="hs-muted-sm">{L.loadNote}</p>}
          </Card>
          <Card span2>
            <SectionTitle>{L.efTitle} ({rLabel})</SectionTitle>
            {efData.length ? (
              <>
                <ChartWrap>
                  <LineChart data={efData}>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="x" tick={{ fontSize: 11, fill: C.ink }} /><YAxis domain={["auto", "auto"]} tick={{ fontSize: 11, fill: C.ink }} />
                    <Tooltip />
                    <Line dataKey="ef" name={L.efTitle} stroke={C.pine} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  </LineChart>
                </ChartWrap>
                <p className="hs-muted-sm">{L.efNote}</p>
              </>
            ) : <p className="hs-muted-sm">{L.efNote}</p>}
          </Card>
          <Card span2>
            <SectionTitle>{L.zoneTitle} ({rLabel})</SectionTitle>
            {zones.total ? (
              <>
                <div className="hs-zonebar">
                  {ZC.map(z => <span key={z.key} style={{ width: zonePct(zones[z.key]) + "%", background: z.color }} />)}
                </div>
                <div className="hs-zlegend">
                  {ZC.map(z => (
                    <span key={z.key} className="hs-zleg"><i style={{ background: z.color }} />{z.label} {zonePct(zones[z.key])}%</span>
                  ))}
                </div>
                <p className="hs-muted-sm">{L.zoneNote}</p>
              </>
            ) : <p className="hs-muted-sm">{L.zoneNote}</p>}
          </Card>
          <Card span2>
            <SectionTitle>{L.weekMix}</SectionTitle>
            <ChartWrap>
              <BarChart data={mix} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 11, fill: C.ink }} />
                <YAxis type="category" dataKey="name" width={64} tick={{ fontSize: 11, fill: C.ink }} />
                <Tooltip /><Bar dataKey="min" radius={[0, 3, 3, 0]}>
                  {mix.map((_, i) => <Cell key={i} fill={[C.pine, C.amber, C.clay, C.ink, "#7A8C7E"][i % 5]} />)}
                </Bar>
              </BarChart>
            </ChartWrap>
          </Card>
        </div>
      )}
    </>
  );
}

/* ================================================================== */
/*  RACE / GOALS / STRAVA cards                                        */
/* ================================================================== */
function RaceCard({ profile, saveProfile }) {
  const { L } = useLang();
  const [p, setP] = useState({ eventName: profile?.eventName || "", eventDate: profile?.eventDate || "" });
  useEffect(() => setP({ eventName: profile?.eventName || "", eventDate: profile?.eventDate || "" }), [profile?.eventName, profile?.eventDate]);
  const left = p.eventDate ? daysBetween(todayKey(), p.eventDate) : null;
  const save = () => saveProfile({ ...profile, eventName: p.eventName, eventDate: p.eventDate });
  return (
    <Card>
      <SectionTitle>{L.raceTitle} {left != null && left >= 0 && <span className="hs-opt">{L.daysLeft} {left} {L.days}</span>}</SectionTitle>
      <label className="hs-flab">{L.raceName}</label>
      <input className="hs-input" placeholder={L.raceNamePh} value={p.eventName} onChange={e => setP(s => ({ ...s, eventName: e.target.value }))} />
      <label className="hs-flab">{L.raceDate}</label>
      <input className="hs-input" type="date" value={p.eventDate} onChange={e => setP(s => ({ ...s, eventDate: e.target.value }))} />
      {left != null && (
        <p className="hs-muted-sm">{left >= 0 ? `${L.raceUntil1}${p.eventName || L.race}${L.raceUntil2}${left}${L.raceUntil3}` : `${L.racePast} ${-left} ${L.days}`}</p>
      )}
      <button className="hs-btn primary" onClick={save}><Check size={15} />{L.save}</button>
    </Card>
  );
}

function GoalsCard({ profile, saveProfile }) {
  const { L } = useLang();
  const [p, setP] = useState(profile);
  useEffect(() => setP(profile), [profile]);
  const set = (k, v) => setP(prev => ({ ...prev, [k]: v }));
  const target = Math.round((Number(p?.weight) || 0) * (Number(p?.proteinPerKg) || 0));
  return (
    <Card>
      <SectionTitle>{L.goals}</SectionTitle>
      <div className="hs-row2">
        <Num label={L.weight} v={p?.weight} onChange={v => set("weight", v)} step="0.1" />
        <Num label={L.proteinPerKg} v={p?.proteinPerKg} onChange={v => set("proteinPerKg", v)} step="0.1" />
      </div>
      <Num label={L.fibreTarget} v={p?.fibreTarget ?? 35} onChange={v => set("fibreTarget", v)} />
      <div className="hs-row2">
        <Num label={L.hrvBaseL} v={p?.hrvBase} onChange={v => set("hrvBase", v)} />
        <Num label={L.rhrBaseL} v={p?.rhrBase} onChange={v => set("rhrBase", v)} />
      </div>
      <p className="hs-muted-sm">{L.baselineNote}</p>
      <p className="hs-muted-sm">{L.proteinTargetTxt} <b>{target} {L.perDay}</b></p>
      <button className="hs-btn primary" onClick={() => saveProfile(p)}><Check size={15} />{L.saveGoals}</button>
    </Card>
  );
}

function StravaCard({ strava, connectStrava, disconnectStrava, syncStrava }) {
  const { L } = useLang();
  return (
    <Card>
      <SectionTitle>Strava</SectionTitle>
      {!strava?.connected ? (
        <>
          <p className="hs-muted-sm">{L.stravaConnect}</p>
          <button className="hs-btn primary" onClick={connectStrava} disabled={strava?.syncing}>
            <HeartPulse size={15} />{strava?.syncing ? L.stravaConnecting : L.stravaConnectBtn}
          </button>
        </>
      ) : (
        <>
          <p className="hs-muted-sm">
            {L.stravaConnected}{strava.name ? "：" + strava.name : ""}
            {strava.last ? L.stravaLastSync + new Date(strava.last * 1000).toLocaleString() : ""}
          </p>
          <button className="hs-btn primary" onClick={syncStrava} disabled={strava.syncing}>
            <RotateCcw size={15} />{strava.syncing ? L.stravaSyncing : L.stravaSyncBtn}
          </button>
          <button className="hs-btn ghost" style={{ marginTop: 10 }} onClick={disconnectStrava}>{L.stravaDisconnect}</button>
        </>
      )}
      {strava?.msg && <p className="hs-muted-sm">{strava.msg}</p>}
    </Card>
  );
}

/* ================================================================== */
/*  SUPPLEMENTS (daily checklist on the Log page)                      */
/* ================================================================== */
function SupplementCard({ tk, profile, saveProfile }) {
  const { L, lang } = useLang();
  const list = (profile?.supplements && profile.supplements.length) ? profile.supplements : DEFAULT_SUPP_KEYS;
  const [taken, setTaken] = useState({});
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState([]);
  const [newName, setNewName] = useState("");
  useEffect(() => { (async () => setTaken((await store.get(`supp:${tk}`)) || {}))(); }, [tk]);

  const toggle = async name => {
    const next = { ...taken, [name]: !taken[name] };
    setTaken(next); await store.set(`supp:${tk}`, next);
  };
  const startEdit = () => { setDraft(list.map(s => enumLabel(SUPP_PRESETS, s, lang))); setEdit(true); };
  const setItem = (i, v) => setDraft(a => a.map((s, j) => (j === i ? v : s)));
  const removeItem = i => setDraft(a => a.filter((_, j) => j !== i));
  const addItem = name => {
    const n = (name || "").trim(); if (!n || draft.includes(n)) { setNewName(""); return; }
    setDraft(a => [...a, n]); setNewName("");
  };
  const saveEdit = () => {
    const seen = new Set(); const uniq = [];
    for (const s of draft.map(x => x.trim()).filter(Boolean)) { if (!seen.has(s)) { seen.add(s); uniq.push(s); } }
    saveProfile({ ...profile, supplements: uniq }); setEdit(false);
  };
  const done = list.filter(s => taken[s]).length;
  const suggestible = SUGGESTED_SUPP_KEYS.filter(s => !draft.includes(enumLabel(SUPP_PRESETS, s, lang)) && !draft.includes(s));

  return (
    <Card>
      <SectionTitle>{L.supps} <span className="hs-opt">{done}/{list.length}</span></SectionTitle>
      {edit ? (
        <>
          {draft.map((s, i) => (
            <div key={i} className="hs-supp-edit">
              <input className="hs-input" value={s} onChange={e => setItem(i, e.target.value)} />
              <Trash2 size={15} onClick={() => removeItem(i)} />
            </div>
          ))}
          {suggestible.length > 0 && (
            <div className="hs-supp-sugg">
              {suggestible.map(s => (
                <button key={s} className="hs-chip-add"
                  onClick={() => addItem(enumLabel(SUPP_PRESETS, s, lang))}>＋ {enumLabel(SUPP_PRESETS, s, lang)}</button>
              ))}
            </div>
          )}
          <div className="hs-row2" style={{ marginTop: 8 }}>
            <input className="hs-input" placeholder={L.otherFill} value={newName}
              onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && addItem(newName)} />
            <button className="hs-btn" onClick={() => addItem(newName)}><Plus size={15} />{L.add}</button>
          </div>
          <button className="hs-btn-link" onClick={saveEdit}>{L.done}</button>
        </>
      ) : (
        <>
          <div className="hs-supps">
            {list.map(s => (
              <label key={s} className={"hs-supp" + (taken[s] ? " on" : "")}>
                <input type="checkbox" checked={!!taken[s]} onChange={() => toggle(s)} />
                <span>{enumLabel(SUPP_PRESETS, s, lang)}</span>
              </label>
            ))}
          </div>
          <button className="hs-btn-link" onClick={startEdit}>{L.editList}</button>
        </>
      )}
    </Card>
  );
}


/* ================================================================== */
/*  BODY (periodic metrics)                                             */
/* ================================================================== */
function Body({ metrics, reload, profile, saveProfile }) {
  const { L, lang } = useLang();
  const [type, setType] = useState(METRIC_TYPES[0].key);
  const [val, setVal] = useState("");
  const add = async () => {
    if (!val) return;
    const id = Date.now();
    await store.set(`metric:${id}`, { id, date: todayKey(), type, value: Number(val) || val });
    setVal(""); reload();
  };
  const del = async id => { await store.del(`metric:${id}`); reload(); };

  /* ---- menstrual cycle log ---- */
  const [periods, setPeriods] = useState([]);
  const [pdate, setPdate] = useState(todayKey());
  const loadPeriods = useCallback(async () => {
    const ks = await store.list("period:");
    const ps = (await Promise.all(ks.map(k => store.get(k)))).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
    setPeriods(ps);
  }, []);
  useEffect(() => { loadPeriods(); }, [loadPeriods]);

  const logPeriod = async () => {
    if (!pdate) return;
    const id = Date.now();
    await store.set(`period:${id}`, { id, date: pdate });
    const latest = [...periods.map(p => p.date), pdate].sort().pop();
    if (saveProfile && profile) await saveProfile({ ...profile, cycleStart: latest }); // keep home-page phase anchored to latest period
    loadPeriods(); reload();
  };
  const delPeriod = async id => { await store.del(`period:${id}`); loadPeriods(); };

  const lengths = [];
  for (let i = 1; i < periods.length; i++) lengths.push(daysBetween(periods[i - 1].date, periods[i].date));
  const recentLengths = lengths.slice(-4);
  const lastDate = periods.length ? periods[periods.length - 1].date : null;
  const sinceLast = lastDate ? daysBetween(lastDate, todayKey()) : null;

  let reg = null;
  if (recentLengths.length >= 2) {
    const spread = Math.max(...recentLengths) - Math.min(...recentLengths);
    const inRange = recentLengths.every(l => l >= 21 && l <= 35);
    reg = (inRange && spread <= 7)
      ? { tone: "pine", text: lang === "en"
          ? `Regular · recent cycles ${recentLengths.join(" / ")} d — a regular cycle is a good sign of adequate energy & tolerable load.`
          : `规律 · 近几个周期 ${recentLengths.join(" / ")} 天 — 规律的周期是能量充足、训练负荷可承受的好信号。` }
      : { tone: "amber", text: lang === "en"
          ? `Cycle varies a lot (${recentLengths.join(" / ")} d). Could relate to under-eating, stress or training load — worth watching if it persists.`
          : `周期波动较大(${recentLengths.join(" / ")} 天)。可能与能量摄入不足、压力或训练负荷有关,持续的话值得留意。` };
  }
  if (sinceLast != null && sinceLast > 40)
    reg = { tone: "clay", text: lang === "en"
      ? `${sinceLast} days since last period — on the long side. Persistently long or missing cycles can signal low energy availability (RED-S) — check you're eating enough, and see a professional if it continues.`
      : `距上次月经已 ${sinceLast} 天,偏长。长期周期变长或缺失可能是低能量可用性(RED-S)的信号 — 先确认是否吃够,必要时咨询专业人士。` };

  return (
    <div className="hs-grid">
      <Card span2>
        <SectionTitle>{L.periodicMetrics}</SectionTitle>
        <div className="hs-row3">
          <select className="hs-input" value={type} onChange={e => setType(e.target.value)}>
            {METRIC_TYPES.map(t => <option key={t.key} value={t.key}>{t[lang]}</option>)}
          </select>
          <Num label="" v={val} onChange={setVal} />
          <button className="hs-btn" onClick={add}><Plus size={15} />{L.record}</button>
        </div>
        <p className="hs-muted-sm">{L.metricsNote}</p>
        <div className="hs-list">
          {metrics.length === 0 && <p className="hs-muted-sm">{L.noMetrics}</p>}
          {metrics.map(m => (
            <div key={m.id} className="hs-li">
              <span>{enumLabel(METRIC_TYPES, m.type, lang)}</span>
              <span className="hs-li-r">{m.value} <span className="hs-muted-sm">{m.date}</span><Trash2 size={13} onClick={() => del(m.id)} /></span>
            </div>
          ))}
        </div>
      </Card>

      <Card span2>
        <SectionTitle>{L.cycleTitle}</SectionTitle>
        <div className="hs-row3">
          <div><label className="hs-flab">{L.periodStart}</label>
            <input className="hs-input" type="date" value={pdate} onChange={e => setPdate(e.target.value)} /></div>
          <div style={{ alignSelf: "end" }}><button className="hs-btn" onClick={logPeriod}><Plus size={15} />{L.logPeriod}</button></div>
          <div style={{ alignSelf: "end" }} className="hs-muted-sm">
            {sinceLast != null ? `${L.sinceLast1} ${sinceLast} ${L.days}` : L.sinceLastNone}
          </div>
        </div>
        <div style={{ maxWidth: 180, marginTop: 8 }}>
          <Num label={L.cycleLen} v={profile?.cycleLen ?? 28} onChange={v => saveProfile({ ...profile, cycleLen: v })} />
        </div>
        {reg && <div style={{ marginTop: 10 }}><Chip tone={reg.tone}>{reg.tone === "pine" ? L.regular : reg.tone === "amber" ? L.fluctuate : L.watch}</Chip>
          <p className="hs-muted-sm">{reg.text}</p></div>}
        {!reg && periods.length < 2 && <p className="hs-muted-sm">{L.needTwoPeriods}</p>}
        <div className="hs-list">
          {[...periods].reverse().map((p, i, arr) => {
            const next = arr[i + 1];
            const len = next ? daysBetween(next.date, p.date) : null;
            return (
              <div key={p.id} className="hs-li">
                <span>{p.date}</span>
                <span className="hs-li-r">{len ? `${L.cycleEvery} ${len} ${L.days}` : L.cycleLast}<Trash2 size={13} onClick={() => delPeriod(p.id)} /></span>
              </div>
            );
          })}
        </div>
      </Card>

      <BackupCard reload={reload} />
    </div>
  );
}

/* ================================================================== */
/*  BACKUP (export / import all local data)                            */
/* ================================================================== */
function BackupCard({ reload }) {
  const { L } = useLang();
  const fileRef = useRef();
  const exportData = () => {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("hs:")) data[k] = localStorage.getItem(k);
    }
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `health-backup-${todayKey()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  const importData = e => {
    const file = e.target.files?.[0]; if (!file) { return; }
    const r = new FileReader();
    r.onload = () => {
      let data;
      try { data = JSON.parse(r.result); } catch { alert(L.importBad); return; }
      if (!data || typeof data !== "object") { alert(L.importBad); return; }
      if (!confirm(L.importConfirm)) return;
      for (const [k, v] of Object.entries(data)) {
        if (typeof k === "string" && k.startsWith("hs:") && typeof v === "string") localStorage.setItem(k, v);
      }
      reload(); alert(L.importDone);
    };
    r.readAsText(file);
    e.target.value = "";
  };
  return (
    <Card span2>
      <SectionTitle>{L.backupTitle}</SectionTitle>
      <p className="hs-muted-sm">{L.backupNote}</p>
      <div className="hs-row2">
        <button className="hs-btn" onClick={exportData}><Upload size={15} />{L.exportBtn}</button>
        <button className="hs-btn ghost" onClick={() => fileRef.current?.click()}><Plus size={15} />{L.importBtn}</button>
      </div>
      <input ref={fileRef} type="file" accept="application/json,.json" onChange={importData} style={{ display: "none" }} />
    </Card>
  );
}

/* ================================================================== */
/*  HISTORY (browse any past day)                                       */
/* ================================================================== */
function History({ history, trainings, meals, metrics, tk }) {
  const { L, lang } = useLang();
  const [date, setDate] = useState(tk);
  const day = history.find(h => h.date === date) || {};
  const dayTrain = trainings.filter(t => t.date === date);
  const dayMeals = meals.filter(m => m.date === date);
  const dayMetrics = metrics.filter(m => m.date === date);
  const pSum = dayMeals.reduce((s, m) => s + (Number(m.protein) || 0), 0);
  const fSum = dayMeals.reduce((s, m) => s + (Number(m.fibre) || 0), 0);
  const allDates = [...new Set([
    ...history.map(h => h.date), ...trainings.map(t => t.date),
    ...meals.map(m => m.date), ...metrics.map(m => m.date),
  ])].filter(Boolean).sort((a, b) => b.localeCompare(a));
  const dayKeys = Object.keys(day).filter(k => k !== "date");
  const hasAny = dayKeys.length || dayTrain.length || dayMeals.length || dayMetrics.length;

  return (
    <div className="hs-grid">
      <Card span2>
        <SectionTitle>{L.byDay}</SectionTitle>
        <div className="hs-row2">
          <div><label className="hs-flab">{L.pickDate}</label>
            <input className="hs-input" type="date" value={date} max={tk} onChange={e => setDate(e.target.value)} /></div>
          <div><label className="hs-flab">{L.jumpDate}</label>
            <select className="hs-input" value={allDates.includes(date) ? date : ""} onChange={e => e.target.value && setDate(e.target.value)}>
              <option value="">{L.pick}</option>
              {allDates.map(d => <option key={d} value={d}>{d}</option>)}
            </select></div>
        </div>
        {!hasAny && <p className="hs-muted-sm">{L.noDayData}</p>}
      </Card>

      {dayKeys.length > 0 && (
        <Card>
          <SectionTitle>{L.dayStatus}</SectionTitle>
          <div className="hs-list">
            {day.sleepTotal != null && <Row k={L.totalSleep} v={`${day.sleepTotal} h`} />}
            {day.rem != null && <Row k="REM" v={`${day.rem} h`} />}
            {day.deep != null && <Row k="Deep" v={`${day.deep} h`} />}
            {day.hrv != null && <Row k="HRV" v={`${day.hrv} ms`} />}
            {day.rhr != null && <Row k="RHR" v={`${day.rhr} bpm`} />}
            {day.energy != null && <Row k={L.energy} v={day.energy} />}
            {day.mood != null && <Row k={L.mood} v={day.mood} />}
            {day.soreness != null && <Row k={L.soreness} v={day.soreness} />}
          </div>
        </Card>
      )}

      <Card>
        <SectionTitle>{L.training}</SectionTitle>
        {dayTrain.length === 0 ? <p className="hs-muted-sm">{L.none}</p> :
          <div className="hs-list">{dayTrain.map(t => (
            <div key={t.id} className="hs-li"><span>{enumLabel(TRAIN_TYPES, t.type, lang)}{t.label ? ` · ${t.label}` : ""}</span>
              <span className="hs-li-r">{t.duration}min{t.rpe ? ` · RPE${t.rpe}` : ""}</span></div>
          ))}</div>}
      </Card>

      <Card span2>
        <SectionTitle>{L.food} {dayMeals.length ? `· ${L.protein2} ${pSum}g · ${L.fibre2} ${fSum}g` : ""}</SectionTitle>
        {dayMeals.length === 0 ? <p className="hs-muted-sm">{L.none}</p> :
          <div className="hs-list">{dayMeals.map(m => (
            <div key={m.id} className="hs-li"><span>{m.protein}g {L.protein2}{m.fibre ? ` · ${m.fibre}g ${L.fibre2}` : ""}{m.fuelled ? " · " + L.fuelled + "✓" : ""}</span>
              <span className="hs-li-r">{m.note?.slice(0, 18)}</span></div>
          ))}</div>}
      </Card>

      {dayMetrics.length > 0 && (
        <Card span2>
          <SectionTitle>{L.bodyMetrics}</SectionTitle>
          <div className="hs-list">{dayMetrics.map(m => (
            <div key={m.id} className="hs-li"><span>{enumLabel(METRIC_TYPES, m.type, lang)}</span><span className="hs-li-r">{m.value}</span></div>
          ))}</div>
        </Card>
      )}
    </div>
  );
}

/* ================================================================== */
/*  small components                                                    */
/* ================================================================== */
const Card = ({ children, span2 }) => <section className={"hs-card" + (span2 ? " span2" : "")}>{children}</section>;
const Row = ({ k, v }) => <div className="hs-li"><span>{k}</span><span className="hs-li-r">{v}</span></div>;
const SectionTitle = ({ children }) => <h3 className="hs-sec">{children}</h3>;
const Chip = ({ children, tone }) => <span className={"hs-chip tone-" + tone}>{children}</span>;
const ChartWrap = ({ children }) => <div className="hs-chart"><ResponsiveContainer width="100%" height={180}>{children}</ResponsiveContainer></div>;

function Num({ label, v, onChange, step, small }) {
  return (
    <div className={"hs-field" + (small ? " small" : "")}>
      {label && <label className="hs-flab">{label}</label>}
      <input className="hs-input" type="number" step={step || "1"} value={v ?? ""} onChange={e => onChange(e.target.value)} inputMode="decimal" />
    </div>
  );
}
function Slider({ label, v, onChange, max = 5 }) {
  return (
    <div className="hs-field">
      <label className="hs-flab">{label} <span className="hs-sv">{v ?? "-"}</span></label>
      <input className="hs-range" type="range" min="1" max={max} value={v || Math.ceil(max / 2)} onChange={e => onChange(Number(e.target.value))} />
    </div>
  );
}
function HM({ label, v, onChange, small }) {
  const empty = v === "" || v == null;
  const total = Number(v) || 0;
  const h = Math.floor(total);
  const m = Math.round((total - h) * 60);
  const setHM = (nh, nm) => {
    const hh = Math.max(0, Number(nh) || 0);
    const mm = Math.max(0, Math.min(59, Number(nm) || 0));
    const dec = hh + mm / 60;
    onChange(dec === 0 ? "" : Number(dec.toFixed(4)));
  };
  return (
    <div className={"hs-field" + (small ? " small" : "")}>
      {label && <label className="hs-flab">{label}</label>}
      <div className="hs-hm">
        <input className="hs-input" type="number" min="0" placeholder="0" value={empty ? "" : h}
          onChange={e => setHM(e.target.value, m)} inputMode="numeric" />
        <span className="hs-hm-u">h</span>
        <input className="hs-input" type="number" min="0" max="59" placeholder="0" value={empty ? "" : m}
          onChange={e => setHM(h, e.target.value)} inputMode="numeric" />
        <span className="hs-hm-u">min</span>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  styles                                                              */
/* ================================================================== */
function Style() {
  return <style>{`
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
.hs-root{
  --paper:#F4F1E8; --card:#FBFAF4; --ink:#1C1B17; --soft:#6B665B; --line:#E2DCCD;
  --pine:#34503F; --clay:#B0542E; --amber:#B58A2E;
  font-family:'Hanken Grotesk',sans-serif; background:var(--paper); color:var(--ink);
  min-height:100%; padding:22px; box-sizing:border-box;
  background-image:radial-gradient(var(--line) 0.5px, transparent 0.5px); background-size:22px 22px;
}
.hs-load{padding:60px;text-align:center;color:var(--soft)}
.hs-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:18px}
.hs-kicker{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--soft)}
.hs-title{font-family:'Fraunces',serif;font-weight:500;font-size:29px;margin:2px 0 0;letter-spacing:-.01em}
.hs-phase{text-align:right;line-height:1.1}
.hs-phase-day{font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--pine);display:block}
.hs-phase-name{font-size:13px;color:var(--soft)}
.hs-nav{display:flex;gap:4px;background:var(--card);border:1px solid var(--line);border-radius:13px;padding:4px;margin-bottom:18px;flex-wrap:wrap}
.hs-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;color:var(--soft);
  font-family:inherit;font-size:14px;font-weight:500;padding:9px 8px;border-radius:9px;cursor:pointer;transition:.15s;min-width:64px}
.hs-tab:hover{color:var(--ink)}
.hs-tab.on{background:var(--ink);color:var(--paper)}
.hs-main{}
.hs-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.hs-card{background:var(--card);border:1px solid var(--line);border-radius:15px;padding:18px;box-shadow:0 1px 0 rgba(0,0,0,.02)}
.hs-card.span2{grid-column:1/-1}
@media(max-width:640px){.hs-grid{grid-template-columns:1fr}.hs-card.span2{grid-column:1}}
.hs-sec{font-family:'Fraunces',serif;font-weight:500;font-size:17px;margin:0 0 12px;display:flex;align-items:baseline;gap:8px}
.hs-req{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;color:var(--clay);text-transform:uppercase}
.hs-opt{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.05em;color:var(--soft);text-transform:uppercase}
.hs-ready{display:flex;gap:20px;align-items:center}
.hs-dial{width:104px;height:104px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;border:3px solid var(--line)}
.hs-dial.tone-pine{border-color:var(--pine)} .hs-dial.tone-amber{border-color:var(--amber)} .hs-dial.tone-clay{border-color:var(--clay)}
.hs-dial-n{font-family:'Fraunces',serif;font-size:39px;font-weight:600;line-height:1}
.hs-dial-l{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--soft)}
.hs-ready-side{flex:1}
.hs-chips{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px}
.hs-chip{font-size:12px;font-weight:500;padding:3px 9px;border-radius:20px;border:1px solid var(--line)}
.hs-chip.tone-pine{background:#E8EFE9;color:var(--pine);border-color:#CDDBCF}
.hs-chip.tone-amber{background:#F4EDD9;color:var(--amber);border-color:#E6D9B6}
.hs-chip.tone-clay{background:#F6E5DA;color:var(--clay);border-color:#EBCBB6}
.hs-chip.tone-mist{background:#EAF0EA;color:#6E8A72;border-color:#D6E2D7}
.hs-chip.tone-rust{background:#EEDAD3;color:#8A3D3D;border-color:#DFC2B8}
.hs-chip.tone-muted,.hs-chip.tone-line{background:transparent;color:var(--soft)}
.hs-muted-sm{font-size:13px;color:var(--soft);line-height:1.5;margin:6px 0}
.hs-coach{margin-top:16px;border-top:1px solid var(--line);padding-top:14px;font-size:14.5px;line-height:1.6}
.hs-coach p{margin:0 0 7px} .hs-coach b{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--pine);margin-right:8px}
.hs-coach .flag{color:var(--clay);display:flex;align-items:center;gap:6px;font-weight:500}
.hs-coach .flag b{display:none}
.hs-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;width:100%;border:1px solid var(--ink);background:var(--paper);color:var(--ink);
  font-family:inherit;font-size:14px;font-weight:600;padding:10px;border-radius:10px;cursor:pointer;transition:.15s;margin-top:10px}
.hs-btn:hover{background:var(--ink);color:var(--paper)}
.hs-btn.primary{background:var(--pine);color:#fff;border-color:var(--pine)}
.hs-btn.primary:hover{background:#2a4233}
.hs-btn.ghost{border-style:dashed;color:var(--soft)}
.hs-btn:disabled{opacity:.5;cursor:default}
.hs-btn-link{display:block;width:100%;background:none;border:none;color:var(--soft);font-family:inherit;font-size:13px;
  font-weight:500;padding:7px 0 0;cursor:pointer;text-align:center}
.hs-btn-link:hover{color:var(--pine)}
.hs-req{margin-top:8px}
.hs-req textarea{resize:vertical}
.hs-field{margin-bottom:10px} .hs-field.small{margin-bottom:6px}
.hs-flab{display:block;font-size:12.5px;color:var(--soft);margin-bottom:4px;font-weight:500}
.hs-sv{font-family:'JetBrains Mono',monospace;color:var(--pine);float:right}
.hs-input{width:100%;box-sizing:border-box;border:1px solid var(--line);background:var(--paper);border-radius:9px;padding:9px 11px;
  font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--ink);outline:none}
.hs-input:focus{border-color:var(--pine)}
select.hs-input{font-family:'Hanken Grotesk',sans-serif}
.hs-range{width:100%;accent-color:var(--pine)}
.hs-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.hs-hm{display:flex;align-items:center;gap:5px}
.hs-hm .hs-input{text-align:center;padding-left:6px;padding-right:6px}
.hs-hm-u{font-size:12px;color:var(--soft);font-family:'JetBrains Mono',monospace}
.hs-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;align-items:end}
.hs-stages{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
.hs-list{margin-top:12px;display:flex;flex-direction:column;gap:6px}
.hs-li{display:flex;justify-content:space-between;align-items:center;font-size:13.5px;padding:7px 10px;background:var(--paper);border-radius:8px;border:1px solid var(--line)}
.hs-li-r{display:flex;align-items:center;gap:8px;color:var(--soft);font-family:'JetBrains Mono',monospace;font-size:12px}
.hs-li-r svg{cursor:pointer;color:var(--soft)} .hs-li-r svg:hover{color:var(--clay)}
.hs-chart{margin-top:4px}
.hs-photo{margin-bottom:8px}
.hs-photo-empty{height:120px;border:1.5px dashed var(--line);border-radius:11px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--soft);font-size:13px}
.hs-thumb{width:100%;height:160px;object-fit:cover;border-radius:11px;border:1px solid var(--line)}
.hs-est{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:10px}
.hs-est-row{display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px}
.hs-est-row b{font-weight:600}
.hs-check{display:flex;align-items:center;gap:7px;font-size:13.5px;color:var(--soft);margin:8px 0}
.hs-caltot{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:4px 10px;margin-top:12px;font-size:15px;color:var(--ink)}
.hs-caltot b{font-size:21px;color:var(--pine);margin:0 2px}
.hs-bar{position:relative;height:26px;background:var(--paper);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-top:12px}
.hs-bar-fill{position:absolute;left:0;top:0;bottom:0;background:#E8EFE9;border-right:2px solid var(--pine)}
.hs-bar-fill.fibre{background:#F4EDD9;border-right-color:var(--amber)}
.hs-bar-t{position:relative;display:block;line-height:26px;padding-left:10px;font-size:12.5px;font-family:'JetBrains Mono',monospace;color:var(--ink)}
.hs-range-row{display:flex;gap:6px;flex-wrap:wrap}
.hs-range-btn{flex:1;min-width:56px;border:1px solid var(--line);background:var(--paper);color:var(--soft);font-family:inherit;font-size:13px;font-weight:600;padding:7px;border-radius:8px;cursor:pointer;transition:.15s}
.hs-range-btn:hover{color:var(--ink)}
.hs-range-btn.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.hs-zonebar{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:10px 0 4px;border:1px solid var(--line)}
.hs-zonebar span{display:block;min-width:0}
.hs-zlegend{display:flex;flex-wrap:wrap;gap:7px 14px;margin:8px 0 4px}
.hs-zleg{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--ink)}
.hs-zleg i{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.hs-plan{display:flex;flex-direction:column;gap:2px;margin-top:6px}
.hs-planrow{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px}
.hs-planrow.today{background:#ECE6D8}
.hs-pday{width:42px;font-size:13px;color:var(--soft)}
.hs-pdot{width:9px;height:9px;border-radius:50%;flex:none}
.hs-pdot.t-z2{background:#5C8060}.hs-pdot.t-q{background:#A83D3D}.hs-pdot.t-str{background:#C97B3C}.hs-pdot.t-pil{background:#9BB0A8}.hs-pdot.t-rest{background:#C9C3B5}
.hs-planedit{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.hs-planedit .hs-input{margin:0}
.hs-planedit select.hs-input{flex:none;width:92px}
.hs-planedit input.hs-input{flex:1}
.hs-pname{flex:1;font-size:14px;color:var(--ink)}
.hs-ptar{font-size:13px;color:var(--soft)}
.hs-plan-toggle{width:auto;background:none;border:none;color:var(--soft);font-size:13px;padding:6px 2px;margin-top:2px;cursor:pointer;text-align:left}
.hs-plan-toggle:hover{color:var(--ink)}
.hs-plan-today{font-size:14px;color:var(--ink);margin:2px 0 4px}
.hs-plan-today b{color:var(--pine);margin-right:6px}
.hs-askbox{display:flex;gap:8px;margin-top:10px;align-items:stretch}
.hs-askbox .hs-input{margin:0;flex:1 1 auto;min-width:0}
.hs-askbox .hs-btn{flex:0 0 auto;width:auto;white-space:nowrap;padding-left:16px;padding-right:16px}
.hs-ask-q{margin:10px 0 2px;color:var(--ink)}
.hs-ask-q b{color:var(--soft);margin-right:4px}
.hs-ask-a{margin:2px 0 6px;color:var(--ink)}
.hs-ask-a b{color:var(--pine);margin-right:4px}
.hs-brief{white-space:pre-wrap;font-size:13.5px;line-height:1.7;color:var(--ink);background:#F0ECE0;border-radius:10px;padding:10px 12px;margin:8px 0 10px}
.hs-supps{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.hs-supp{display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--paper);font-size:14.5px;cursor:pointer}
.hs-supp.on{background:#E8EFE9;border-color:#CDDBCF;color:var(--pine)}
.hs-supp input{accent-color:var(--pine)}
.hs-supp svg{margin-left:auto;color:var(--soft);cursor:pointer}
.hs-supp-sugg{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.hs-supp-edit{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.hs-supp-edit .hs-input{margin:0;flex:1}
.hs-supp-edit svg{color:var(--soft);cursor:pointer;flex:none}
.hs-chip-add{border:1px dashed var(--line);background:transparent;color:var(--soft);font-family:inherit;font-size:13px;padding:5px 10px;border-radius:20px;cursor:pointer;transition:.15s}
.hs-chip-add:hover{border-color:var(--pine);color:var(--pine);border-style:solid}
.hs-head-r{display:flex;align-items:center;gap:12px}
.hs-lang{background:var(--card);border:1px solid var(--line);color:var(--soft);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;padding:5px 10px;border-radius:8px;cursor:pointer;transition:.15s}
.hs-lang:hover{color:var(--ink);border-color:var(--ink)}
.hs-foot{margin-top:22px;text-align:center;font-size:11.5px;color:var(--soft);line-height:1.6;border-top:1px solid var(--line);padding-top:14px}
.hs-health-banner{display:flex;align-items:center;gap:6px;margin:0 0 12px;padding:9px 12px;border-radius:10px;background:rgba(46,160,90,.12);border:1px solid rgba(46,160,90,.35);color:#2ea05a;font-size:13.5px;cursor:pointer}
  `}</style>;
}
