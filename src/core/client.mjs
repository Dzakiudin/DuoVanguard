// language: JavaScript (Node 18+ ESM)
// Layer: Core HTTP & Auth Client (src/core/client.mjs)
// Menyediakan parsing JWT, login, dan HTTP client dengan failover www -> android-api
// serta helper fetch untuk subdomain Duolingo lainnya (goals-api, stories, leaderboards).

export const BASE = 'https://www.duolingo.com';
export const HOSTS = [BASE, 'https://android-api.duolingo.com'];
export const GOALS_HOST = 'https://goals-api.duolingo.com';
export const STORIES_HOST = 'https://stories.duolingo.com';
export const LEADERBOARDS_HOST = 'https://duolingo-leaderboards-prod.duolingo.com';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));

export function jwtSub(jwt) {
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return p.sub ?? null;
  } catch {
    return null;
  }
}

export function jwtExp(jwt) {
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return (p.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

export function extractJwt(res) {
  const list = res.headers.getSetCookie?.() ??
               [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of list) {
    const m = /jwt_token=([^;]+)/.exec(c || '');
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

export const baseHeaders = jwt => ({
  'Content-Type': 'application/json; charset=UTF-8',
  Accept: 'application/json; charset=UTF-8',
  'Accept-Language': 'id,en;q=0.9',
  'User-Agent': UA,
  Authorization: `Bearer ${jwt}`,
  Cookie: `jwt_token=${jwt}`,
  Origin: BASE,
  Referer: `${BASE}/`,
  'X-Requested-With': 'XMLHttpRequest',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
});

export async function login(loginId, password) {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Origin: BASE,
      Referer: `${BASE}/`,
    },
    body: JSON.stringify({ login: loginId, password }),
  });

  if (!res.ok) throw new Error(`login -> ${res.status}`);

  const body = await res.json().catch(() => ({}));
  const jwt = extractJwt(res) ?? body.jwt ?? null;
  if (!jwt) throw new Error('jwt tidak ditemukan (password salah / 2FA / captcha)');

  return { jwt, sub: jwtSub(jwt), userId: body.user_id, username: body.username };
}

// Failover host: hanya untuk gangguan jaringan / CloudFront Access Denied / 5xx.
// Status HTTP asli (400/401/429) tidak diulang ke host lain.
export async function api(jwt, path, opts = {}) {
  let lastErr;
  for (const host of HOSTS) {
    let res;
    try {
      res = await fetch(host + path, {
        ...opts,
        headers: { ...baseHeaders(jwt), ...(opts.headers || {}) },
        signal: AbortSignal.timeout(opts.timeoutMs || 8_000),
      });
    } catch (e) {
      lastErr = e;
      continue;
    }

    const text = await res.text();
    const blocked = /Access Denied|Request blocked/i.test(text.slice(0, 200));
    if (blocked || res.status >= 500) {
      lastErr = new Error(`${opts.method || 'GET'} ${path} -> ${res.status} (${host})`);
      lastErr.status = res.status;
      continue;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      const e = new Error(`${opts.method || 'GET'} ${path} -> ${res.status}`);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }
  throw lastErr ?? new Error(`semua host gagal: ${path}`);
}

// Fetch ke host eksternal/subdomain spesifik (stories, leaderboards) dengan auth JWT
export async function externalApi(jwt, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...baseHeaders(jwt),
      Origin: BASE,
      Referer: `${BASE}/`,
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs || 10_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = new Error(`${opts.method || 'GET'} ${url} -> ${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}
