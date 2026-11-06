// language: JavaScript (Node 18+ ESM), file: autoserver.mjs
// CLI & Scheduled Watchdog / Streak Keeper
// Default              : jaga streak (1 session kalau hari ini belum ada aktivitas)
// --status             : cetak profil lengkap, streak, gems, reward, privacy
// --verify             : cek kesehatan config, tz, exp JWT, host hidup, tulis duo.alert jika gagal
// --grant N            : N session XP farming (--xp-mode safe|unittest|story|smart)
// --gems / --claim-all : klaim reward bundle berisi gems
// --shop / --buy NAME  : daftar item shop / klaim item gratis (mis. xp_boost_15, immersive_subscription)
// --quests             : daily quest batch (default DRY; tambahkan --send untuk kirim nyata)
// --badges [MM/YYYY]   : klaim Monthly Badge spesifik atau tampilkan ringkasan badge
// --league [--farm]    : lihat posisi Leaderboard atau auto-farm menuju Rank #1
// --privacy [pub|priv] : lihat atau ubah status profil publik/privat
// --superlink <id|url> : cek validitas link undangan Family Plan

import fs from 'node:fs';
import {
  createAuthManager, saveState, profile, pickCourse, jwtExp, grant, oneSession, streakView,
  gemCount, rewards, claimRewards, shopItems, buyItem,
  verifyAccountHealth, getPrivacy, setPrivacy, checkSuperlink,
  farmXpLoop, getLeaderboard, autoLeagueFarm, writeAlert, clearAlert,
} from './duo-core.mjs';
import { autoQuests, questLoop, badgesCatalog, claimMonthlyBadges } from './gems.mjs';

const args = process.argv.slice(2);
const cfgArg = args.find(a => a.endsWith('.json')) || './duo.config.json';
const authMgr = createAuthManager(cfgArg);
const { cfgPath, statePath, alertPath } = authMgr.paths;

const statusOnly = args.includes('--status');
const verifyFlag = args.includes('--verify');
const grantFlag = args.indexOf('--grant');
const grantN = grantFlag >= 0 ? Math.min(20, Math.max(1, Number(args[grantFlag + 1] || 1) || 1)) : 0;
const xpModeIdx = args.indexOf('--xp-mode');
const xpMode = xpModeIdx >= 0 ? (args[xpModeIdx + 1] || 'safe') : 'safe';
const gemsFlag = args.includes('--gems');
const claimAll = args.includes('--claim-all');
const questsFlag = args.includes('--quests');
const badgesFlag = args.indexOf('--badges');
const leagueFlag = args.includes('--league');
const privacyIdx = args.indexOf('--privacy');
const superlinkIdx = args.indexOf('--superlink');
const shopFlag = args.includes('--shop');
const buyFlag = args.indexOf('--buy');
const buyName = buyFlag >= 0 ? args[buyFlag + 1] : null;

if (!fs.existsSync(cfgPath)) {
  const err = `config tidak ada: ${cfgPath}`;
  if (verifyFlag) writeAlert(err, alertPath);
  console.error(err);
  process.exit(1);
}

const run = () =>
  authMgr.withAuth(async ({ jwt, sub, cfg, state }) => {
    if (!sub) throw new Error('sub tidak ditemukan di JWT');
    const tz = cfg.timezone || 'Asia/Jakarta';

    if (verifyFlag) {
      const rep = await verifyAccountHealth({ jwt, sub, tz, preferCourse: cfg.course });
      console.log(`verify    : ${rep.ok ? 'OK' : 'GAGAL'}`);
      console.log(`config    : ${cfgPath} (sub=${sub})`);
      console.log(`tz        : ${tz}${rep.profile ? ` (hari ini ${rep.profile.streak.today})` : ''}`);
      console.log(`jwt exp   : ${rep.jwtExpIso || '-'} (sisa ${rep.remDays} hari)`);
      for (const h of rep.hostChecks) {
        console.log(`host      : ${h.host.padEnd(24)} -> ${h.status || h.err} (${h.ms}ms)`);
      }
      if (rep.profile) {
        const { username, course, streak } = rep.profile;
        console.log(`profil    : ${username} | ${course.from}->${course.learning} | streak=${streak.length} (${streak.doneToday ? 'doneToday' : 'belum'})`);
      }
      if (!rep.ok) {
        writeAlert(rep.issues, alertPath);
        for (const is of rep.issues) console.error(`! ${is}`);
        console.error(`alert ditulis ke: ${alertPath}`);
        process.exit(1);
      }
      clearAlert(alertPath);
      return;
    }

    const u = await profile(jwt, sub);
    const course = pickCourse(u, cfg.course);
    const sv = streakView(u, tz);

    if (statusOnly) {
      const [g, fresh, priv] = await Promise.all([
        gemCount(jwt, sub),
        rewards(jwt, sub).then(list => list.filter(r => !r.consumed)),
        getPrivacy(jwt, sub).catch(() => ({ status: 'UNKNOWN' })),
      ]);
      const pending = fresh.filter(r => r.currency === 'GEMS' && Number(r.amount) > 0);
      console.log(`user      : ${u.username} (${u.name || '-'}) | id=${u.id}`);
      console.log(`dibuat    : ${u.creationDateIso || '-'}`);
      console.log(`privasi   : ${priv.status} | plus=${Boolean(u.hasPlus)}`);
      console.log(`streak    : ${sv.length} (terpanjang ${sv.longest})`);
      console.log(`terakhir  : ${sv.lastExtended || '-'}  ${sv.doneToday ? '[hari ini sudah]' : '[belum hari ini]'}`);
      console.log(`course    : ${course.from} -> ${course.learning}`);
      console.log(`total xp  : ${sv.totalXp}`);
      console.log(`gems      : ${g}`);
      console.log(`reward    : ${fresh.length} belum diklaim (${pending.length} berisi gems, ${pending.reduce((s, r) => s + Number(r.amount), 0)} gem)`);
      console.log(`zona waktu: ${sv.zone} (sekarang ${sv.today})`);
      console.log(`jwt exp   : ${new Date(state.jwtExp || jwtExp(jwt)).toISOString()}`);
      return;
    }

    if (privacyIdx >= 0) {
      const arg = (args[privacyIdx + 1] || '').toLowerCase();
      if (arg === 'private' || arg === 'priv' || arg === 'on') {
        const res = await setPrivacy(jwt, sub, true);
        console.log(`privasi diubah -> ${res.status}`);
      } else if (arg === 'public' || arg === 'pub' || arg === 'off') {
        const res = await setPrivacy(jwt, sub, false);
        console.log(`privasi diubah -> ${res.status}`);
      } else {
        const res = await getPrivacy(jwt, sub);
        console.log(`privasi saat ini: ${res.status}`);
      }
      return;
    }

    if (superlinkIdx >= 0) {
      const target = args[superlinkIdx + 1];
      const res = await checkSuperlink(jwt, target);
      if (res.valid) {
        console.log(`VALID! Superlink [${res.id}] dari inviter: ${res.inviter}`);
      } else {
        console.log(`INVALID / EXPIRED [${res.id}]: ${res.reason}`);
      }
      return;
    }

    if (leagueFlag) {
      if (args.includes('--farm')) {
        await autoLeagueFarm(jwt, { sub, ...course, mode: xpMode }, console.log);
      } else {
        const lb = await getLeaderboard(jwt, sub);
        console.log(`liga      : ${lb.tierName} (${lb.active ? 'Aktif' : 'Belum Aktif'})`);
        if (lb.active) {
          console.log(`posisi    : #${lb.myRank || '-'} (${lb.myScore} XP) | #1: ${lb.topScore} XP | selisih ke #1: ${lb.xpToFirst} XP`);
          console.log(`batas aman: ~${lb.recommendedXpLimit} XP`);
          for (const r of lb.rankings.slice(0, 10)) {
            console.log(`  #${String(r.rank).padStart(2)}  ${String(r.score).padStart(6)} XP  ${r.displayName}${r.isMe ? '  <-- KAMU' : ''}`);
          }
        }
      }
      return;
    }

    if (gemsFlag || claimAll) {
      await claimRewards(jwt, { sub, course, all: claimAll });
      return;
    }

    if (shopFlag) {
      const items = await shopItems(jwt);
      for (const it of items) {
        const price = it.price ?? it.cost ?? '?';
        console.log(`[${it.category.padEnd(19)}] ${String(it.currencyType || '-').padEnd(5)} ${String(price).padStart(6)}  ${it.itemName || it.id} (${it.name})`);
      }
      return;
    }

    if (buyName) {
      await buyItem(jwt, { sub, course, itemName: buyName });
      return;
    }

    if (badgesFlag >= 0) {
      const nextArg = args[badgesFlag + 1];
      const send = args.includes('--send');
      if (nextArg && !nextArg.startsWith('--')) {
        if (!send) {
          console.log(`mode dry: tambahkan --send untuk klaim badge ${nextArg}`);
          return;
        }
        await claimMonthlyBadges(jwt, sub, { monthYear: nextArg, tz, creationTs: u.creationTs });
      } else if (args.includes('--all') && send) {
        await claimMonthlyBadges(jwt, sub, { tz, creationTs: u.creationTs });
      } else {
        const cat = await badgesCatalog(jwt, sub, { tz, creationTs: u.creationTs });
        const monthly = cat.items.filter(i => i.category === 'MONTHLY');
        const doneCount = monthly.filter(i => i.done).length;
        console.log(`monthly badges: ${doneCount}/${monthly.length} selesai (total katalog: ${cat.total} item)`);
        for (const b of monthly.slice(0, 12)) {
          console.log(`  ${b.done ? '[DONE]' : '[OPEN]'} ${b.goalId.padEnd(18)} ${String(b.progress).padStart(2)}/${String(b.threshold).padEnd(2)} ${b.title}${b.olderThanAccount ? ' [⚠️ >umur akun]' : ''}`);
        }
      }
      return;
    }

    if (questsFlag) {
      const loopFlag = args.includes('--loop');
      const allMetrics = args.includes('--quests-all');
      const dry = args.includes('--dry') || !args.includes('--send');
      const force = args.includes('--force');
      if (dry) console.log('mode dry: tambahkan --send untuk benar-benar mengirim');
      try {
        if (loopFlag) {
          await questLoop(jwt, sub, course, { tz, all: allMetrics, dry, force });
        } else {
          await autoQuests(jwt, sub, { tz, all: allMetrics, dry, force });
        }
      } catch (e) {
        if (e.status === 401) throw e;
        if (e.status === 429) {
          console.log('429 rate-limit - berhenti');
          return;
        }
        throw e;
      }
      return;
    }

    if (grantN > 0) {
      console.log(`grant ${grantN} session [mode=${xpMode}] (${course.from} -> ${course.learning})`);
      if (xpMode === 'safe') {
        const total = await grant(jwt, {
          ...course,
          count: grantN,
          minutes: cfg.lessonMinutes,
          minGap: cfg.minGapMs ?? 90_000,
          maxGap: cfg.maxGapMs ?? 240_000,
        });
        console.log(`selesai. total +${total}xp`);
      } else {
        const res = await farmXpLoop(
          jwt,
          { sub, ...course, mode: xpMode, count: grantN, delayMs: 2000 },
          console.log,
        );
        console.log(`selesai. total +${res.totalXp}xp (${res.lessons} sesi)`);
      }
      return;
    }

    if (sv.doneToday) {
      console.log(`streak sudah dijaga hari ini (${sv.today}) - streak=${sv.length}`);
      return;
    }

    console.log(`jaga streak ${sv.today} untuk ${u.username} (streak=${sv.length})`);
    const { xp } = await oneSession(jwt, { ...course, minutes: cfg.lessonMinutes }, console.log);

    const after = await profile(jwt, sub);
    const sv2 = streakView(after, tz);
    state.lastDay = sv2.lastExtended;
    state.lastStreak = sv2.length;
    saveState(state, statePath);

    if (sv2.doneToday) console.log(`ok. +${xp}xp  streak=${sv2.length}  (${sv2.lastExtended})`);
    else console.log(`xp +${xp} masuk, tapi streak belum tercatat (${sv2.lastExtended || '-'}) - cek manual`);
  });

run().catch(e => {
  if (verifyFlag) writeAlert(`${e.status || ''} ${e.message}`.trim(), alertPath);
  console.error('gagal:', e.status || '', e.message);
  if (e.data) console.error('body:', JSON.stringify(e.data).slice(0, 800));
  process.exit(1);
});
