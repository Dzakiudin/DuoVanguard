// language: JavaScript (Node 18+ ESM)
// Layer: Profile, Course, Streak View, Privacy, Superlink, Duome & Watchdog Service (src/services/profile.mjs)

import { api, UA, jwtExp } from '../core/client.mjs';

export function extractSkillId(u) {
  const sections = u?.currentCourse?.pathSectioned || [];
  for (const sec of sections) {
    for (const unit of sec.units || []) {
      for (const lvl of unit.levels || []) {
        const sid = lvl.pathLevelMetadata?.skillId || lvl.pathLevelClientData?.skillId;
        if (sid) return sid;
      }
    }
  }
  return null;
}

export function normalizeAvatar(picture) {
  if (!picture) return 'https://simg-ssl.duolingo.com/avatar/default_2/medium';
  let url = String(picture);
  if (url.startsWith('//')) url = 'https:' + url;
  if (!url.endsWith('/xlarge') && !url.endsWith('/large') && !url.endsWith('/medium') && !url.includes('default')) {
    url += '/xlarge';
  }
  return url;
}

export function parseCreationTs(u) {
  const candidates = [u?.creationDate, u?.trackingProperties?.creation_date_new, u?.trackingProperties?.creation_date];
  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) {
      // Jika sudah dalam milidetik (> 1e11), ubah ke detik
      const sec = num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
      const d = new Date(sec * 1000);
      if (!Number.isNaN(d.getTime())) return sec;
    }
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms) && ms > 0) return Math.floor(ms / 1000);
    }
  }
  return null;
}

export async function profile(jwt, sub, { extended = false } = {}) {
  const baseFields =
    'id,username,name,fromLanguage,learningLanguage,streak,totalXp,level,' +
    'numFollowers,numFollowing,gems,creationDate,streakData,picture,hasPlus,trackingProperties,courses';
  const extFields = extended
    ? baseFields + ',currentCourse{pathSectioned{units{levels{pathLevelMetadata{skillId},pathLevelClientData{skillId}}}}}'
    : baseFields;

  const u = await api(jwt, `/2017-06-30/users/${sub}?fields=${encodeURIComponent(extFields)}`);
  const courses = (u.courses || []).filter(c => c.learningLanguage);
  const creationTs = parseCreationTs(u);
  const skillId = extractSkillId(u);
  const avatar = normalizeAvatar(u.picture);

  let creationDateIso = null;
  if (creationTs) {
    try {
      creationDateIso = new Date(creationTs * 1000).toISOString().slice(0, 10);
    } catch {
      creationDateIso = null;
    }
  }

  return {
    ...u,
    courses: (u.courses || []).map(c => ({
      id: c.id,
      title: c.title || `${c.fromLanguage} -> ${c.learningLanguage}`,
      fromLanguage: c.fromLanguage,
      learningLanguage: c.learningLanguage,
      xp: c.xp ?? 0,
      crowns: c.crowns ?? 0,
    })),
    creationTs,
    creationDateIso,
    skillId,
    avatar,
  };
}

export async function switchActiveCourse(jwt, sub, { fromLanguage, learningLanguage }) {
  if (!fromLanguage || !learningLanguage) {
    throw new Error('fromLanguage dan learningLanguage dibutuhkan');
  }
  await api(jwt, `/2017-06-30/users/${sub}`, {
    method: 'PATCH',
    body: JSON.stringify({ fromLanguage, learningLanguage }),
  }).catch(() => {});
  return { from: fromLanguage, learning: learningLanguage };
}

export function pickCourse(u, prefer) {
  if (prefer && (prefer.learning || prefer.from)) {
    const hit = (u.courses || []).find(
      c => (prefer.learning && c.learningLanguage === prefer.learning) ||
           (prefer.from && c.fromLanguage === prefer.from),
    );
    if (hit) return { learning: hit.learningLanguage, from: hit.fromLanguage };
  }
  if (u.learningLanguage && u.fromLanguage) {
    return { learning: u.learningLanguage, from: u.fromLanguage };
  }
  const c = (u.courses || [])[0];
  if (!c) throw new Error('akun tidak punya course aktif');
  return { learning: c.learningLanguage, from: c.fromLanguage };
}

export function todayIn(tz = 'Asia/Jakarta') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function streakView(u, tz) {
  const sd = u.streakData || {};
  const cur = sd.currentStreak || {};
  const zone = tz || sd.updatedTimeZone || 'Asia/Jakarta';
  const today = todayIn(zone);
  return {
    length: cur.length ?? u.streak ?? 0,
    lastExtended: cur.lastExtendedDate || null,
    startDate: cur.startDate || null,
    longest: sd.longestStreak?.length ?? 0,
    xpGoal: sd.xpGoal ?? null,
    totalXp: u.totalXp ?? null,
    zone,
    today,
    doneToday: cur.lastExtendedDate === today,
  };
}

// ── Privacy Settings (DuoHacker v2.6) ──
export async function getPrivacy(jwt, sub) {
  const d = await api(jwt, `/2023-05-23/users/${sub}/privacy-settings?fields=privacySettings`);
  const settings = d.privacySettings || [];
  const socialDisabled = settings.some(
    s => (s.id === 'DISABLE_SOCIAL' || s.settingName === 'DISABLE_SOCIAL') && s.enabled === true,
  );
  return {
    isPrivate: socialDisabled,
    status: socialDisabled ? 'PRIVATE' : 'PUBLIC',
    raw: settings,
  };
}

export async function setPrivacy(jwt, sub, makePrivate) {
  await api(jwt, `/2023-05-23/users/${sub}/privacy-settings?fields=privacySettings`, {
    method: 'PATCH',
    body: JSON.stringify({ DISABLE_SOCIAL: Boolean(makePrivate) }),
  });
  return getPrivacy(jwt, sub);
}

// ── Family Plan Superlink Checker (DuoHacker v2.6) ──
export async function checkSuperlink(jwt, input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Masukkan URL atau ID Superlink terlebih dahulu');
  const id = raw.includes('/family-plan/')
    ? raw.split('/family-plan/')[1].split(/[?#/\s]/)[0]
    : raw.split(/[?#/\s]/).filter(Boolean).pop();

  try {
    const data = await api(jwt, `/2023-05-23/family-plan/invite/${encodeURIComponent(id)}`);
    if (data && data.inviter) {
      return {
        valid: true,
        id,
        inviter: data.inviter.name || data.inviter.username || 'Unknown',
        username: data.inviter.username || null,
        raw: data,
      };
    }
    return { valid: false, id, reason: 'Respon tidak memiliki data inviter', raw: data };
  } catch (e) {
    return { valid: false, id, status: e.status || 0, reason: e.message };
  }
}

// ── Duome Activity History Proxy (DuoHacker v2.6) ──
export async function fetchDuomeActivity(userId) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('User ID dibutuhkan untuk cek riwayat Duome');

  const res = await fetch('https://duome.eu/aggiorna.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: `who=${encodeURIComponent(uid)}`,
    signal: AbortSignal.timeout(12_000),
  });

  const text = await res.text();
  if (!text || text.trim() === '') {
    return { userId: uid, events: [], raw: null, note: 'Profil publik tidak ditemukan atau kosong di Duome' };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { userId: uid, events: [], raw: text.slice(0, 2000), note: 'Format respon Duome bukan JSON' };
  }

  let events = [];
  if (data && data.language_data) {
    const langKey = Object.keys(data.language_data)[0];
    if (langKey && Array.isArray(data.language_data[langKey]?.calendar)) {
      events = data.language_data[langKey].calendar;
    }
  } else if (Array.isArray(data?.calendar)) {
    events = data.calendar;
  }

  const normalized = events
    .filter(ev => ev && ev.datetime)
    .map(ev => ({
      datetime: ev.datetime,
      iso: new Date(ev.datetime).toISOString(),
      improvement: ev.improvement ?? 0,
      eventType: ev.event_type || 'lesson',
    }))
    .sort((a, b) => b.datetime - a.datetime);

  return {
    userId: uid,
    count: normalized.length,
    totalXpLogged: normalized.reduce((s, e) => s + Number(e.improvement || 0), 0),
    events: normalized,
    raw: data,
  };
}

// ── Watchdog Health Verifier (--verify & /api/verify) ──
export async function verifyAccountHealth({ jwt, sub, tz = 'Asia/Jakarta', preferCourse }) {
  const issues = [];

  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    issues.push(`timezone tidak valid: ${tz}`);
  }

  const exp = jwtExp(jwt);
  const remMs = exp - Date.now();
  const remDays = Number((remMs / 86_400_000).toFixed(1));
  if (!exp || remMs <= 0) {
    issues.push(`JWT sudah kedaluwarsa (${exp ? new Date(exp).toISOString() : 'tanpa exp'})`);
  } else if (remMs < 86_400_000) {
    issues.push(`JWT hampir habis: sisa ${(remMs / 3600_000).toFixed(1)} jam`);
  }

  const hostChecks = [];
  for (const h of ['https://www.duolingo.com/', 'https://android-api.duolingo.com/']) {
    const t0 = Date.now();
    try {
      const r = await fetch(h, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
      hostChecks.push({ host: new URL(h).host, status: r.status, ms: Date.now() - t0 });
    } catch (e) {
      hostChecks.push({ host: new URL(h).host, status: 0, err: e.message, ms: Date.now() - t0 });
    }
  }

  const anyHostOk = hostChecks.some(h => h.status >= 200 && h.status < 500 && h.status !== 403);
  if (!anyHostOk) {
    issues.push(
      'semua host Duolingo gagal dihubungi: ' +
      hostChecks.map(h => `${h.host}=${h.status || h.err}`).join(', '),
    );
  }

  let u = null, course = null, sv = null;
  try {
    u = await profile(jwt, sub);
    course = pickCourse(u, preferCourse);
    sv = streakView(u, tz);
    if (u.streakData?.updatedTimeZone && u.streakData.updatedTimeZone !== tz) {
      issues.push(`tz config (${tz}) != tz profil (${u.streakData.updatedTimeZone})`);
    }
  } catch (e) {
    issues.push(`gagal baca profil/course: ${e.status || ''} ${e.message}`.trim());
  }

  return {
    ok: issues.length === 0,
    issues,
    sub,
    tz,
    jwtExpIso: exp ? new Date(exp).toISOString() : null,
    remDays,
    hostChecks,
    profile: u ? { username: u.username, course, streak: sv } : null,
  };
}
