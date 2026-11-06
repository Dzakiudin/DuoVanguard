// language: JavaScript (Node 18+ ESM)
// Layer: XP & Streak Farming Service (src/services/farming.mjs)
// Menggabungkan kontrak terverifikasi GLOBAL_PRACTICE (13 XP), UNIT_TEST (110 XP),
// Stories fr-en-le-passeport (hingga 499 XP), serta Streak Keeper & Safe/Normal Streak Backfill.

import { BASE, STORIES_HOST, api, externalApi, sleep, rnd } from '../core/client.mjs';
import { profile, pickCourse, streakView } from './profile.mjs';

export async function startSession(jwt, { from, learning, type = 'GLOBAL_PRACTICE', heartsLeft = 5 }) {
  return api(jwt, '/2023-05-23/sessions', {
    method: 'POST',
    body: JSON.stringify({
      challengeTypes: ['translate', 'select', 'form', 'listen', 'judge'],
      fromLanguage: from,
      learningLanguage: learning,
      type,
      heartsLeft,
      isFinal: false,
    }),
  });
}

// Body submit: echo mentah session + anotasi jawaban. Tidak ada properti tambahan.
export function buildSubmit(session, { heartsLeft = 5, minutes = 6, startTimeSec, endTimeSec } = {}) {
  const body = structuredClone(session);
  const now = Date.now();

  body.challenges = (body.challenges || []).map(ch => ({
    ...ch,
    correct: true,
    guess: '',
    id: '',
    solutionTranslation: '',
    challengeResponseTrackingProperties: {},
  }));

  body.startTime = startTimeSec ?? Math.floor((now - minutes * 60_000) / 1000);
  body.endTime = endTimeSec ?? Math.floor(now / 1000);
  body.heartsLeft = heartsLeft;
  body.failed = false;

  return body;
}

export async function completeSession(jwt, session, opts = {}) {
  return api(jwt, `/2023-05-23/sessions/${session.id}`, {
    method: 'PUT',
    headers: {
      'idempotency-key': session.id,
      Referer: `${BASE}/lesson`,
    },
    body: JSON.stringify(buildSubmit(session, opts)),
  });
}

export async function oneSession(jwt, { from, learning, minutes, fast = false }, log = () => {}) {
  const s = await startSession(jwt, { from, learning });
  const think = minutes ? minutes * 60_000 : rnd(240_000, 600_000);

  if (fast) {
    await sleep(rnd(800, 1800));
  } else {
    // Jeda wajar: orang tidak menyelesaikan 16 soal dalam 2 detik.
    await sleep(rnd(Math.floor(think * 0.15), Math.floor(think * 0.5)));
  }

  const r = await completeSession(jwt, s, { minutes: Math.round(think / 60_000) || 6 });
  const xp = r.xpGain ?? 0;
  log(`+${xp}xp  heartBonus=${r.heartBonus ?? 0}  session=${s.id}`);
  return { xp, resp: r, session: s, mode: 'safe' };
}

export async function grant(
  jwt,
  { from, learning, count, minutes, minGap = 60_000, maxGap = 180_000, fast = false, shouldStop = () => false },
  log = console.log,
) {
  let total = 0;
  let fail = 0;
  for (let i = 0; i < count; i++) {
    if (shouldStop()) {
      log('dihentikan oleh pengguna');
      break;
    }
    try {
      const { xp } = await oneSession(jwt, { from, learning, minutes, fast }, m => log(`[${i + 1}/${count}] ${m}`));
      total += xp;
      fail = 0;
    } catch (e) {
      fail++;
      log(`[${i + 1}/${count}] gagal ${e.status || ''}: ${e.message}`);
      if (e.status === 400 && e.data) log('body: ' + JSON.stringify(e.data).slice(0, 300));
      if (e.status === 401) throw new Error('jwt expired - isi ulang duo.config.json');
      if (e.status === 429) {
        log('429 rate-limit - berhenti, coba lagi nanti');
        break;
      }
      if (fail >= 3) {
        log('3 gagal berurutan - berhenti biar akun aman');
        break;
      }
    }
    if (i < count - 1 && !shouldStop()) await sleep(rnd(minGap, maxGap));
  }
  return total;
}

// ── Mode 2: Unit Test Session (~110 XP, DuoHacker v2.6) ──
export async function unitTestSession(
  jwt,
  { sub, from, learning, skillId, happyHourBonusXp = 10 },
  log = () => {},
) {
  let sid = skillId;
  if (!sid && sub) {
    const ext = await profile(jwt, sub, { extended: true });
    sid = ext.skillId;
  }
  if (!sid) {
    throw new Error('skillId tidak ditemukan di currentCourse untuk UNIT_TEST');
  }

  const sess = await api(jwt, '/2017-06-30/sessions', {
    method: 'POST',
    body: JSON.stringify({
      challengeTypes: [],
      fromLanguage: from,
      learningLanguage: learning,
      type: 'UNIT_TEST',
      skillIds: [sid],
    }),
  });

  const now = Math.floor(Date.now() / 1000);
  const r = await api(jwt, `/2017-06-30/sessions/${sess.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      id: sess.id,
      metadata: sess.metadata,
      type: 'UNIT_TEST',
      fromLanguage: from,
      learningLanguage: learning,
      challenges: [],
      adaptiveChallenges: [],
      sessionExperimentRecord: [],
      experiments_with_treatment_contexts: [],
      adaptiveInterleavedChallenges: [],
      sessionStartExperiments: [],
      trackingProperties: [],
      ttsAnnotations: [],
      heartsLeft: 0,
      startTime: now,
      enableBonusPoints: true,
      endTime: now + 60,
      failed: false,
      maxInLessonStreak: 9,
      shouldLearnThings: true,
      hasBoost: true,
      happyHourBonusXp,
      pathLevelSpecifics: { unitIndex: 0 },
    }),
  });

  const xp = r.xpGain ?? 110;
  log(`+${xp}xp  [UNIT_TEST]  session=${sess.id}`);
  return { xp, resp: r, session: sess, mode: 'unittest' };
}

// ── Mode 3: Story Session (fr-en-le-passeport, up to 499 XP, Duolingo PRO 3.1 & DuoHacker v2.6) ──
export async function storySession(
  jwt,
  { from, learning, storySlug = 'fr-en-le-passeport', happyHourBonusXp = 449 },
  log = () => {},
) {
  const now = Math.floor(Date.now() / 1000);
  const bonus = Math.max(0, Math.min(469, Number(happyHourBonusXp ?? 449)));
  const r = await externalApi(jwt, `${STORIES_HOST}/api2/stories/${storySlug}/complete`, {
    method: 'POST',
    body: JSON.stringify({
      awardXp: true,
      completedBonusChallenge: true,
      fromLanguage: from,
      learningLanguage: learning || 'en',
      hasXpBoost: false,
      illustrationFormat: 'svg',
      isFeaturedStoryInPracticeHub: true,
      isLegendaryMode: true,
      isV2Redo: false,
      isV2Story: false,
      masterVersion: true,
      maxScore: 0,
      score: 0,
      happyHourBonusXp: bonus,
      startTime: now - rnd(45, 75),
      endTime: now,
    }),
  });

  const xp = r.xpGain ?? (30 + bonus);
  log(`+${xp}xp  [STORY:${storySlug}]`);
  return { xp, resp: r, mode: 'story' };
}

// ── Unified XP Farming Loop (supports safe | unittest | story | smart) ──
export async function farmXpLoop(
  jwt,
  {
    sub,
    from,
    learning,
    mode = 'safe', // 'safe' | 'unittest' | 'story' | 'smart'
    count = 1,
    targetXp = 0,
    delayMs = 1500,
    fast = true,
    minutes = 6,
    shouldStop = () => false,
    onProgress = () => {},
  },
  log = console.log,
) {
  let totalXp = 0;
  let lessons = 0;
  let fails = 0;
  let cachedSkillId = null;

  if ((mode === 'unittest' || mode === 'smart') && sub) {
    try {
      const ext = await profile(jwt, sub, { extended: true });
      cachedSkillId = ext.skillId;
    } catch {
      // abaikan, fallback ke mode lain jika gagal
    }
  }

  const maxLoops = targetXp > 0 ? Math.min(200, Math.ceil(targetXp / 13) + 5) : Math.max(1, count);

  for (let i = 0; i < maxLoops; i++) {
    if (shouldStop()) {
      log('Farming XP dihentikan pengguna.');
      break;
    }
    if (targetXp > 0 && totalXp >= targetXp) {
      log(`Target XP tercapai: +${totalXp} XP (${lessons} sesi).`);
      break;
    }

    try {
      let res;
      const prefix = targetXp > 0 ? `[+${totalXp}/${targetXp}xp]` : `[${i + 1}/${maxLoops}]`;
      const stepLog = m => log(`${prefix} ${m}`);

      if (mode === 'story') {
        const rem = targetXp > 0 ? Math.max(0, targetXp - totalXp - 30) : 469;
        res = await storySession(jwt, { from, learning, happyHourBonusXp: Math.min(469, rem) }, stepLog);
      } else if (mode === 'unittest') {
        res = await unitTestSession(jwt, { sub, from, learning, skillId: cachedSkillId }, stepLog);
      } else if (mode === 'smart') {
        try {
          const rem = targetXp > 0 ? Math.max(0, targetXp - totalXp - 30) : 449;
          res = await storySession(jwt, { from, learning, happyHourBonusXp: Math.min(469, rem) }, stepLog);
        } catch {
          try {
            res = await unitTestSession(jwt, { sub, from, learning, skillId: cachedSkillId }, stepLog);
          } catch {
            res = await oneSession(jwt, { from, learning, minutes, fast: true }, stepLog);
          }
        }
      } else {
        res = await oneSession(jwt, { from, learning, minutes, fast }, stepLog);
      }

      const gained = Number(res.xp || 0);
      totalXp += gained;
      lessons++;
      fails = 0;
      onProgress({ totalXp, gained, lessons, mode: res.mode });
    } catch (e) {
      fails++;
      log(`Gagal sesi ${i + 1}: ${e.status || ''} ${e.message}`);
      if (e.status === 401) throw e;
      if (e.status === 429) {
        log('429 Rate Limit - farming dihentikan.');
        break;
      }
      if (fails >= 3) {
        log('3x gagal berturut-turut - farming dihentikan demi keamanan akun.');
        break;
      }
    }

    if (i < maxLoops - 1 && !shouldStop() && !(targetXp > 0 && totalXp >= targetXp)) {
      await sleep(Math.max(300, Number(delayMs) || 1500));
    }
  }

  return { totalXp, lessons };
}

// ── Streak Farming (Keeper, Safe Account-Age Backfill, Normal Backfill) ──
export async function farmStreak(
  jwt,
  {
    sub,
    mode = 'keeper', // 'keeper' | 'safe' | 'backfill'
    days = 1,
    tz = 'Asia/Jakarta',
    preferCourse,
    delayMs = 1500,
    shouldStop = () => false,
    onProgress = () => {},
  },
  log = console.log,
) {
  const u = await profile(jwt, sub);
  const course = pickCourse(u, preferCourse);
  const sv = streakView(u, tz);

  if (mode === 'keeper') {
    if (sv.doneToday) {
      log(`Streak hari ini (${sv.today}) sudah terjaga: ${sv.length} hari.`);
      return { gainedStreak: 0, streak: sv.length, doneToday: true };
    }
    log(`Menjaga streak hari ini (${sv.today}) untuk ${u.username}...`);
    const { xp } = await oneSession(jwt, { ...course, fast: true }, log);
    const after = await profile(jwt, sub);
    const sv2 = streakView(after, tz);
    onProgress({ gainedStreak: sv2.length - sv.length, streak: sv2.length, xp });
    log(`Selesai! +${xp} XP | Streak: ${sv.length} -> ${sv2.length}`);
    return { gainedStreak: Math.max(0, sv2.length - sv.length), streak: sv2.length, doneToday: sv2.doneToday, xp };
  }

  // Safe atau Normal Backfill (DuoHacker v2.6: mundur per 86400 detik dari startDate)
  const creationTs = u.creationTs || 0;
  const nowSec = Math.floor(Date.now() / 1000);

  if (mode === 'safe') {
    if (!creationTs) {
      throw new Error('Tanggal pembuatan akun (creationDate) tidak ditemukan untuk Safe Streak.');
    }
    const maxPossibleDays = Math.floor((nowSec - creationTs) / 86400);
    if (sv.length >= maxPossibleDays) {
      log(`Batas aman tercapai! Streak saat ini (${sv.length}) sudah sesuai umur akun (${maxPossibleDays} hari sejak ${u.creationDateIso}).`);
      return { gainedStreak: 0, streak: sv.length, maxPossibleDays };
    }
    log(`Safe Streak aktif: umur akun maks ${maxPossibleDays} hari (dibuat ${u.creationDateIso}), streak sekarang ${sv.length}.`);
  }

  let farmTimestamp = sv.startDate
    ? Math.floor(new Date(sv.startDate).getTime() / 1000) - 86400
    : nowSec - 86400;

  const targetDays = Math.max(1, Math.min(30, Number(days) || 1));
  let gained = 0;

  for (let i = 0; i < targetDays; i++) {
    if (shouldStop()) {
      log('Farming streak dihentikan pengguna.');
      break;
    }

    if (mode === 'safe' && creationTs && farmTimestamp < creationTs) {
      log(`Berhenti: tanggal target (${new Date(farmTimestamp * 1000).toISOString().slice(0, 10)}) melewati tanggal pembuatan akun (${u.creationDateIso})!`);
      break;
    }

    const targetDateStr = new Date(farmTimestamp * 1000).toISOString().slice(0, 10);
    try {
      const sess = await api(jwt, '/2017-06-30/sessions', {
        method: 'POST',
        body: JSON.stringify({
          challengeTypes: [],
          fromLanguage: course.from,
          learningLanguage: course.learning,
          type: 'GLOBAL_PRACTICE',
        }),
      });

      await api(jwt, `/2017-06-30/sessions/${sess.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          id: sess.id,
          metadata: sess.metadata,
          type: 'GLOBAL_PRACTICE',
          fromLanguage: course.from,
          learningLanguage: course.learning,
          challenges: [],
          adaptiveChallenges: [],
          sessionExperimentRecord: [],
          experiments_with_treatment_contexts: [],
          adaptiveInterleavedChallenges: [],
          sessionStartExperiments: [],
          trackingProperties: [],
          ttsAnnotations: [],
          heartsLeft: 0,
          startTime: farmTimestamp,
          enableBonusPoints: false,
          endTime: farmTimestamp + 60,
          failed: false,
          maxInLessonStreak: 9,
          shouldLearnThings: true,
        }),
      });

      gained++;
      farmTimestamp -= 86400;
      log(`[${i + 1}/${targetDays}] +1 Streak Backfill (${targetDateStr})`);
      onProgress({ gainedStreak: gained, targetDate: targetDateStr });
    } catch (e) {
      log(`Gagal backfill tanggal ${targetDateStr}: ${e.status || ''} ${e.message}`);
      if (e.status === 401) throw e;
      if (e.status === 429) break;
    }

    if (i < targetDays - 1 && !shouldStop()) {
      await sleep(Math.max(400, Number(delayMs) || 1200));
    }
  }

  const after = await profile(jwt, sub);
  const sv2 = streakView(after, tz);
  return { gainedStreak: gained, streak: sv2.length, doneToday: sv2.doneToday };
}
