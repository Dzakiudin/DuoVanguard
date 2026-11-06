// language: JavaScript (Node 18+ ESM)
// Layer: Gems, Reward Bundles & Free Item Shop Service (src/services/economy.mjs)
// Menggabungkan kontrak terverifikasi rewardBundles + shop-items dengan katalog
// kategori & ikon resmi dari DuoHacker v2.6 serta Super Trial (immersive_subscription).

import { api, sleep, rnd } from '../core/client.mjs';

export const SHOP_ICONS = {
  boost: 'https://d35aaqx5ub95lt.cloudfront.net/images/icons/399e4296a3db21ce5edffc0d00e1276b.svg',
  heart: 'https://d35aaqx5ub95lt.cloudfront.net/images/hearts/f501dad6bee0ffc2d1be9bcd32cde3fd.svg',
  freeze: 'https://d35aaqx5ub95lt.cloudfront.net/images/Paths/9d62b2d5a4bc1e6d2c1b4c8e2a3d4f5a.svg',
  gem: 'https://d35aaqx5ub95lt.cloudfront.net/images/gems/45c14e05be9c1af1d7d0b54c6eed7eee.svg',
  super: 'https://d35aaqx5ub95lt.cloudfront.net/images/super/2e50c3e8358914df5285dc8cf45d0b4c.svg',
  default: 'https://d35aaqx5ub95lt.cloudfront.net/images/shop/9a52b1f29a9e5b3f8d7c6e5a4b3c2d1e.svg',
};

export function categorizeShopItem(item) {
  const id = String(item.id || item.itemName || '').toLowerCase();
  const type = String(item.type || '').toLowerCase();

  let category = 'Misc & Collectibles';
  let icon = SHOP_ICONS.default;

  if (id.includes('xp_boost') || id.includes('boost')) {
    category = 'XP Boosts';
    icon = SHOP_ICONS.boost;
  } else if (id.includes('heart') || id.includes('health')) {
    category = 'Hearts & Health';
    icon = SHOP_ICONS.heart;
  } else if (id.includes('streak') || id.includes('freeze') || id.includes('repair')) {
    category = 'Streak & Freezes';
    icon = SHOP_ICONS.freeze;
  } else if (id.includes('gem')) {
    category = 'Gems & Currency';
    icon = SHOP_ICONS.gem;
  } else if (id.includes('immersive') || id.includes('super') || id.includes('subscription')) {
    category = 'Free Trials';
    icon = SHOP_ICONS.super;
  } else if (type === 'outfit' || id.includes('champagne') || id.includes('formal') || id.includes('outfit')) {
    category = 'Outfits';
    icon = SHOP_ICONS.default;
  }

  return {
    id: item.id || item.itemName,
    itemName: item.itemName || item.id,
    name: item.localizedName || item.name || item.itemName || item.id,
    description: item.localizedDescription || item.description || `Type: ${item.type || 'Item'}`,
    price: item.price ?? item.cost ?? 0,
    currencyType: item.currencyType || 'GEMS',
    type: item.type || 'item',
    category,
    icon,
    productId: item.productId || null,
  };
}

export async function gemCount(jwt, sub) {
  const d = await api(jwt, `/2023-05-23/users/${sub}?fields=gemsConfig`);
  return d.gemsConfig?.gems ?? 0;
}

export async function rewards(jwt, sub) {
  const d = await api(jwt, `/2023-05-23/users/${sub}?fields=` + encodeURIComponent('rewardBundles{rewards}'));
  const rows = [];
  for (const b of d.rewardBundles || []) {
    for (const r of b.rewards || []) {
      rows.push({
        bundle: b.id,
        bundleType: b.rewardBundleType,
        id: r.id,
        consumed: !!r.consumed,
        type: r.rewardType || r.type,
        currency: r.currency,
        amount: r.amount,
        items: r.items || [],
        isAdReward: !!r.isAdReward,
      });
    }
  }
  return rows;
}

export async function unclaimedRewards(jwt, sub, { all = false } = {}) {
  const list = await rewards(jwt, sub);
  return list.filter(r => {
    if (r.consumed) return false;
    if (!all && !/^SKILL_COMPLETION(_BALANCED)?-/.test(String(r.id || ''))) return false;
    return true;
  });
}

export async function claimReward(jwt, sub, rewardId, { from, learning }) {
  await api(jwt, `/2023-05-23/users/${sub}/rewards/${encodeURIComponent(rewardId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ consumed: true, fromLanguage: from, learningLanguage: learning }),
  });
  return true;
}

export async function claimRewards(
  jwt,
  {
    sub,
    course,
    ids = null,
    all = false,
    maxClaims = 60,
    batchSize = 10,
    minGap = 1200,
    maxGap = 2200,
    shouldStop = () => false,
    onProgress = () => {},
    log = console.log,
  } = {},
) {
  const fresh = (await rewards(jwt, sub)).filter(r => !r.consumed);
  const idSet = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const target = fresh
    .filter(r => {
      if (idSet) return idSet.has(r.id);
      return (all || r.currency === 'GEMS') && Number(r.amount) > 0;
    })
    .sort((a, b) => Number(a.amount || 0) - Number(b.amount || 0));

  if (!target.length) {
    log('tidak ada reward untuk diklaim');
    return { claimed: 0, total: 0, delta: 0, stopped: 'kosong' };
  }

  const queue = target.slice(0, Math.max(0, maxClaims));
  if (queue.length < target.length) log(`reward ${target.length}, dibatasi ${queue.length} (maxClaims)`);

  const before = await gemCount(jwt, sub);
  let ok = 0;
  let attempted = 0;
  let stopped = null;

  for (let i = 0; i < queue.length && !stopped; i += batchSize) {
    if (shouldStop()) {
      stopped = 'dihentikan';
      break;
    }
    const batch = queue.slice(i, i + batchSize);
    const batchBefore = await gemCount(jwt, sub);

    for (const r of batch) {
      if (shouldStop()) {
        stopped = 'dihentikan';
        break;
      }
      attempted++;
      try {
        await claimReward(jwt, sub, r.id, course);
        ok++;
        log(`  +${String(r.amount).padStart(4)} ${r.currency || 'ITEM'} ${r.type}`);
        onProgress({ claimed: ok, total: queue.length, lastAmount: r.amount });
      } catch (e) {
        log(`  gagal ${e.status || ''} ${r.id} ${JSON.stringify(e.data || '').slice(0, 120)}`);
        if (e.status === 401) throw new Error('jwt expired - isi ulang duo.config.json');
        if (e.status === 429) {
          log('429 rate-limit - berhenti');
          stopped = '429';
          break;
        }
      }
      await sleep(rnd(minGap, maxGap));
    }

    if (stopped) break;

    await sleep(1500);
    const batchAfter = await gemCount(jwt, sub);
    const batchDelta = batchAfter - batchBefore;
    log(`  batch ${i + batch.length}/${queue.length} delta ${batchDelta}`);
    if (batchDelta <= 0 && !all) {
      log('batch tanpa delta gem - berhenti');
      stopped = 'tanpa-delta';
      break;
    }
  }

  await sleep(1500);
  const after = await gemCount(jwt, sub);
  log(
    `gems ${before} -> ${after} (delta ${after - before}) | ` +
    `klaim ${ok}/${queue.length}${stopped ? ` (${stopped})` : ''}`,
  );
  return { claimed: ok, total: target.length, attempted, delta: after - before, before, after, stopped };
}

export async function claimAllRewards(
  jwt,
  sub,
  course,
  { all = false, gapMs = 1200, maxClaims = 60, log = console.log } = {},
) {
  return claimRewards(jwt, {
    sub,
    course,
    all,
    maxClaims,
    minGap: gapMs,
    maxGap: Math.floor(gapMs * 1.8),
    log,
  });
}

export async function shopItems(jwt) {
  const d = await api(jwt, '/2023-05-23/shop-items');
  const rawList = Array.isArray(d) ? d : (d.shopItems || []);
  const enriched = rawList
    .filter(it => it && (it.id || it.itemName))
    .map(it => ({ ...it, ...categorizeShopItem(it) }));

  // Tambahkan item spesial Super Trial 3 Hari dari DuoHacker v2.6 & Duolingo PRO 3.1 jika belum ada
  if (!enriched.some(it => it.id === 'immersive_subscription')) {
    enriched.unshift(
      categorizeShopItem({
        id: 'immersive_subscription',
        itemName: 'immersive_subscription',
        name: 'Free 3-Day Super Trial',
        description: 'Klaim uji coba gratis Duolingo Super / Immersive selama 3 hari',
        type: 'special_trial',
        price: 0,
        currencyType: 'FREE',
        productId: 'com.duolingo.immersive_free_trial_subscription',
      }),
    );
  }
  return enriched;
}

export async function buyItem(jwt, { sub, course, itemName, isFree = true, productId = null, log = console.log }) {
  // Kontrak terverifikasi:
  // Regular shop items WAJIB hanya mengirim {itemName, isFree, learningLanguage}.
  // Khusus immersive_subscription (Super Trial), kirim productId seperti di DuoHacker/PRO.
  const learningLanguage = course?.learning || 'ja';

  if (itemName === 'immersive_subscription' || productId) {
    const pids = productId
      ? [productId]
      : ['com.duolingo.immersive_free_trial_subscription', 'com.duolingo.super_free_trial_subscription'];
    let lastErr;
    for (const pid of pids) {
      try {
        const r = await api(jwt, `/2017-06-30/users/${sub}/shop-items`, {
          method: 'POST',
          body: JSON.stringify({
            itemName: 'immersive_subscription',
            productId: pid,
            isFree: true,
            learningLanguage,
            fromLanguage: course?.from || 'id',
          }),
        });
        log(`beli Super Trial (${pid}) -> terkirim`);
        return r;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Super Trial ditolak untuk akun ini');
  }

  const r = await api(jwt, `/2017-06-30/users/${sub}/shop-items`, {
    method: 'POST',
    body: JSON.stringify({ itemName, isFree, learningLanguage }),
  });

  if (r && r.purchaseId) {
    const dur = r.remainingEffectDurationInSeconds;
    log(`beli ${itemName} -> ok price=${r.purchasePrice}${dur != null ? ` dur=${dur}s` : ''} id=${r.purchaseId}`);
    return r;
  }
  log(`beli ${itemName} -> ditolak server (tanpa purchaseId)`);
  return r;
}
