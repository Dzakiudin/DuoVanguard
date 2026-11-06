// language: JavaScript (Node 18+ ESM), file: ui.mjs
// Unified Self-Hosted HTTP + Streaming NDJSON Server (127.0.0.1:8791)
// Menyajikan dashboard SPA (src/web/dashboard.html), companion userscript (/duohacker-pro.user.js),
// dan seluruh endpoint API lokal dengan proteksi token x-duo-token.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  createAuthManager,
  loadState,
  saveState,
  readAlert,
  writeAlert,
  clearAlert,
  appendLog,
  profile,
  pickCourse,
  streakView,
  gemCount,
  rewards,
  claimReward,
  claimRewards,
  shopItems,
  buyItem,
  getPrivacy,
  setPrivacy,
  switchActiveCourse,
  checkSuperlink,
  fetchDuomeActivity,
  verifyAccountHealth,
  farmXpLoop,
  farmStreak,
  getLeaderboard,
  autoLeagueFarm,
  START_FEN,
  parseFen,
  stateToFen,
  generateLegalMoves,
  applyMoveToState,
  analyzePosition,
  jwtExp,
} from './duo-core.mjs';

import {
  questSchema,
  questProgress,
  activeGoals,
  SAFE_METRICS,
  autoQuests,
  questLoop,
  badgesCatalog,
  updateSingleGoal,
  claimMonthlyBadges,
} from './gems.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DUO_UI_PORT || 8791);
const HOST = '127.0.0.1';

const authMgr = createAuthManager();
const initialState = loadState();
const TOKEN = process.env.DUO_UI_TOKEN || initialState.uiToken || crypto.randomBytes(12).toString('hex');
if (!process.env.DUO_UI_TOKEN && initialState.uiToken !== TOKEN) {
  initialState.uiToken = TOKEN;
  saveState(initialState);
}

const HTML_PATH = path.join(__dirname, 'src', 'web', 'dashboard.html');
const USERSCRIPT_PATH = path.join(__dirname, 'userscript', 'duohacker-pro.user.js');

let cachedCourse = null;
let cachedCreationTs = null;
let stopRequested = false;

async function ensureAccountContext(jwt, sub, cfg) {
  const u = await profile(jwt, sub);
  cachedCourse = pickCourse(u, cfg.course);
  cachedCreationTs = u.creationTs || null;
  return { u, course: cachedCourse };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-duo-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 64_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function checkToken(req) {
  const h = req.headers['x-duo-token'];
  if (h === TOKEN) return true;
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  return u.searchParams.get('t') === TOKEN;
}

function streamAction(res, actName, runner) {
  stopRequested = false;
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const write = obj => res.write(JSON.stringify(obj) + '\n');
  const log = msg => {
    const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
    write({ type: 'log', ts: Date.now(), msg: s });
    appendLog(`[UI:${actName}] ${s}`, authMgr.paths.logPath);
  };
  const onProgress = data => write({ type: 'progress', ts: Date.now(), ...data });
  const shouldStop = () => stopRequested;

  const t0 = Date.now();
  write({ type: 'start', act: actName, ts: t0 });

  Promise.resolve()
    .then(() => runner({ log, onProgress, shouldStop }))
    .then(result => write({ type: 'end', ok: true, ms: Date.now() - t0, result }))
    .catch(e => {
      write({ type: 'error', status: e.status || 0, error: e.message, data: e.data || null });
      write({ type: 'end', ok: false, ms: Date.now() - t0 });
    })
    .finally(() => res.end());
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = u.pathname;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-duo-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }

    // 1. Public Static Routes (Dashboard HTML & Userscript)
    if (req.method === 'GET' && p === '/') {
      const rawHtml = fs.readFileSync(HTML_PATH, 'utf8');
      const html = rawHtml.replace(
        '<script>',
        `<script>\nwindow.__DUO_UI_TOKEN__ = ${JSON.stringify(TOKEN)};`,
      );
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(html);
    }

    if (req.method === 'GET' && p === '/duohacker-pro.user.js') {
      const js = fs.readFileSync(USERSCRIPT_PATH, 'utf8');
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      return res.end(js);
    }

    // 1b. Stateless Local Chess Engine Routes (accessible by Dashboard & Userscript)
    if (req.method === 'POST' && p === '/api/chess/analyze') {
      const body = await readBody(req);
      const fen = String(body.fen || START_FEN).trim() || START_FEN;
      const depth = Math.min(18, Math.max(2, Number(body.depth || 12)));
      const useCloud = body.useCloud !== false;
      const analysis = await analyzePosition(fen, { depth, useCloud });
      const state = parseFen(fen);
      const legalMoves = generateLegalMoves(state).map(m => ({
        from: m.from,
        to: m.to,
        uci: m.uci,
        san: m.san,
        piece: m.piece,
        captured: m.captured,
        promotion: m.promotion,
      }));
      return sendJson(res, 200, {
        ...analysis,
        board: state.board,
        legalMoves,
      });
    }

    if (req.method === 'POST' && p === '/api/chess/move') {
      const body = await readBody(req);
      const fen = String(body.fen || START_FEN).trim() || START_FEN;
      const state = parseFen(fen);
      const legal = generateLegalMoves(state);
      const from = String(body.from || '').toLowerCase();
      const to = String(body.to || '').toLowerCase();
      const promo = String(body.promotion || 'q').toLowerCase();

      const chosen = legal.find(
        m => m.from === from && m.to === to && (!m.promotion || m.promotion === promo),
      ) || legal.find(m => m.from === from && m.to === to);

      if (!chosen) {
        return sendJson(res, 400, { error: `Langkah tidak sah: ${from} -> ${to}` });
      }

      let nextState = applyMoveToState(state, chosen);
      let nextFen = stateToFen(nextState);
      let botMove = null;

      if (body.vsBot) {
        const botLegal = generateLegalMoves(nextState);
        if (botLegal.length > 0) {
          const botAnalysis = await analyzePosition(nextFen, {
            depth: Math.min(14, Math.max(2, Number(body.botDepth || 8))),
            useCloud: body.useCloud !== false,
          });
          if (botAnalysis.bestMove) {
            const bm = botLegal.find(
              m =>
                m.from === botAnalysis.bestMove.from &&
                m.to === botAnalysis.bestMove.to &&
                (!m.promotion || m.promotion === (botAnalysis.bestMove.promotion || 'q')),
            ) || botLegal[0];
            botMove = {
              from: bm.from,
              to: bm.to,
              uci: bm.uci,
              san: bm.san,
              piece: bm.piece,
              captured: bm.captured,
            };
            nextState = applyMoveToState(nextState, bm);
            nextFen = stateToFen(nextState);
          }
        }
      }

      const nextAnalysis = await analyzePosition(nextFen, {
        depth: Math.min(18, Math.max(2, Number(body.depth || 12))),
        useCloud: body.useCloud !== false,
      });
      const nextLegal = generateLegalMoves(nextState).map(m => ({
        from: m.from,
        to: m.to,
        uci: m.uci,
        san: m.san,
        piece: m.piece,
        captured: m.captured,
        promotion: m.promotion,
      }));

      return sendJson(res, 200, {
        ok: true,
        playedMove: {
          from: chosen.from,
          to: chosen.to,
          uci: chosen.uci,
          san: chosen.san,
        },
        botMove,
        ...nextAnalysis,
        board: nextState.board,
        legalMoves: nextLegal,
      });
    }

    // 2. Token Gate for Authenticated Account /api/*
    if (!checkToken(req)) {
      return sendJson(res, 403, { error: 'token salah atau kosong (x-duo-token)' });
    }

    // 3. Read / Status Endpoints
    if (req.method === 'GET' && p === '/api/status') {
      const data = await authMgr.withAuth(async ({ jwt, sub, cfg, state }) => {
        const tz = cfg.timezone || 'Asia/Jakarta';
        const { u: prof, course } = await ensureAccountContext(jwt, sub, cfg);
        const sv = streakView(prof, tz);
        const [gems, rew, priv] = await Promise.all([
          gemCount(jwt, sub),
          rewards(jwt, sub),
          getPrivacy(jwt, sub).catch(() => ({ status: 'PUBLIC', isPrivate: false })),
        ]);
        const unconsumed = rew.filter(r => !r.consumed);
        const gemRewards = unconsumed.filter(r => r.currency === 'GEMS' && Number(r.amount) > 0);

        return {
          username: prof.username,
          name: prof.name || prof.username,
          sub,
          avatar: prof.avatar,
          hasPlus: Boolean(prof.hasPlus),
          privacy: priv.status,
          creationDateIso: prof.creationDateIso,
          creationTs: prof.creationTs,
          course,
          courses: prof.courses || [],
          streak: sv,
          gems,
          rewards: {
            unclaimed: unconsumed.length,
            gemCount: gemRewards.length,
            gemSum: gemRewards.reduce((s, r) => s + Number(r.amount || 0), 0),
          },
          jwtExp: state.jwtExp || jwtExp(jwt),
          alert: readAlert(authMgr.paths.alertPath),
        };
      });
      return sendJson(res, 200, data);
    }

    if (req.method === 'GET' && p === '/api/verify') {
      const rep = await authMgr.withAuth(async ({ jwt, sub, cfg }) => {
        const tz = cfg.timezone || 'Asia/Jakarta';
        const r = await verifyAccountHealth({ jwt, sub, tz, preferCourse: cfg.course });
        if (!r.ok) writeAlert(r.issues, authMgr.paths.alertPath);
        else clearAlert(authMgr.paths.alertPath);
        return r;
      });
      return sendJson(res, 200, rep);
    }

    if (req.method === 'GET' && p === '/api/quests') {
      const data = await authMgr.withAuth(async ({ jwt, sub, cfg }) => {
        const tz = cfg.timezone || 'Asia/Jakarta';
        const [schema, progress] = await Promise.all([
          questSchema(jwt, sub),
          questProgress(jwt, sub, tz),
        ]);
        const today = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        const details = progress?.goals?.details || {};
        const counters = progress?.goals?.progress || {};
        const active = activeGoals(schema, today).map(g => {
          const val = Math.max(0, Number(details[g.goalId]?.progress ?? counters[g.goalId] ?? 0) || 0);
          const thr = Number(g.threshold ?? 0);
          return {
            goalId: g.goalId,
            metric: g.metric,
            threshold: thr,
            progress: val,
            done: val >= thr && thr > 0,
            safe: SAFE_METRICS.has(g.metric),
          };
        });
        return { today, tz, active };
      });
      return sendJson(res, 200, data);
    }

    if (req.method === 'GET' && p === '/api/badges') {
      const data = await authMgr.withAuth(async ({ jwt, sub, cfg }) => {
        const tz = cfg.timezone || 'Asia/Jakarta';
        if (cachedCreationTs === null) {
          await ensureAccountContext(jwt, sub, cfg);
        }
        return badgesCatalog(jwt, sub, { tz, creationTs: cachedCreationTs });
      });
      return sendJson(res, 200, data);
    }

    if (req.method === 'GET' && p === '/api/shop') {
      const items = await authMgr.withAuth(({ jwt }) => shopItems(jwt));
      return sendJson(res, 200, { items });
    }

    if (req.method === 'GET' && p === '/api/rewards') {
      const list = await authMgr.withAuth(({ jwt, sub }) => rewards(jwt, sub));
      return sendJson(res, 200, { rewards: list.filter(r => !r.consumed) });
    }

    if (req.method === 'GET' && p === '/api/league') {
      const lb = await authMgr.withAuth(({ jwt, sub }) => getLeaderboard(jwt, sub));
      return sendJson(res, 200, lb);
    }

    if (req.method === 'GET' && p === '/api/duome') {
      const userId = u.searchParams.get('userId') || '';
      const d = await fetchDuomeActivity(userId);
      return sendJson(res, 200, d);
    }

    if (req.method === 'GET' && p === '/api/accounts') {
      return sendJson(res, 200, { accounts: authMgr.listSavedAccounts() });
    }

    if (req.method === 'GET' && p === '/api/log') {
      const logText = fs.existsSync(authMgr.paths.logPath)
        ? fs.readFileSync(authMgr.paths.logPath, 'utf8').slice(-16_000)
        : '';
      return sendJson(res, 200, { log: logText });
    }

    // 4. Synchronous / Instant Mutation Endpoints
    if (req.method === 'POST' && p === '/api/act/stop') {
      stopRequested = true;
      return sendJson(res, 200, { ok: true, stopped: true });
    }

    if (req.method === 'POST' && p === '/api/act/privacy') {
      const body = await readBody(req);
      const r = await authMgr.withAuth(({ jwt, sub }) => setPrivacy(jwt, sub, Boolean(body.makePrivate)));
      return sendJson(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/act/course') {
      const body = await readBody(req);
      const r = await authMgr.withAuth(async ({ jwt, sub }) => {
        const resCourse = await switchActiveCourse(jwt, sub, {
          fromLanguage: body.fromLanguage || body.from,
          learningLanguage: body.learningLanguage || body.learning,
        });
        cachedCourse = { from: resCourse.fromLanguage, learning: resCourse.learningLanguage };
        return resCourse;
      });
      return sendJson(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/act/rewards/claim-one') {
      const body = await readBody(req);
      const rewardId = String(body.id || '').trim();
      if (!rewardId) return sendJson(res, 400, { error: 'reward id kosong' });
      const r = await authMgr.withAuth(async ({ jwt, sub, cfg }) => {
        const { course } = await ensureAccountContext(jwt, sub, cfg);
        const beforeGems = await gemCount(jwt, sub);
        await claimReward(jwt, sub, rewardId, course);
        const afterGems = await gemCount(jwt, sub);
        return {
          ok: true,
          id: rewardId,
          beforeGems,
          afterGems,
          deltaGems: afterGems - beforeGems,
        };
      });
      return sendJson(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/superlink') {
      const body = await readBody(req);
      const r = await authMgr.withAuth(({ jwt }) => checkSuperlink(jwt, body.input));
      return sendJson(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/act/quests/single') {
      const body = await readBody(req);
      const r = await authMgr.withAuth(({ jwt, sub, cfg }) =>
        updateSingleGoal(jwt, sub, {
          goalId: body.goalId,
          metric: body.metric || 'QUESTS',
          quantity: Number(body.quantity) || 1,
          tz: cfg.timezone || 'Asia/Jakarta',
        }),
      );
      return sendJson(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/accounts/save') {
      const accounts = await authMgr.withAuth(async ({ jwt, sub }) => {
        const prof = await profile(jwt, sub);
        const gems = await gemCount(jwt, sub);
        return authMgr.upsertAccountSnapshot({ ...prof, gems }, jwt);
      });
      return sendJson(res, 200, { accounts });
    }

    if (req.method === 'POST' && p === '/api/accounts/switch') {
      const body = await readBody(req);
      const r = authMgr.switchSavedAccount(body.sub);
      cachedCourse = null;
      cachedCreationTs = null;
      return sendJson(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/accounts/delete') {
      const body = await readBody(req);
      const accounts = authMgr.removeSavedAccount(body.sub);
      return sendJson(res, 200, { accounts });
    }

    // 5. Streaming NDJSON Action Endpoints
    if (req.method === 'POST' && (p === '/api/act/xp' || p === '/api/act/grant')) {
      const body = await readBody(req);
      const count = Math.min(50, Math.max(1, Number(body.count || 1)));
      const targetXp = Math.max(0, Number(body.targetXp || 0));
      const mode = body.mode || 'safe';
      const delayMs = Math.max(300, Number(body.delayMs || 1500));

      return streamAction(res, `xp:${mode}`, ({ log, onProgress, shouldStop }) =>
        authMgr.withAuth(async ({ jwt, sub, cfg }) => {
          const { course } = await ensureAccountContext(jwt, sub, cfg);
          return farmXpLoop(
            jwt,
            {
              sub,
              ...course,
              mode,
              count,
              targetXp,
              delayMs,
              fast: p === '/api/act/xp',
              minutes: cfg.lessonMinutes,
              shouldStop,
              onProgress,
            },
            log,
          );
        }),
      );
    }

    if (req.method === 'POST' && p === '/api/act/streak') {
      const body = await readBody(req);
      const mode = body.mode || 'keeper';
      const days = Math.min(30, Math.max(1, Number(body.days || 1)));
      const delayMs = Math.max(400, Number(body.delayMs || 1500));

      return streamAction(res, `streak:${mode}`, ({ log, onProgress, shouldStop }) =>
        authMgr.withAuth(async ({ jwt, sub, cfg }) =>
          farmStreak(
            jwt,
            {
              sub,
              mode,
              days,
              tz: cfg.timezone || 'Asia/Jakarta',
              preferCourse: cfg.course,
              delayMs,
              shouldStop,
              onProgress,
            },
            log,
          ),
        ),
      );
    }

    if (req.method === 'POST' && p === '/api/act/league/farm') {
      const body = await readBody(req);
      const mode = body.mode || 'smart';
      const maxIterations = Math.min(50, Math.max(1, Number(body.maxIterations || 15)));
      const delayMs = Math.max(500, Number(body.delayMs || 1500));

      return streamAction(res, `league:${mode}`, ({ log, onProgress, shouldStop }) =>
        authMgr.withAuth(async ({ jwt, sub, cfg }) => {
          const { course } = await ensureAccountContext(jwt, sub, cfg);
          return autoLeagueFarm(
            jwt,
            { sub, ...course, mode, maxIterations, delayMs, shouldStop, onProgress },
            log,
          );
        }),
      );
    }

    if (req.method === 'POST' && p === '/api/act/badges/claim') {
      const body = await readBody(req);
      return streamAction(res, 'badges:claim', ({ log, shouldStop }) =>
        authMgr.withAuth(async ({ jwt, sub, cfg }) => {
          if (cachedCreationTs === null) await ensureAccountContext(jwt, sub, cfg);
          return claimMonthlyBadges(jwt, sub, {
            monthYear: body.monthYear || null,
            tz: cfg.timezone || 'Asia/Jakarta',
            creationTs: cachedCreationTs,
            skipOlderThanAccount: body.skipOlderThanAccount !== false,
            delayMs: Math.max(300, Number(body.delayMs || 450)),
            shouldStop,
            log,
          });
        }),
      );
    }

    if (req.method === 'POST' && p === '/api/act/quests/dry') {
      const body = await readBody(req);
      return streamAction(res, 'quests:dry', ({ log }) =>
        authMgr.withAuth(({ jwt, sub, cfg }) =>
          autoQuests(jwt, sub, {
            tz: cfg.timezone || 'Asia/Jakarta',
            dry: true,
            all: !!body.all,
            force: !!body.force,
            log,
          }),
        ),
      );
    }

    if (req.method === 'POST' && p === '/api/act/quests/send') {
      const body = await readBody(req);
      return streamAction(res, 'quests:send', ({ log }) =>
        authMgr.withAuth(async ({ jwt, sub, cfg }) => {
          const { course } = await ensureAccountContext(jwt, sub, cfg);
          if (body.loop) {
            return questLoop(jwt, sub, course, {
              tz: cfg.timezone || 'Asia/Jakarta',
              dry: false,
              all: !!body.all,
              force: !!body.force,
              log,
            });
          }
          return autoQuests(jwt, sub, {
            tz: cfg.timezone || 'Asia/Jakarta',
            dry: false,
            all: !!body.all,
            force: !!body.force,
            log,
          });
        }),
      );
    }

    if (req.method === 'POST' && p === '/api/act/rewards/claim') {
      const body = await readBody(req);
      const maxClaims = Math.min(60, Math.max(1, Number(body.maxClaims || 20)));
      return streamAction(res, 'rewards:claim', ({ log, onProgress, shouldStop }) =>
        authMgr.withAuth(async ({ jwt, sub, cfg }) => {
          const { course } = await ensureAccountContext(jwt, sub, cfg);
          return claimRewards(jwt, {
            sub,
            course,
            all: !!body.all,
            maxClaims,
            shouldStop,
            onProgress,
            log,
          });
        }),
      );
    }

    if (req.method === 'POST' && p === '/api/act/buy') {
      const body = await readBody(req);
      const itemName = String(body.item || '').trim();
      if (!itemName) return sendJson(res, 400, { error: 'item kosong' });
      return streamAction(res, `buy:${itemName}`, ({ log }) =>
        authMgr.withAuth(async ({ jwt, sub, cfg }) => {
          const { course } = await ensureAccountContext(jwt, sub, cfg);
          return buyItem(jwt, { sub, course, itemName, isFree: true, log });
        }),
      );
    }

    return sendJson(res, 404, { error: `Route tidak ditemukan: ${req.method} ${p}` });
  } catch (e) {
    return sendJson(res, e.status || 500, { error: e.message, data: e.data || null });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ui     : http://${HOST}:${PORT}/?t=${TOKEN}`);
  console.log(`script : http://${HOST}:${PORT}/duohacker-pro.user.js`);
  console.log(`token  : ${TOKEN}`);
});
