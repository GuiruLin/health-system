// Weekly auto-coach (server-side, always-on). Vercel Cron every Sunday.
// Reads ALL of Lynn's data (Strava week + sleep + HRV/RHR + diet + body
// composition + menstrual cycle + supplements + marathon), asks a world-class
// coach (Attia + Stacy Sims + Huberman synthesis) for next week's plan +
// holistic briefing, and writes it to the coachplan store. Lynn taps
// 载入教练计划 to apply. No device needs to be on.
//
// Env: REDIS_URL, STRAVA_CLIENT_ID/SECRET, ANTHROPIC_API_KEY, CRON_SECRET(optional)

import Redis from "ioredis";

// This function does several sequential Strava fetches + one Anthropic call,
// which can take well over the default timeout — allow up to 60s (Hobby max).
export const maxDuration = 60;

const MODEL = "claude-sonnet-4-6";
const TOKEN_URL = "https://www.strava.com/oauth/token";
const ACT_URL = "https://www.strava.com/api/v3/athlete/activities";
// Lynn's real HR zone edges (max HR ~185): Z1<121 Z2 121-150 Z3 151-165 Z4 166-179 Z5 180+
const EDGES = [120, 150, 165, 179];
const RACE = "2026-09-13";

let client;
function redis() {
  if (!client) client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  return client;
}
const zoneOf = hr => hr <= EDGES[0] ? "z1" : hr <= EDGES[1] ? "z2" : hr <= EDGES[2] ? "z3" : hr <= EDGES[3] ? "z4" : "z5";
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const mean = (arr, f) => { const v = arr.map(f).filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const rnd1 = x => x == null ? null : Math.round(x * 10) / 10;

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const hasSecret = secret && ((req.headers.authorization || "") === `Bearer ${secret}` || (req.query?.key || "") === secret);
  // The Sunday cron (and admin) send the secret. The in-app 「更新本周分析」button
  // calls this WITHOUT a secret — allowed, but blocked from other sites and
  // rate-limited (20-min cooldown) below so手滑连点 doesn't burn AI calls.
  if (secret && !hasSecret && !sameOriginish(req)) return res.status(403).json({ error: "Forbidden" });
  if (!process.env.REDIS_URL || !process.env.STRAVA_CLIENT_ID || !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Missing REDIS_URL / STRAVA creds / ANTHROPIC_API_KEY" });
  }
  try {
    const r = redis();
    // Rate-limit manual (in-app) triggers: only truly regenerate once per 20 min.
    if (!hasSecret) {
      const last = Number(await r.get("weekly:lastrun") || 0);
      const CD = 20 * 60 * 1000;
      if (last && Date.now() - last < CD) {
        const raw = await r.get("coachplan");
        const cp = raw ? JSON.parse(raw) : {};
        return res.status(200).json({ ok: true, cooled: true, minutes_left: Math.ceil((CD - (Date.now() - last)) / 60000), plan: cp.plan || null, note: cp.note || "" });
      }
    }
    const today = new Date().toISOString().slice(0, 10);

    // ---- all app data from the cloud backup ----
    const rawBackup = await r.get("backup");
    const data = rawBackup ? (JSON.parse(rawBackup).data || {}) : {};
    const parseByPfx = pfx => Object.entries(data).filter(([k]) => k.startsWith(pfx))
      .map(([k, v]) => { try { return { _k: k, ...JSON.parse(v) }; } catch { return null; } }).filter(Boolean);

    const profile = data["hs:profile"] ? JSON.parse(data["hs:profile"]) : {};
    const rtRaw = data["hs:strava:refresh"];
    if (!rtRaw) return res.status(400).json({ error: "No Strava token in backup" });
    const refresh_token = JSON.parse(rtRaw);

    const proteinTarget = Math.round((Number(profile.weight) || 0) * (Number(profile.proteinPerKg) || 0));
    const fibreTarget = Math.round(Number(profile.fibreTarget) || 35);

    // sleep / HRV / RHR / subjective (daily entries; date is in the key)
    const dailyE = parseByPfx("hs:daily:").map(o => ({ date: o._k.replace("hs:daily:", ""), ...o }))
      .sort((a, b) => a.date.localeCompare(b.date));
    // Drop physiologically impossible values (a bad Apple Health sync once wrote
    // a raw sensor value as RHR ~5.4e8 and a 76h sleep). Keep the data intact but
    // don't let one garbage reading poison the coach's numbers.
    const okNum = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
    const last14 = dailyE.slice(-14).map(d => ({
      ...d,
      sleepTotal: okNum(d.sleepTotal, 0, 20),
      deep: okNum(d.deep, 0, 20),
      rem: okNum(d.rem, 0, 20),
      hrv: okNum(d.hrv, 5, 300),
      rhr: okNum(d.rhr, 25, 150),
    }));
    const sleep7 = last14.slice(-7).map(d => ({ date: d.date, hrs: rnd1(Number(d.sleepTotal)), deep: rnd1(Number(d.deep)), rem: rnd1(Number(d.rem)) }));
    const sleepAvg = rnd1(mean(last14.slice(-7).filter(d => d.sleepTotal != null), d => Number(d.sleepTotal)));
    const deepAvg = rnd1(mean(last14.slice(-7).filter(d => d.deep != null), d => Number(d.deep)));
    const hrvDays = last14.filter(d => d.hrv != null);
    const hrvBase = Number(profile.hrvBase) || 40; // her stated baseline; Goals-card value wins
    const hrvLatest = hrvDays.length ? Math.round(Number(hrvDays[hrvDays.length - 1].hrv)) : null;
    const rhrDays = last14.filter(d => d.rhr != null);
    const rhrBase = Number(profile.rhrBase) || 54; // her stated baseline; Goals-card value wins
    const rhrLatest = rhrDays.length ? Math.round(Number(rhrDays[rhrDays.length - 1].rhr)) : null;
    const subjective = { energy: rnd1(mean(last14.slice(-5), d => Number(d.energy))), mood: rnd1(mean(last14.slice(-5), d => Number(d.mood))), soreness: rnd1(mean(last14.slice(-5), d => Number(d.soreness))) };

    // diet — last 7 days vs targets
    const dates7 = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const meals = parseByPfx("hs:meal:");
    const diet7 = dates7.map(dt => {
      const dm = meals.filter(m => m.date === dt);
      return { date: dt, cal: dm.reduce((s, m) => s + (Number(m.cal) || 0), 0), protein: dm.reduce((s, m) => s + (Number(m.protein) || 0), 0), fibre: dm.reduce((s, m) => s + (Number(m.fibre) || 0), 0) };
    }).reverse();
    const calAvg = Math.round(mean(diet7.filter(d => d.cal), d => d.cal) || 0);
    const proteinAvg = Math.round(mean(diet7.filter(d => d.protein), d => d.protein) || 0);
    const fibreAvg = Math.round(mean(diet7.filter(d => d.fibre), d => d.fibre) || 0);
    const proteinHitDays = diet7.filter(d => d.protein >= proteinTarget && proteinTarget > 0).length;

    // body composition — latest value per metric type
    const bodyComp = {};
    for (const m of parseByPfx("hs:metric:").sort((a, b) => (a.date || "").localeCompare(b.date || ""))) if (m.type) bodyComp[m.type] = m.value;

    // menstrual cycle
    const cycleStart = profile.cycleStart || null;
    const cycleLen = Number(profile.cycleLen) || 28;
    let cycleDay = null, phase = null;
    if (cycleStart) {
      const diff = daysBetween(cycleStart, today);
      cycleDay = ((diff % cycleLen) + cycleLen) % cycleLen + 1;
      phase = cycleDay <= 5 ? "月经期" : cycleDay <= 13 ? "卵泡期" : cycleDay <= 16 ? "排卵期" : "黄体期";
    }

    // supplements — last 7 days adherence
    const supp7 = parseByPfx("hs:supp:").map(o => ({ date: o._k.replace("hs:supp:", ""), ...o })).filter(s => dates7.includes(s.date));
    const suppAdherence = {};
    for (const s of supp7) for (const [name, val] of Object.entries(s)) { if (name === "date" || name === "_k") continue; if (val) suppAdherence[name] = (suppAdherence[name] || 0) + 1; }

    // ---- Strava week ----
    const tok = await postJSON(TOKEN_URL, { client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET, refresh_token, grant_type: "refresh_token" });
    if (!tok.access_token) return res.status(401).json({ error: "Strava token refresh failed", detail: tok.message || tok });
    const after = Math.floor(Date.now() / 1000) - 8 * 86400;
    const actsRes = await fetch(`${ACT_URL}?after=${after}&per_page=100`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const acts = await actsRes.json();
    if (!Array.isArray(acts)) return res.status(502).json({ error: "Strava fetch failed", detail: acts });

    const runs = acts.filter(a => (a.sport_type || a.type) === "Run");
    const strengthN = acts.filter(a => /Weight|Workout|Crossfit|HIIT/i.test(a.sport_type || a.type || "")).length;
    const pilatesN = acts.filter(a => /Pilates|Yoga|Barre/i.test(a.sport_type || a.type || "")).length;
    const totalKm = +(runs.reduce((s, a) => s + (a.distance || 0), 0) / 1000).toFixed(1);
    const zoneMin = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
    let hitHard = false;
    for (const a of runs) {
      const hr = a.average_heartrate, mt = (a.moving_time || 0) / 60;
      if (hr && mt) zoneMin[zoneOf(hr)] += mt;
      if ((a.max_heartrate || 0) >= 170) hitHard = true;
    }
    const zTot = Object.values(zoneMin).reduce((a, b) => a + b, 0) || 1;
    const run_zone_pct = Object.fromEntries(Object.entries(zoneMin).map(([k, v]) => [k, Math.round(v / zTot * 100)]));

    let fade = null, longestKm = 0;
    const longest = runs.slice().sort((a, b) => (b.distance || 0) - (a.distance || 0))[0];
    if (longest) {
      longestKm = +((longest.distance || 0) / 1000).toFixed(1);
      try {
        const dRes = await fetch(`https://www.strava.com/api/v3/activities/${longest.id}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
        const sp = (await dRes.json()).splits_metric || [];
        if (sp.length >= 6) {
          const paceOf = arr => { const dist = arr.reduce((s, x) => s + (x.distance || 0), 0) / 1000; const t = arr.reduce((s, x) => s + (x.moving_time || 0), 0) / 60; return dist ? +(t / dist).toFixed(2) : null; };
          const h = Math.floor(sp.length / 2);
          fade = { firstHalfPace: paceOf(sp.slice(0, h)), secondHalfPace: paceOf(sp.slice(h)) };
        }
      } catch { /* splits optional */ }
    }

    const weeksToRace = Math.max(0, Math.ceil((daysBetween(today, RACE) + 1) / 7));

    // strength sessions — read the text log (sets/reps/weights) she writes in the Strava description
    const wtActs = acts.filter(a => /Weight|Workout|Crossfit/i.test(a.sport_type || a.type || ""));
    const strengthLogs = [];
    for (const a of wtActs.slice(-4)) {
      let desc = "", rpe = null;
      try {
        const dr = await fetch(`https://www.strava.com/api/v3/activities/${a.id}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
        const det = await dr.json();
        desc = det.description || "";
        rpe = det.perceived_exertion ?? null;
      } catch { /* description optional */ }
      strengthLogs.push({ date: (a.start_date_local || "").slice(0, 10), name: a.name || "", minutes: Math.round((a.moving_time || 0) / 60), avg_hr: a.average_heartrate || null, rpe, log: desc });
    }

    const summary = {
      race: { date: RACE, name: profile.eventName || null, weeks_to_race: weeksToRace, goal: "健康地冲进4小时 (MP 5:40/km)" },
      running_week: { total_km: totalKm, runs: runs.length, zone_pct_by_her_real_zones: run_zone_pct, quality_reached_z4z5: hitHard, longest_run_km: longestKm, long_run_fade: fade },
      other_training: { strength_sessions: strengthN, pilates_sessions: pilatesN },
      strength_logs: strengthLogs,
      sleep: { last7: sleep7, avg_hrs: sleepAvg, avg_deep_hrs: deepAvg, target_hrs: 7.5 },
      recovery: { hrv_baseline: hrvBase, hrv_latest: hrvLatest, rhr_baseline: rhrBase, rhr_latest: rhrLatest, subjective_5pt: subjective },
      diet: { cal_avg_kcal: calAvg, cal_target_note: "维持约2400/长跑日约3000(BMR约1445)", protein_avg_g: proteinAvg, protein_target_g: proteinTarget, protein_target_hit_days_of7: proteinHitDays, fibre_avg_g: fibreAvg, fibre_target_g: fibreTarget, last7: diet7 },
      body_composition_latest: bodyComp,
      cycle: { current_day: cycleDay, phase, cycle_length: cycleLen, last_period_start: cycleStart },
      supplements_last7_adherence: suppAdherence,
      her_question_or_pref: profile.coachPrompt || null,
    };

    // ---- world-class coach ----
    const system =
      "你是全世界最顶尖的健康与耐力运动教练,融合并超越以下框架,取其最适合她的部分:Peter Attia(Medicine 3.0 / 长寿:Zone2 有氧、VO2max、力量、稳定性、代谢与向心健康);Stacy Sims(女性生理:按月经周期调训练与营养、女性要吃够且练重、women are not small men、警惕低能量可用性 RED-S);Andrew Huberman(神经科学:睡眠与昼夜节律、晨间见光、咖啡因时机、NSDR/小睡、一致性、体温与入睡)。你以长期健康寿命为第一优先,再谈成绩,一切个体化到她的真实数据。" +
      "她的真实心率区:Z1<121 Z2 121-150 Z3 151-165 Z4 166-179 Z5 180+(最大心率约185)。" +
      "注意 subjective_5pt(精力/情绪/酸痛)是1-5分制、不是10分制:精力/情绪 5=最好、4=挺好;酸痛 1=不酸、5=很酸。别把4当成偏低。" +
      "综合她过去一周的【全部数据】(跑步、力量、普拉提、睡眠、深睡、HRV/RHR、主观精力/情绪/酸痛、饮食蛋白与纤维达标情况、身体成分、月经周期与阶段、补剂依从、她的问题/偏好),生成下周计划。" +
      "特别注意 strength_logs:那是她在 Strava 描述里写的力量训练明细(标题/动作/组数/次数/重量/RPE)。【核心原则:先读懂每次训练的内容与目的,不能只看 RPE 数字下判断。】她的训练常有不同目的日:技术日 / 单腿稳定 / 活动度(RPE 本就低,是 Attia 强调的稳定性支柱,非常有价值,绝不能因 RPE 低就说『偏轻』);大重量力量日(应低次数高负荷);泵感/代谢收尾。请按每次的标题和动作把它归类,再针对性评估。只对『本意是练力量、渐进超负荷』的日子谈负荷够不够重;技术/稳定性/活动度日只肯定其价值、不评加重。判断整个训练块:她是否有足够的真正大重量渐进超负荷日(按 Sims:主项 4-6 次、RPE 7-8)?若缺,才提醒补上并给加重建议;若已有,就肯定并提示下一步的小幅进阶。一切依据她练了什么,不是 RPE 数字。" +
      "不要用固定模板。每周都要根据她的真实动态数据(HRV相对基线、睡眠与深睡、主观精力/情绪/酸痛、上周跑步分区与长跑是否掉速、月经周期阶段、蛋白/纤维达标、补剂依从、近期训练负荷)重新智能地安排这一周——这是最重要的原则。" +
      "一周构成是她定的【硬性规则,必须严格满足】:(1) 恰好2次力量——1次上半身、1次下半身,分两天;(2) 跑步最多3次——1次冲刺(间歇或Tempo二选一,直接写清是「间歇」还是「Tempo」,绝不用『质量课』;冲进Z4即166+,间歇摸180+)、1次逐周推进的长距离(约+2km往~30km峰值、赛前约3周后减量)、1次Z2轻松跑(心率130-145);(3) 至少1次普拉提/Barre;(4) 最多1天完全休息(通常正好1天)。极化80/20为总原则。绝不要排超过3次跑步,也绝不要少于2次力量。" +
      "把这些聪明地摆进7天:最硬的课(间歇或Tempo/大重量/长距离)放她最新鲜的日子,完全休息与轻松日放她恢复最差的日子;练腿的硬日彼此错开(长距离/间歇/重腿之间夹轻松或上肢或休息);卵泡期可多推力量与强度,黄体期或月经期偏向恢复与补给;长距离【必须】放在周六或周日,绝不放在周一到周五(她周末跑长距离);而且如果 strava_logs / 跑步数据显示她刚在上个周末跑过长距离,那本周的周一【必须】是恢复日(rest 或极轻松),绝不能紧接着再排一次长距离——连续两天长距离是大忌。她也重视一天真正的休息。" +
      "自我调节:HRV明显低于基线、睡眠不足或深睡少、上周长跑掉速、正值经期、或近期负荷过高 → 本周更保守(缩短长距离、把间歇或Tempo那次降为Z2、增加休息或普拉提、强调睡眠与补给);各项良好则稳步推进强度与量。" +
      "每天 note 必须一行、约15-30字,只含心率或配速目标 + 最多一个关键提示(无emoji);详细分析只写在总简报 note 里,绝不要在每天的 note 里写长段落。" +
      "只返回JSON,无其他文字,格式:{\"plan\":[{\"type\":\"strength|z2|long|quality|pilates|rest\",\"note\":\"...\"} 共7项],\"note\":\"本周简报\"}。" +
      "note 字段是本周简报,以训练决策为轴,分两块,两块之间用两个换行符 \\n\\n 分隔,大标题用【】;整体必须高效简洁、不啰嗦。\\n\\n" +
      "第一块【状态】:用3-5句简洁概括最近一周的睡眠、饮食、周期、恢复(HRV/RHR),只点出会影响本周训练的关键 + 具体数字/目标,不要长篇、不要逐条铺开。\\n\\n" +
      "第二块【训练】(核心):按训练类别分,每类高效讲评上周并说下周怎么提高:\\n" +
      "▸ 跑步:上周分区/掉速关键点 + 下周跑步重点(1-2句)\\n" +
      "▸ 力量:先一行『本周力量:』,再每次训练各占一行『日期 · 部位 · 类型 · 组数×次数 · RPE』(类型按内容判断,技术/稳定性日不算偏轻);最后一句结论——需加重就点名哪个动作加到多少,已到位就说继续小幅渐进\\n" +
      "▸ 普拉提:1句它这周的作用\\n" +
      "用真实数字,像懂她的教练在说话,全程简洁。";

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4500, system, messages: [{ role: "user", content: "我过去一周的全部数据:\n" + JSON.stringify(summary, null, 2) }] }),
    });
    const ai = await aiRes.json();
    const text = ai?.content?.[0]?.text || "";
    const parsed = safeJSON(text);
    if (!parsed || !Array.isArray(parsed.plan) || parsed.plan.length !== 7) {
      return res.status(502).json({ error: "AI did not return a valid 7-day plan", raw: text.slice(0, 600), summary });
    }
    const plan = parsed.plan.map(d => ({ type: String(d.type || "rest"), note: String(d.note || "") }));
    // Hard guardrail: the long run must be on the weekend (Sat=idx5 / Sun=idx6),
    // never Mon-Fri — regardless of what the model returned.
    const li = plan.findIndex(d => d.type === "long");
    if (li >= 0 && li < 5) { const t = plan[5]; plan[5] = plan[li]; plan[li] = t; }

    const ts = Date.now();
    await r.set("coachplan", JSON.stringify({ plan, note: String(parsed.note || ""), ts }));
    await r.set("weekly:lastrun", String(ts));
    return res.status(200).json({ ok: true, ts, summary, note: parsed.note, plan });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
function sameOriginish(req) {
  const host = req.headers.host;
  const ref = req.headers.origin || req.headers.referer || "";
  if (!ref) return true;
  try { return new URL(ref).host === host; } catch { return false; }
}
function safeJSON(t) {
  try { return JSON.parse(t); } catch {}
  const m = t && t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
