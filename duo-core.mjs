// language: JavaScript (Node 18+ ESM), file: duo-core.mjs
// Public Core & Service Facade (Clean Architecture Re-Exports)
// Mempertahankan 100% kompatibilitas mundur dengan modul lama sekaligus
// mengekspor fitur baru (Extended Profile, XP Modes, Streak Backfill, Shop, Leaderboard, Privacy, Superlink, Duome).

export {
  BASE,
  HOSTS,
  GOALS_HOST,
  STORIES_HOST,
  LEADERBOARDS_HOST,
  UA,
  sleep,
  rnd,
  jwtSub,
  jwtExp,
  extractJwt,
  baseHeaders,
  login,
  api,
  externalApi,
} from './src/core/client.mjs';

export {
  resolvePaths,
  loadConfig,
  loadState,
  saveState,
  writeAlert,
  clearAlert,
  readAlert,
  appendLog,
  createAuthManager,
} from './src/core/config.mjs';

export {
  extractSkillId,
  normalizeAvatar,
  parseCreationTs,
  profile,
  switchActiveCourse,
  pickCourse,
  todayIn,
  streakView,
  getPrivacy,
  setPrivacy,
  checkSuperlink,
  fetchDuomeActivity,
  verifyAccountHealth,
} from './src/services/profile.mjs';

export {
  START_FEN,
  rcToSq,
  sqToRc,
  parseFen,
  stateToFen,
  generateLegalMoves,
  applyMoveToState,
  evaluateState,
  analyzeLocal,
  analyzePosition,
} from './src/services/chess.mjs';

export {
  startSession,
  buildSubmit,
  completeSession,
  oneSession,
  grant,
  unitTestSession,
  storySession,
  farmXpLoop,
  farmStreak,
} from './src/services/farming.mjs';

export {
  SHOP_ICONS,
  categorizeShopItem,
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
  BOARD_IDS,
  LEAGUE_TIERS,
  getLeaderboard,
  autoLeagueFarm,
} from './src/services/leaderboard.mjs';
