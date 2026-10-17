import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(here, 'public');
const port = Number(process.env.PORT || 10000);
const SESSION_COOKIE = 'ponyo_dashboard_session';
const SESSION_MAX_AGE = 60 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 10;
const MAX_LOGIN_KEYS = 5000;

const ownerEmail = (process.env.DASHBOARD_OWNER_EMAIL || '').trim().toLowerCase();

function configuration() {
  return {
    supabaseUrl: Boolean(process.env.SUPABASE_URL),
    supabaseAnonKey: Boolean(process.env.SUPABASE_ANON_KEY),
    ownerEmail: Boolean(ownerEmail),
    ponyoApiUrl: Boolean(process.env.PONYO_API_URL),
    ponyoApiKey: Boolean(process.env.PONYO_API_KEY),
    ponyoControlApiKey: Boolean(process.env.PONYO_CONTROL_API_KEY)
  };
}

function isConfigured() {
  return Object.values(configuration()).every(Boolean);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-DNS-Prefetch-Control': 'off',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
    ...headers
  });
  res.end(JSON.stringify(body));
}

function cookieOptions(maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const item of header.split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) { try { return decodeURIComponent(item.slice(index + 1).trim()); } catch { return ''; } }
  }
  return '';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const host = req.headers.host;
    return originUrl.host === host;
  } catch {
    return false;
  }
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

async function supabaseRequest(path, options = {}) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_ANON_KEY || '';
  const response = await fetch(base + path, {
    method: options.method || 'GET',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + (options.token || key),
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.msg || payload.message || payload.error_description || 'Authentication failed');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function roleFor(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return normalized === ownerEmail ? 'owner' : null;
}

async function ponyoControl(path, options = {}, actorEmail = '') {
  const base = (process.env.PONYO_API_URL || '').replace(/\/+$/, '');
  const response = await fetch(base + '/api/v1/dashboard' + path, {
    method: options.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + process.env.PONYO_CONTROL_API_KEY,
      'X-Dashboard-User-Email': String(actorEmail || '').trim().toLowerCase(),
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Ponyo control request failed');
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function accessForEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === ownerEmail) return { approved: true, email: normalized, role: 'owner', permissions: ['*'] };
  const result = await ponyoControl('/access/check?email=' + encodeURIComponent(normalized));
  return result.approved ? result : null;
}

async function currentUser(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !isConfigured()) return null;
  try {
    const user = await supabaseRequest('/auth/v1/user', { token });
    const access = await accessForEmail(user.email);
    if (!access) return null;
    return { id: user.id, email: user.email, role: access.role, permissions: access.permissions || [] };
  } catch {
    return null;
  }
}

function cleanError(value) {
  let message = String(value || 'Unknown error');
  message = message.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
  message = message.replace(/(token|secret|password|apikey|api_key)\s*[:=]\s*[^,\s]+/gi, '$1=[redacted]');
  return message.slice(0, 220);
}

async function ponyoGet(path) {
  const base = (process.env.PONYO_API_URL || '').replace(/\/+$/, '');
  const response = await fetch(base + path, {
    headers: { Authorization: 'Bearer ' + process.env.PONYO_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Ponyo API returned HTTP ' + response.status);
  return payload;
}

async function dashboardData() {
  const requests = [
    ['health', () => fetch((process.env.PONYO_API_URL || '').replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(7000) }).then(async response => {
      if (!response.ok) throw new Error('Health endpoint returned HTTP ' + response.status);
      return response.json();
    })],
    ['operations', () => ponyoGet('/api/v1/operations/summary')],
    ['clanSummary', () => ponyoGet('/api/v1/clan/summary')],
    ['activity', () => ponyoGet('/api/v1/clan/activity?hours=24')],
    ['currentWar', () => ponyoGet('/api/v1/war/current')],
    ['warHistory', () => ponyoGet('/api/v1/war/history?limit=5')],
    ['cwlHistory', () => ponyoGet('/api/v1/cwl/history?seasons=1&rounds=7')],
    ['capitalHistory', () => ponyoGet('/api/v1/capital-raids/history?limit=5')]
  ];
  const settled = await Promise.allSettled(requests.map(item => item[1]()));
  const data = {};
  const errors = {};
  settled.forEach((result, index) => {
    const key = requests[index][0];
    if (result.status === 'fulfilled') data[key] = result.value;
    else {
      data[key] = null;
      errors[key] = cleanError(result.reason && result.reason.message);
    }
  });
  return { generatedAt: new Date().toISOString(), data, errors };
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css'].includes(relative)) return false;
  try {
    const content = await readFile(join(publicDir, relative));
    res.writeHead(200, {
      'Content-Type': contentTypes[extname(relative)] || 'application/octet-stream',
      'Cache-Control': relative === 'index.html' ? 'no-store' : 'public, max-age=300',
      ...securityHeaders()
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function allowLoginAttempt(ip, email) {
  const now = Date.now();
  // Expire old entries and cap memory use under distributed login abuse.
  for (const [key, times] of loginAttempts) {
    const recent = times.filter(time => now - time < LOGIN_WINDOW_MS);
    if (recent.length) loginAttempts.set(key, recent);
    else loginAttempts.delete(key);
  }
  const keys = ['ip:' + ip, 'email:' + email].filter(key => key.length > 4);
  if (keys.some(key => (loginAttempts.get(key) || []).length >= LOGIN_LIMIT)) return false;
  for (const key of keys) {
    const recent = loginAttempts.get(key) || [];
    recent.push(now);
    loginAttempts.set(key, recent);
  }
  while (loginAttempts.size > MAX_LOGIN_KEYS) {
    loginAttempts.delete(loginAttempts.keys().next().value);
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(value => value.trim()).filter(Boolean);
  const ip = forwarded.length ? forwarded[forwarded.length - 1] : String(req.socket.remoteAddress || 'unknown');

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'ponyo-control-panel', configured: isConfigured() });
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, { configured: isConfigured(), missing: Object.entries(configuration()).filter(([, value]) => !value).map(([key]) => key) });
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin rejected' });
    if (!isConfigured()) return send(res, 503, { error: 'Dashboard setup is incomplete. Ask the owner to finish the server configuration.' });
    try {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password || password.length > 1024) return send(res, 400, { error: 'Enter your email and password.' });
      if (!allowLoginAttempt(ip, email)) return send(res, 429, { error: 'Too many login attempts. Please wait 15 minutes and try again.' });
      const initialAccess = await accessForEmail(email);
      if (!initialAccess) return send(res, 403, { error: 'This account has not been approved by the dashboard owner.' });
      const session = await supabaseRequest('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
      if (!session.access_token) return send(res, 401, { error: 'Login failed. Check your credentials.' });
      const user = await supabaseRequest('/auth/v1/user', { token: session.access_token });
      const access = await accessForEmail(user.email);
      if (!access) return send(res, 403, { error: 'This account has not been approved by the dashboard owner.' });
      const maxAge = Math.max(60, Math.min(SESSION_MAX_AGE, Number(session.expires_in) || SESSION_MAX_AGE));
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      const cookie = SESSION_COOKIE + '=' + encodeURIComponent(session.access_token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure;
      return send(res, 200, { user: { email: user.email, role: access.role, permissions: access.permissions || [] } }, { 'Set-Cookie': cookie });
    } catch (error) {
      const status = error.status === 429 ? 429 : 401;
      return send(res, status, { error: status === 429 ? 'Authentication service is rate-limiting requests. Try again later.' : 'Login failed. Check your credentials and try again.' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin rejected' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieOptions(0) });
  }
  if (req.method === 'GET' && url.pathname === '/api/session') {
    if (!isConfigured()) return send(res, 503, { error: 'Dashboard setup is incomplete.' });
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in with an approved administrator account.' });
    return send(res, 200, { user });
  }
  if (req.method === 'GET' && url.pathname === '/api/access') {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    if (user.role !== 'owner') return send(res, 403, { error: 'Only the owner can manage access.' });
    try { return send(res, 200, await ponyoControl('/access', {}, user.email)); }
    catch (error) { return send(res, error.status || 502, { error: cleanError(error.message) }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/audit') {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    if (user.role !== 'owner') return send(res, 403, { error: 'Only the owner can view the audit log.' });
    try { return send(res, 200, await ponyoControl('/audit', {}, user.email)); }
    catch (error) { return send(res, error.status || 502, { error: cleanError(error.message) }); }
  }
  if (req.method === 'PUT' && url.pathname === '/api/access') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin rejected' });
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    if (user.role !== 'owner') return send(res, 403, { error: 'Only the owner can grant permissions.' });
    try {
      const body = await readJson(req);
      return send(res, 200, await ponyoControl('/access', { method: 'PUT', body }, user.email));
    } catch (error) { return send(res, error.status || 502, { error: cleanError(error.message) }); }
  }
  if (req.method === 'DELETE' && url.pathname === '/api/access') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin rejected' });
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    if (user.role !== 'owner') return send(res, 403, { error: 'Only the owner can revoke permissions.' });
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    try { return send(res, 200, await ponyoControl('/access?email=' + encodeURIComponent(email), { method: 'DELETE' }, user.email)); }
    catch (error) { return send(res, error.status || 502, { error: cleanError(error.message) }); }
  }
  if (req.method === 'POST' && ['/api/reports/enabled', '/api/reports/retry'].includes(url.pathname)) {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin rejected' });
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    if (!(user.role === 'owner' || (user.permissions || []).includes('reports.manage'))) {
      return send(res, 403, { error: 'You do not have permission to manage Discord reports.' });
    }
    try {
      const body = await readJson(req);
      const path = url.pathname === '/api/reports/enabled' ? '/reports/enabled' : '/reports/retry';
      return send(res, url.pathname === '/api/reports/retry' ? 202 : 200,
        await ponyoControl(path, { method: 'POST', body }, user.email));
    } catch (error) {
      return send(res, error.status || 502, { error: cleanError(error.message) });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/refresh') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin rejected' });
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    if (!(user.role === 'owner' || (user.permissions || []).includes('sync.run'))) return send(res, 403, { error: 'You do not have permission to run syncs.' });
    try {
      const body = await readJson(req);
      return send(res, 202, await ponyoControl('/sync/refresh', { method: 'POST', body }, user.email));
    } catch (error) { return send(res, error.status || 502, { error: cleanError(error.message) }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/sync/refresh-status') {
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    if (!(user.role === 'owner' || (user.permissions || []).includes('sync.run'))) return send(res, 403, { error: 'You do not have permission to view sync control status.' });
    const id = String(url.searchParams.get('id') || '');
    try { return send(res, 200, await ponyoControl('/sync/refresh-status?id=' + encodeURIComponent(id), {}, user.email)); }
    catch (error) { return send(res, error.status || 502, { error: cleanError(error.message) }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    if (!isConfigured()) return send(res, 503, { error: 'Dashboard setup is incomplete.' });
    const user = await currentUser(req);
    if (!user) return send(res, 401, { error: 'Please sign in again.' });
    try {
      return send(res, 200, { user, ...(await dashboardData()) });
    } catch {
      return send(res, 502, { error: 'Could not load dashboard data. Check the Ponyo service and API configuration.' });
    }
  }
  if (await serveStatic(url.pathname, res)) return;
  return send(res, 404, { error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log('[dashboard] listening on port ' + port);
  console.log('[dashboard] configuration complete: ' + String(isConfigured()));
});

function shutdown(signal) {
  console.log('[dashboard] ' + signal + '; shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
