// language: JavaScript (Node 18+ ESM)
// Layer: Leaderboard & Auto-League Service (src/services/leaderboard.mjs)
// Menggabungkan Leaderboard Viewer & Auto-League (DuoHacker v2.6) dengan
// Intelligent XP Warning Limit (Duolingo PRO 3.1).

import { LEADERBOARDS_HOST, externalApi, sleep } from '../core/client.mjs';
import { farmXpLoop } from './farming.mjs';

export const BOARD_IDS = [
  '4b668ba6-288d-4b78-81a3-7b213175ae2c', // Tournament Board
  '7d9f5dd1-8423-491a-91f2-2532052038ce', // Default League Board
];

export const LEAGUE_TIERS = [
  'Bronze', 'Silver', 'Gold', 'Sapphire', 'Ruby',
  'Emerald', 'Amethyst', 'Pearl', 'Obsidian', 'Diamond',
];

export async function getLeaderboard(jwt, sub) {
  let activeData = null;
  let usedBoardId = null;

  for (const boardId of BOARD_IDS) {
    try {
      const url = `${LEADERBOARDS_HOST}/leaderboards/${boardId}/users/${sub}?client_unlocked=true&_=${Date.now()}`;
      const d = await externalApi(jwt, url);
      if (d?.active?.cohort?.rankings?.length) {
        activeData = d;
        usedBoardId = boardId;
        break;
      }
    } catch {
      // lanjut ke boardId berikutnya
    }
  }

  if (!activeData || !activeData.active?.cohort?.rankings) {
    return {
      active: false,
      boardId: null,
      tier: null,
      tierName: 'Unranked / Belum Masuk Liga',
      myRank: null,
      myScore: 0,
      topScore: 0,
      xpToFirst: 0,
      recommendedXpLimit: 2000,
      rankings: [],
    };
  }

  const tier = activeData.tier ?? activeData.active?.tier ?? null;
  const tierName = tier != null && LEAGUE_TIERS[tier] ? `${LEAGUE_TIERS[tier]} League` : 'Active League';
  const rawRankings = activeData.active.cohort.rankings || [];

  const rankings = rawRankings.map((r, idx) => {
    const isMe = String(r.user_id) === String(sub);
    return {
      rank: idx + 1,
      userId: r.user_id,
      displayName: r.display_name || `User ${r.user_id}`,
      score: Number(r.score || 0),
      avatarUrl: r.avatar_url || 'https://simg-ssl.duolingo.com/avatar/default_2/medium',
      hasPlus: Boolean(r.has_plus),
      isMe,
    };
  });

  const me = rankings.find(r => r.isMe) || null;
  const top1 = rankings[0] || null;
  const myScore = me ? me.score : 0;
  const topScore = top1 ? top1.score : 0;
  const xpToFirst = me && me.rank > 1 ? Math.max(0, topScore - myScore + 10) : 0;

  // Duolingo PRO 3.1 Intelligent XP Warning Limit:
  // Rata-rata skor Top 5 dikurangi skor pengguna (minimal 2000 XP)
  const top5 = rankings.slice(0, 5);
  const avgTop5 = top5.length
    ? top5.reduce((s, u) => s + u.score, 0) / top5.length
    : 2000;
  const recommendedXpLimit = Math.max(2000, Math.round(avgTop5 - myScore));

  return {
    active: true,
    boardId: usedBoardId,
    tier,
    tierName,
    timeLeftMs: activeData.active?.time_left ? Number(activeData.active.time_left) * 1000 : null,
    myRank: me ? me.rank : null,
    myScore,
    topScore,
    xpToFirst,
    recommendedXpLimit,
    rankings,
  };
}

// ── Auto-League Farming Loop (Kejar Peringkat #1, DuoHacker v2.6) ──
export async function autoLeagueFarm(
  jwt,
  {
    sub,
    from,
    learning,
    mode = 'smart', // 'safe' | 'unittest' | 'story' | 'smart'
    maxIterations = 25,
    delayMs = 1500,
    shouldStop = () => false,
    onProgress = () => {},
  },
  log = console.log,
) {
  let totalXpGained = 0;
  let rounds = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (shouldStop()) {
      log('Auto-League dihentikan pengguna.');
      break;
    }

    const lb = await getLeaderboard(jwt, sub);
    if (!lb.active) {
      log('Akun belum masuk cohort Leaderboard minggu ini. Selesaikan 1 lesson terlebih dahulu.');
      return { active: false, totalXpGained, rounds };
    }

    log(`[Liga: ${lb.tierName}] Posisi #${lb.myRank || '?'} (${lb.myScore} XP) | #1: ${lb.topScore} XP`);

    if (lb.myRank === 1 && lb.myScore > (lb.rankings[1]?.score || 0)) {
      log(`Target tercapai! Kamu sudah berada di Peringkat #1 dengan ${lb.myScore} XP.`);
      return { active: true, reachedTop1: true, myRank: 1, myScore: lb.myScore, totalXpGained, rounds };
    }

    const stepRes = await farmXpLoop(
      jwt,
      {
        sub,
        from,
        learning,
        mode,
        count: 1,
        delayMs,
        shouldStop,
        onProgress: p => onProgress({ ...p, myRank: lb.myRank, xpToFirst: lb.xpToFirst }),
      },
      log,
    );

    totalXpGained += stepRes.totalXp;
    rounds++;
    await sleep(Math.max(800, Number(delayMs) || 1500));
  }

  const finalLb = await getLeaderboard(jwt, sub);
  return {
    active: finalLb.active,
    reachedTop1: finalLb.myRank === 1,
    myRank: finalLb.myRank,
    myScore: finalLb.myScore,
    totalXpGained,
    rounds,
  };
}
