// language: JavaScript (Node 18+ ESM)
// Layer: Configuration, State, Watchdog Alert & Multi-Account Manager (src/core/config.mjs)
// ATURAN KEAMANAN: Jangan pernah mencetak, me-log, atau mengembalikan string JWT mentah ke UI/console.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jwtSub, jwtExp, login } from './client.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function resolvePaths(customCfgPath) {
  const cfgPath = customCfgPath ? path.resolve(customCfgPath) : path.join(ROOT_DIR, 'duo.config.json');
  const dir = path.dirname(cfgPath);
  const statePath = cfgPath.replace(/\.json$/, '.state.json');
  const alertPath = path.join(dir, 'duo.alert');
  const logPath = path.join(dir, 'duo.log');
  return { rootDir: ROOT_DIR, cfgPath, statePath, alertPath, logPath };
}

export function loadConfig(cfgPath = resolvePaths().cfgPath) {
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`config tidak ada: ${cfgPath}`);
  }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

export function loadState(statePath = resolvePaths().statePath) {
  if (!fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(state, statePath = resolvePaths().statePath) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

export function writeAlert(lines, alertPath = resolvePaths().alertPath) {
  const arr = Array.isArray(lines) ? lines : [String(lines)];
  const msg = `[${new Date().toISOString()}] GAGAL\n` + arr.map(l => `- ${l}`).join('\n') + '\n';
  fs.writeFileSync(alertPath, msg, 'utf8');
}

export function clearAlert(alertPath = resolvePaths().alertPath) {
  if (fs.existsSync(alertPath)) fs.unlinkSync(alertPath);
}

export function readAlert(alertPath = resolvePaths().alertPath) {
  if (!fs.existsSync(alertPath)) return null;
  try {
    return fs.readFileSync(alertPath, 'utf8');
  } catch {
    return null;
  }
}

export function appendLog(line, logPath = resolvePaths().logPath) {
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // abaikan jika gagal tulis log
  }
}

export function createAuthManager(customCfgPath) {
  const paths = resolvePaths(customCfgPath);

  function getCfgAndState() {
    const cfg = loadConfig(paths.cfgPath);
    const state = loadState(paths.statePath);
    return { cfg, state };
  }

  async function getJwt() {
    const { cfg, state } = getCfgAndState();
    const exp = state.jwt ? (state.jwtExp || jwtExp(state.jwt)) : 0;
    if (state.jwt && exp > Date.now() + 60_000) {
      return { jwt: state.jwt, sub: state.sub || jwtSub(state.jwt), cfg, state };
    }

    if (cfg.jwt) {
      state.jwt = cfg.jwt;
      state.jwtExp = jwtExp(cfg.jwt) || Date.now() + 6 * 3600_000;
      state.sub = jwtSub(cfg.jwt) || state.sub;
      saveState(state, paths.statePath);
      return { jwt: state.jwt, sub: state.sub, cfg, state };
    }

    if (!cfg.login || !cfg.password) {
      throw new Error('config butuh "jwt", atau "login" + "password"');
    }

    const r = await login(cfg.login, cfg.password);
    state.jwt = r.jwt;
    state.jwtExp = jwtExp(r.jwt) || Date.now() + 6 * 3600_000;
    state.sub = r.sub;
    saveState(state, paths.statePath);
    return { jwt: state.jwt, sub: state.sub, cfg, state };
  }

  async function withAuth(fn) {
    let auth = await getJwt();
    try {
      return await fn(auth);
    } catch (e) {
      if (e.status !== 401) throw e;
      const { cfg, state } = getCfgAndState();
      if (cfg.login && cfg.password) {
        state.jwt = undefined;
        state.jwtExp = 0;
        saveState(state, paths.statePath);
        auth = await getJwt();
        return await fn(auth);
      }
      throw new Error('401 Unauthorized - JWT expired, perbarui duo.config.json');
    }
  }

  // Multi-Account Manager (tanpa pernah membocorkan JWT ke response JSON/UI)
  function listSavedAccounts() {
    const { state } = getCfgAndState();
    const accounts = Array.isArray(state.savedAccounts) ? state.savedAccounts : [];
    const activeSub = String(state.sub || '');
    return accounts.map(a => ({
      sub: String(a.sub),
      username: a.username || `User ${a.sub}`,
      name: a.name || a.username || '',
      picture: a.picture || '',
      streak: a.streak ?? 0,
      totalXp: a.totalXp ?? 0,
      gems: a.gems ?? 0,
      fromLanguage: a.fromLanguage || '',
      learningLanguage: a.learningLanguage || '',
      savedAt: a.savedAt || null,
      active: String(a.sub) === activeSub,
    }));
  }

  function upsertAccountSnapshot(profileData, jwt) {
    const { state } = getCfgAndState();
    if (!Array.isArray(state.savedAccounts)) state.savedAccounts = [];
    const sub = String(profileData.id || state.sub || jwtSub(jwt));
    const idx = state.savedAccounts.findIndex(a => String(a.sub) === sub);
    const entry = {
      sub,
      username: profileData.username || `user_${sub}`,
      name: profileData.name || profileData.username || '',
      picture: profileData.picture || '',
      streak: profileData.streak ?? 0,
      totalXp: profileData.totalXp ?? 0,
      gems: profileData.gems ?? 0,
      fromLanguage: profileData.fromLanguage || '',
      learningLanguage: profileData.learningLanguage || '',
      jwt: jwt || state.jwt,
      jwtExp: jwtExp(jwt || state.jwt) || state.jwtExp,
      savedAt: new Date().toISOString(),
    };
    if (idx >= 0) {
      state.savedAccounts[idx] = { ...state.savedAccounts[idx], ...entry };
    } else {
      state.savedAccounts.push(entry);
    }
    saveState(state, paths.statePath);
    return listSavedAccounts();
  }

  function switchSavedAccount(targetSub) {
    const { state } = getCfgAndState();
    const accounts = Array.isArray(state.savedAccounts) ? state.savedAccounts : [];
    const found = accounts.find(a => String(a.sub) === String(targetSub));
    if (!found || !found.jwt) {
      throw new Error(`Akun sub=${targetSub} tidak ditemukan di state lokal`);
    }
    state.jwt = found.jwt;
    state.jwtExp = found.jwtExp || jwtExp(found.jwt);
    state.sub = found.sub;
    saveState(state, paths.statePath);
    return { switchedTo: found.sub, username: found.username };
  }

  function removeSavedAccount(targetSub) {
    const { state } = getCfgAndState();
    if (!Array.isArray(state.savedAccounts)) return [];
    state.savedAccounts = state.savedAccounts.filter(a => String(a.sub) !== String(targetSub));
    saveState(state, paths.statePath);
    return listSavedAccounts();
  }

  return {
    paths,
    getCfgAndState,
    getJwt,
    withAuth,
    listSavedAccounts,
    upsertAccountSnapshot,
    switchSavedAccount,
    removeSavedAccount,
  };
}
