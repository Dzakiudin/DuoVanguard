// language: JavaScript (Node 18+ ESM), file: gems.mjs
// Public Quests, Badges & Economy Facade (Clean Architecture Re-Exports)
// Mempertahankan 100% kompatibilitas mundur dengan modul lama sekaligus
// mengekspor fitur Monthly Badges & Quest Explorer baru.

export {
  gemCount,
  rewards,
  unclaimedRewards,
  claimReward,
  claimRewards,
  claimAllRewards,
  shopItems,
  buyItem,
} from './src/services/economy.mjs';

export {
  questSchema,
  questProgress,
  getQuestTimestamp,
  isQuestOlderThanAccount,
  questBatch,
  activeGoals,
  SAFE_METRICS,
  autoQuests,
  questLoop,
  badgesCatalog,
  updateSingleGoal,
  claimMonthlyBadges,
} from './src/services/quests.mjs';
