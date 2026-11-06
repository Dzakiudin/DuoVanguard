// language: JavaScript (Node 18+ ESM)
// Layer: Quests & Monthly Badges Service (src/services/quests.mjs)
// Menggabungkan kontrak terverifikasi goals-api + SAFE_METRICS guard dengan
// Monthly Badges & Quest Explorer dari DuoHacker v2.6 dan Duolingo PRO 3.1.

import { GOALS_HOST, UA, sleep } from '../core/client.mjs';
import { todayIn } from './profile.mjs';
import { unclaimedRewards, claimRewards, gemCount } from './economy.mjs';

function goalHeaders(jwt, sub) {
  return {
    Authorization: `Bearer ${jwt}`,
    'x-requested-with': 'XMLHttpRequest',
    Accept: 'application/json; charset=UTF-8',
    'Accept-Language': 'id,en;q=0.9',
    'Content-Type': 'application/json; charset=UTF-8',
    'User-Agent': UA,
    'x-amzn-trace-id': `User=${sub}`,
    Origin: GOALS_HOST,
    Referer: `${GOALS_HOST}/`,
  };
}

async function goalsFetch(jwt, sub, path, opts = {}) {
  let res;
  try {
    res = await fetch(GOALS_HOST + path, {
      ...opts,
      headers: { ...goalHeaders(jwt, sub), ...(opts.headers || {}) },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    throw new Error(`goals ${opts.method || 'GET'} ${path} -> jaringan: ${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const e = new Error(`goals ${opts.method || 'GET'} ${path} -> ${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return { status: res.status, data };
}

export async function questSchema(jwt, sub) {
  const { data } = await goalsFetch(jwt, sub, `/schema?ui_language=en&_=${Date.now()}`);
  return data;
}

export async function questProgress(jwt, sub, tz = 'Asia/Jakarta') {
  const q = encodeURIComponent(tz);
  const { data } = await goalsFetch(jwt, sub, `/users/${sub}/progress?timezone=${q}&ui_language=en`);
  return data;
}

// Hitung timestamp pertengahan bulan untuk Monthly Badge (YYYY_MM_monthly)
export function getQuestTimestamp(goalId) {
  const m = /^(\d{4})_(\d{1,2})_monthly/.exec(String(goalId || ''));
  if (m) {
    const year = parseInt(m[1], 10);
    const monthIndex = parseInt(m[2], 10) - 1;
    const d = new Date(Date.UTC(year, monthIndex, 15, 12, 0, 0));
    const now = new Date();
    return d > now ? now.toISOString() : d.toISOString();
  }
  return new Date().toISOString();
}

// Cek apakah Monthly Badge lebih tua dari tanggal pembuatan akun (DuoHacker v2.6 Guard)
export function isQuestOlderThanAccount(goalId, creationTs) {
  if (!creationTs) return false;
  const m = /^(\d{4})_(\d{1,2})_monthly/.exec(String(goalId || ''));
  if (!m) return false;
  const qYear = parseInt(m[1], 10);
  const qMonth = parseInt(m[2], 10);
  const cDate = new Date(creationTs * 1000);
  const cYear = cDate.getUTCFullYear();
  const cMonth = cDate.getUTCMonth() + 1;
  if (qYear < cYear) return true;
  if (qYear === cYear && qMonth < cMonth) return true;
  return false;
}

export async function questBatch(jwt, sub, updates, tz = 'Asia/Jakarta', { timestamp, autoAddQuestMetric = true } = {}) {
  const rawList = Array.isArray(updates) ? updates : [];
  const hasExplicitQuests = rawList.some(u => u && u.metric === 'QUESTS' && Number(u.quantity) > 0);
  const rest = rawList
    .filter(u => u && u.metric && (hasExplicitQuests || u.metric !== 'QUESTS'))
    .map(u => ({ metric: u.metric, quantity: Number(u.quantity) }))
    .filter(u => Number.isFinite(u.quantity) && u.quantity > 0);

  const metric_updates = (!hasExplicitQuests && autoAddQuestMetric && rest.length)
    ? [...rest, { metric: 'QUESTS', quantity: 1 }]
    : rest;

  if (!metric_updates.length) return { status: 0, body: { skipped: true } };

  const r = await goalsFetch(jwt, sub, `/users/${sub}/progress/batch`, {
    method: 'POST',
    body: JSON.stringify({
      metric_updates,
      timezone: tz,
      timestamp: timestamp || new Date().toISOString(),
    }),
  });
  return { status: r.status, body: r.data };
}

function ymd(o) {
  if (!o) return null;
  const p = n => String(n).padStart(2, '0');
  return `${o.year}-${p(o.month)}-${p(o.day)}`;
}

function covers(period, today) {
  if (!period) return false;
  if (period.oneOff) {
    const s = ymd(period.oneOff.start);
    const e = ymd(period.oneOff.end);
    return !!s && !!e && today >= s && today < e;
  }
  if (period.recurring) {
    const s = ymd(period.recurring.start);
    const e = ymd(period.recurring.until);
    return !!s && !!e && today >= s && today < e;
  }
  return false;
}

export function activeGoals(schema, today) {
  const byId = new Map();
  const version = g => Number(g.version ?? 0);
  for (const g of schema?.goals || []) {
    if (!g?.goalId || !covers(g.period, today)) continue;
    const prev = byId.get(g.goalId);
    if (!prev) { byId.set(g.goalId, g); continue; }
    if (version(g) > version(prev) ||
        (version(g) === version(prev) && Number(g.threshold ?? 0) > Number(prev.threshold ?? 0))) {
      byId.set(g.goalId, g);
    }
  }
  return [...byId.values()];
}

export const SAFE_METRICS = new Set([
  'QUESTS', 'XP', 'LESSONS', 'CROWNS', 'UNITS', 'LEVELS',
  'NINETY_ACCURACY_LESSONS', 'EIGHTY_ACCURACY_LESSONS', 'PERFECT_LESSONS',
  'COMBO_XP', 'FIVE_CORRECT_IN_A_ROW', 'TEN_CORRECT_IN_A_ROW',
  'SECONDS_SPENT_LEARNING', 'EXTEND_STREAK', 'START_STREAK',
  'PRACTICE_SESSIONS', 'PRACTICE_HUB_SESSIONS', 'DEEPEST_PATH_NODE_SESSIONS',
  'REVIEW_MISTAKES', 'RESURRECTED_REVIEW', 'NO_HINTS_TAPPED',
  'RAMP_UP', 'MULTI_SESSION_RAMP_UP',
]);

export async function autoQuests(
  jwt, sub,
  { tz = 'Asia/Jakarta', log = console.log, all = false, dry = false, maxUpdates = 8, force = false } = {},
) {
  const [schema, progress] = await Promise.all([questSchema(jwt, sub), questProgress(jwt, sub, tz)]);
  const today = todayIn(tz);
  const details = progress?.goals?.details || {};
  const counters = progress?.goals?.progress || {};

  const valueOf = g => {
    const raw = Number(details[g.goalId]?.progress ?? counters[g.goalId] ?? 0);
    return Number.isFinite(raw) ? Math.max(0, raw) : 0;
  };
  const byMetric = new Map();
  for (const g of activeGoals(schema, today)) {
    const metric = g.metric;
    const threshold = Number(g.threshold ?? 0);
    if (!metric || !(threshold > 0)) continue;
    const cur = byMetric.get(metric) || { threshold: 0, value: 0 };
    cur.threshold = Math.max(cur.threshold, threshold);
    cur.value = Math.max(cur.value, valueOf(g));
    byMetric.set(metric, cur);
  }
  const updates = [];
  for (const [metric, m] of byMetric) {
    if (!all && !SAFE_METRICS.has(metric)) continue;
    const delta = m.threshold - m.value;
    if (delta <= 0) continue;
    updates.push({ metric, progress: m.value, threshold: m.threshold, delta });
  }

  if (!updates.length) {
    log(`tidak ada metrik aman yang perlu dikirim (${today})`);
    return { ok: false, updates: [] };
  }
  for (const u of updates) log(`${u.metric} ${u.progress}/${u.threshold} d=${u.delta}`);
  if (!dry && updates.length > maxUpdates && !force) {
    log(`ditolak: ${updates.length} metrik sekaligus > batas ${maxUpdates} (pakai --force)`);
    return { ok: false, refused: 'terlalu_banyak', updates };
  }
  if (dry) {
    log(`dry-run: ${updates.length} metrik, tidak ada request dikirim`);
    return { ok: false, dry: true, updates };
  }
  await questBatch(jwt, sub, updates.map(u => ({ metric: u.metric, quantity: u.delta })), tz);
  log(`batch quest terkirim (${updates.length} metrik)`);
  return { ok: true, updates };
}

export async function questLoop(
  jwt, sub, course,
  { tz = 'Asia/Jakarta', rounds = 3, maxNew = 25, all = false, dry = false, force = false, log = console.log } = {},
) {
  let claimed = 0, delta = 0, batches = 0;
  for (let i = 1; i <= rounds; i++) {
    const seen = new Set((await unclaimedRewards(jwt, sub, { all: true })).map(r => r.id));
    let res;
    try {
      res = await autoQuests(jwt, sub, { tz, log, all, dry, force });
    } catch (e) {
      if (e.status === 429) { log('429 - berhenti'); break; }
      throw e;
    }
    batches++;
    await sleep(2500);
    const after = await unclaimedRewards(jwt, sub, { all: true });
    const fresh = after.filter(r => !seen.has(r.id)).slice(0, maxNew);
    log(`putaran ${i}: ${fresh.length} reward baru`);
    if (!fresh.length) {
      if (!res.ok || dry) break;
      await sleep(1500);
      continue;
    }
    const cl = await claimRewards(jwt, {
      sub, course, ids: fresh.map(r => r.id), maxClaims: maxNew, log,
    });
    claimed += cl.claimed || 0;
    delta += cl.delta || 0;
    log(`putaran ${i}: klaim ${cl.claimed}/${fresh.length} delta ${cl.delta ?? 0}`);
    if (cl.stopped) { log(`berhenti: ${cl.stopped}`); break; }
    await sleep(2000);
  }
  const gems = await gemCount(jwt, sub);
  log(`loop selesai: batch ${batches}, klaim ${claimed}, delta ${delta}, gems ${gems}`);
  return { batches, claimed, delta, gems };
}

// ── Katalog Lengkap Quests & Monthly Badges (DuoHacker v2.6 + Duolingo PRO 3.1) ──
export async function badgesCatalog(jwt, sub, { tz = 'Asia/Jakarta', creationTs = null } = {}) {
  const [schema, progress] = await Promise.all([questSchema(jwt, sub), questProgress(jwt, sub, tz)]);
  const today = todayIn(tz);
  const details = progress?.goals?.details || {};
  const counters = progress?.goals?.progress || {};

  const badgeMap = new Map();
  for (const b of schema?.badges || []) {
    if (b?.goalId) badgeMap.set(b.goalId, b);
  }

  const goalMap = new Map();
  for (const g of schema?.goals || []) {
    if (!g?.goalId) continue;
    const prev = goalMap.get(g.goalId);
    if (!prev || Number(g.version ?? 0) >= Number(prev.version ?? 0)) {
      goalMap.set(g.goalId, g);
    }
  }

  const allIds = new Set([...goalMap.keys(), ...badgeMap.keys()]);
  const items = [];

  for (const id of allIds) {
    const g = goalMap.get(id) || {};
    const b = badgeMap.get(id) || {};
    const idLower = id.toLowerCase();

    let category = 'OTHER';
    if (idLower.includes('monthly') || badgeMap.has(id)) category = 'MONTHLY';
    else if (idLower.includes('daily')) category = 'DAILY';
    else if (idLower.includes('weekly')) category = 'WEEKLY';
    else if (idLower.includes('friend') || idLower.includes('clash') || idLower.includes('social')) category = 'FRIENDS';

    const metric = g.metric || b.metric || (category === 'MONTHLY' ? 'QUESTS' : 'UNKNOWN');
    const threshold = Number(g.threshold ?? b.threshold ?? (category === 'MONTHLY' ? 30 : 1));
    const rawProg = Number(details[id]?.progress ?? counters[id] ?? 0);
    const curProg = Number.isFinite(rawProg) ? Math.max(0, rawProg) : 0;
    const done = curProg >= threshold && threshold > 0;
    const activeToday = covers(g.period, today);
    const olderThanAccount = isQuestOlderThanAccount(id, creationTs);

    let title = b.title || b.name || g.title || g.name || id.replace(/_/g, ' ').toUpperCase();
    const desc = b.description || g.description || `${metric} (${curProg}/${threshold})`;
    const iconUrl =
      b.iconUrlComplete ||
      b.iconUrlIncomplete ||
      b.activeSvg ||
      b.BadgeIcon ||
      g.iconUrl ||
      (category === 'MONTHLY'
        ? 'https://d35aaqx5ub95lt.cloudfront.net/images/goals/badge-locked.svg'
        : 'https://d35aaqx5ub95lt.cloudfront.net/images/goals/2b5a211d830a24fab92e291d50f65d1d.svg');

    items.push({
      goalId: id,
      title,
      description: desc,
      category,
      metric,
      threshold,
      progress: curProg,
      delta: Math.max(0, threshold - curProg),
      done,
      activeToday,
      safeMetric: SAFE_METRICS.has(metric),
      olderThanAccount,
      iconUrl,
      timestamp: getQuestTimestamp(id),
    });
  }

  // Urutkan: Monthly terbaru di atas, lalu Active Today, lalu berdasarkan goalId menurun
  items.sort((a, b) => {
    if (a.category === 'MONTHLY' && b.category === 'MONTHLY') {
      return b.goalId.localeCompare(a.goalId);
    }
    if (a.activeToday !== b.activeToday) return a.activeToday ? -1 : 1;
    return b.goalId.localeCompare(a.goalId);
  });

  return {
    today,
    total: items.length,
    activeCount: items.filter(i => i.activeToday).length,
    monthlyCount: items.filter(i => i.category === 'MONTHLY').length,
    items,
  };
}

// ── Update / Claim 1 Goal atau Monthly Badge Spesifik (+1, +10, Claim, atau MM/YYYY) ──
export async function updateSingleGoal(
  jwt,
  sub,
  { goalId, metric = 'QUESTS', quantity = 1, tz = 'Asia/Jakarta' },
  log = console.log,
) {
  const qty = Math.max(1, Number(quantity) || 1);
  const ts = getQuestTimestamp(goalId);
  const r = await questBatch(
    jwt,
    sub,
    [{ metric, quantity: qty }],
    tz,
    { timestamp: ts, autoAddQuestMetric: metric !== 'QUESTS' },
  );
  log(`Quest update [${goalId || metric}] +${qty} ${metric} (ts=${ts.slice(0, 10)}) -> status ${r.status}`);
  return r;
}

// ── Claim Monthly Badges (Spesifik MM/YYYY ala Duolingo PRO 3.1 atau Semua Monthly ala DuoHacker v2.6) ──
export async function claimMonthlyBadges(
  jwt,
  sub,
  {
    monthYear = null, // opsional: "MM/YYYY" atau "YYYY_MM"
    tz = 'Asia/Jakarta',
    creationTs = null,
    skipOlderThanAccount = true,
    delayMs = 450,
    shouldStop = () => false,
    log = console.log,
  } = {},
) {
  if (monthYear) {
    const clean = String(monthYear).trim();
    let year, month;
    if (/^\d{1,2}\/\d{4}$/.test(clean)) {
      const [mm, yyyy] = clean.split('/');
      month = String(parseInt(mm, 10)).padStart(2, '0');
      year = yyyy;
    } else if (/^\d{4}[_-]\d{1,2}$/.test(clean)) {
      const [yyyy, mm] = clean.split(/[_-]/);
      year = yyyy;
      month = String(parseInt(mm, 10)).padStart(2, '0');
    } else {
      throw new Error('Format bulan harus MM/YYYY (contoh: 05/2026)');
    }
    const goalId = `${year}_${month}_monthly`;
    if (skipOlderThanAccount && isQuestOlderThanAccount(goalId, creationTs)) {
      throw new Error(`Badge ${goalId} lebih tua dari umur pembuatan akun!`);
    }
    const r = await updateSingleGoal(jwt, sub, { goalId, metric: 'QUESTS', quantity: 50, tz }, log);
    return { claimed: 1, targets: [goalId], status: r.status };
  }

  const cat = await badgesCatalog(jwt, sub, { tz, creationTs });
  const targets = cat.items.filter(
    it =>
      it.category === 'MONTHLY' &&
      !it.done &&
      (!skipOlderThanAccount || !it.olderThanAccount),
  );

  if (!targets.length) {
    log('Tidak ada Monthly Badge aman yang belum selesai.');
    return { claimed: 0, targets: [] };
  }

  log(`Menemukan ${targets.length} Monthly Badge aman untuk diklaim...`);
  let claimed = 0;
  for (const t of targets) {
    if (shouldStop()) {
      log('Klaim Monthly Badge dihentikan pengguna.');
      break;
    }
    try {
      await updateSingleGoal(
        jwt,
        sub,
        { goalId: t.goalId, metric: t.metric || 'QUESTS', quantity: Math.max(1, t.delta || 50), tz },
        log,
      );
      claimed++;
    } catch (e) {
      log(`Gagal klaim badge ${t.goalId}: ${e.message}`);
      if (e.status === 429) break;
    }
    await sleep(delayMs);
  }
  log(`Selesai klaim ${claimed}/${targets.length} Monthly Badge.`);
  return { claimed, targets: targets.map(t => t.goalId) };
}
