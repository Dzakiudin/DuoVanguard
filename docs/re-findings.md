# RE findings — Duolingo web app reward/shop logic

Source: `https://d35aaqx5ub95lt.cloudfront.net/js/app-cfde5392.js` (1,127,937 bytes, saved as `ref/app.js`).
Reward block extracted to `ref/quest-reward-block.js`. Captured 2026-11-04, after `www.duolingo.com` started answering 200 again.

Evidence class: **Seen** for all code quotes and live HTTP results below.

## 1. Daily-quest reward selection runs client-side

```js
w = ({hasXpBoost, items, slotsCompleted, user}) => {
  for (const slot of slotsCompleted) {
    switch (slot) {
      case "DAILY": bundle = find(user, bf[0]); break;  // DAILY_QUEST_FIRST
      case "CORE":  bundle = find(user, bf[1]); break;  // DAILY_QUEST_SECOND
      case "HARD":  bundle = find(user, bf[2]); break;  // DAILY_QUEST_THIRD
    }
    const reward = C(bundle, {hasXpBoost, items, rewardsSoFar, user});
    if (reward) { rewardsSoFar.push(reward); out.push({reward, slotType: slot}); }
  }
}
```

`C(bundle)` dispatch by `rewardBundleType`:

| slot | bundle type | selection |
| --- | --- | --- |
| DAILY | `DAILY_QUEST_FIRST` | `L()` streak-freeze pick, else `T()` |
| CORE | `DAILY_QUEST_SECOND` | `T()` |
| HARD | `DAILY_QUEST_THIRD` | `L({ignoreProbability:true})`, else `P()` 15-min XP boost, else `T()` |

Helpers:

- `T = e => maxBy(e.rewards.filter(N), r => r.amount)[0]` — highest **gem** amount.
- `L = ...` — returns the `STREAK_FREEZE` item reward, only when all of: not already chosen in this batch, `!hasMaxStreakFreeze(streak.length)`, and probability gate `RB(items, user, ignoreProbability)`.
- `P = e => e.rewards.filter(r => "itemId" in r && r.itemId === ITEM_NAME_15_MIN)[0]`.
- `N = r => "currency" in r`, `O = r => "itemId" in r`, `D = r => O(r) && r.itemId === "STREAK_FREEZE"`, `F = r => "itemId" in r && Object.values(zL).includes(r.itemId)`.

So the claimed reward is chosen by the client and then sent by id. The server only consumes the id. Picking the maximum-gem reward is what the client itself does for the CORE slot.

## 2. Claim flow

```js
k = async ({dispatch, isZombieMode, rewards, user}) => {
  await Promise.all(rewards.map(r => consumeReward(user, r.id)));   // PATCH .../rewards/{id}
  rewards.some(r => F(r) || D(r)) && dispatch(refreshUser());
  rewards.length > 0 && S({isZombieMode, progress: rewards.length, user});
}

S = async ({progress, user}) =>
  sendBatchUpdate(user.id, {metricUpdates: [{metric: "QUESTS", quantity: progress}]},
                  now(), user.timezone);
```

Notes:

- Body key is **`metricUpdates`** (camelCase). Our client sends `metric_updates`; the server accepted it and progress advanced, but camelCase is the reference form.
- `QUESTS` delta equals the **number of rewards claimed in that batch**, not a fixed 1. Our `questBatch` sends a literal 1, which is conservative and valid.

## 3. Session → quest metrics (reference implementation)

Metric list, in order:

```
XP, LESSONS, NINETY_ACCURACY_LESSONS, PERFECT_LESSONS, QUESTS,
EIGHTY_ACCURACY_LESSONS, COMBO_XP, FIVE_CORRECT_IN_A_ROW, TEN_CORRECT_IN_A_ROW,
SPEAK_CHALLENGES, LISTEN_CHALLENGES, EXTEND_STREAK, START_STREAK, SECONDS_SPENT_LEARNING
```

Per-session derivation (`R`), with `accuracy = correct/challenges*100`:

- `XP`, `QUESTS` — **not** derived client-side; server reports XP, QUESTS comes from the reward-claim batch.
- `LESSONS` — `1`, unless the session is a `SectionTest`/`UnitTest` and `failed`.
- `NINETY_ACCURACY_LESSONS` — `1` if `accuracy >= 90`.
- `EIGHTY_ACCURACY_LESSONS` — `1` if `accuracy >= 80`.
- `PERFECT_LESSONS` — `1` if `accuracy >= 100`.
- `COMBO_XP` — `1` if `maxInLessonStreak` non-zero, quantity `CT(challenges.length, maxInLessonStreak)`.
- `FIVE_CORRECT_IN_A_ROW` / `TEN_CORRECT_IN_A_ROW` — `1` if `maxInLessonStreak >= 5` / `>= 10`.
- `SPEAK_CHALLENGES` / `LISTEN_CHALLENGES` — count of correct challenges whose type is in the speak/listen type sets.
- `EXTEND_STREAK` / `START_STREAK` — `1` if the session extended/started the streak.
- `SECONDS_SPENT_LEARNING` — `timeSpent`.

Second variant `P` uses `accuracy = score/maxScore*100` (story-style sessions) with the same rules.

## 4. Goal activity check

```js
if (goal.period.oneOff) { active = start <= now && now < end }
else if (goal.period.recurring) { ... start .. until, day arithmetic ... }
```

Matches the period-based selection implemented in `gems.mjs` (`autoQuests`). The client also hardcodes `2023_11_monthly_challenge` as the monthly goal id.

## 5. Free shop purchase — corrected

Real client call, when a lesson ends with no active XP boost:

```js
purchaseUserShopItem(ITEM_NAME_15_MIN, { isFree: true, learningLanguage })
```

Live verification (account 1266919054, course `ja`), body `{itemName:"xp_boost_15", isFree:true, learningLanguage:"ja"}`:

```json
{"purchaseId":"2990e29ae1f348116130366ba14c7124","purchaseDate":1793762955,
 "purchasePrice":0,"id":"xp_boost_15","itemName":"xp_boost_15",
 "remainingEffectDurationInSeconds":900,"expectedExpirationDate":1793763855}
```

- Purchase record **is** created (`users.shopItems`), price 0, 900 s effect.
- Repeat call returns the **same `purchaseId`** with a decreasing duration (868, 866) — idempotent while active, does not stack.
- The earlier "shop is a no-op" conclusion was wrong: it was caused by sending `consumed` and `fromLanguage` in the body. Those extra fields make the server answer `200` with an empty body and create nothing.

Items that stay unavailable with the same body:

| item | result |
| --- | --- |
| `streak_freeze_gift_free`, `duo_streak_freeze`, `society_streak_freeze` | `200` empty body, no purchase record |
| `friends_daily_gift` | `500` |

So streak freezes cannot be obtained through the free-purchase path. The reward-claim path (a `STREAK_FREEZE` item reward inside a chest) remains the only candidate, and freeze count is still not exposed by any user field.

## 6. Reward bundle types observed in the client

`SKILL_COMPLETION`, `DAILY_GOAL_DOUBLE`, `DAILY_QUEST_FIRST`, `DAILY_QUEST_SECOND`, `DAILY_QUEST_THIRD`, `FRIENDS_QUEST_GEMS`, `FRIENDS_QUEST_XP_BOOST`.

Client also optimistically applies `UPDATE_USER_GEMS` with the reward `amount`, i.e. the amount shown is client-trusted, but the authoritative balance is server-side (already confirmed: declared 680 → actual +327).

## 7. Chunk loading

`manifest-9fc0e81f.js` is a webpack runtime only; `app-cfde5392.js` resolves chunk names via `t.u`. Remaining shop/chest UI code lives in lazily loaded chunks, not yet enumerated.

## 8. goals-api batch semantics (measured)

- `POST /users/{sub}/progress/batch` accepts **both** `metricUpdates` (client form) and `metric_updates` (our form). Both returned `{"message":"SUCCESS"}` and advanced counters: LESSONS 92 → 93 → 94 on two consecutive sends.
- Metric progress inside `goals.progress[goalId].progress` is **aliased across goals**: every goal with metric `LESSONS` reported the same value (94), same for `XP`, `NINETY_ACCURACY_LESSONS`. There is no separate per-goal counter.
- Consequence: a delta must be computed as `max(threshold over active goals with that metric) - max(observed value)`. Computing it per goal and resending in a loop over-credits the shared counter. Observed overshoot during testing: XP counter 33 → 933, LESSONS → 94, NINETY → 60 after three sends of the same deltas.
- Quest metric counters are **separate from real XP**: `users.totalXp` stayed at 1,332,668 across all sends. Only quest progress moved.
- This account exposes **no** `DAILY_QUEST_*`, `SKILL_COMPLETION`, or `FRIENDS_QUEST` bundle types in `rewardBundles` (184 unconsumed rewards are chests/avatar skins only). Completing daily quests therefore produces no claimable reward row for this account; the reward, if any, is granted outside `rewardBundles`.
- Guard now implemented: `SAFE_METRICS` allowlist (lesson/practice family) and `--quests-all` for the rest; a batch is only sent when at least one safe delta is positive.
