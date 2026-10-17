import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const OWNER = 'owner@example.com';
const VIEWER = 'viewer@example.com';
const RUNNER = 'runner@example.com';
const REPORT_MANAGER = 'reports@example.com';
const RATE_LIMIT_USER = 'ratelimit@example.com';
const active = new Set([VIEWER, RUNNER, REPORT_MANAGER, RATE_LIMIT_USER]);
const permissions = new Map([[VIEWER, []], [RUNNER, ['sync.run']], [REPORT_MANAGER, ['reports.manage']], [RATE_LIMIT_USER, []]]);
let upstream;
let dashboard;
let dashboardBase;
let upstreamBase;
let child;

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function emailForToken(token) {
  return ({ 'owner-token': OWNER, 'viewer-token': VIEWER, 'runner-token': RUNNER, 'reports-token': REPORT_MANAGER, 'rate-limit-token': RATE_LIMIT_USER })[token] || null;
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}
async function request(path, options = {}) {
  return fetch(dashboardBase + path, options);
}
async function login(email, includeOrigin = true, forwardedFor) {
  const headers = { 'content-type': 'application/json' };
  if (includeOrigin) headers.origin = dashboardBase;
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  const response = await request('/api/login', {
    method: 'POST', headers,
    body: JSON.stringify({ email, password: 'correct-horse-battery-staple' })
  });
  return { response, payload: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function session(cookie) {
  return request('/api/session', { headers: { cookie } });
}
async function mutate(path, method, cookie, payload) {
  return request(path, {
    method,
    headers: { origin: dashboardBase, cookie, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
        const input = await body(req);
        const tokens = { [OWNER]: 'owner-token', [VIEWER]: 'viewer-token', [RUNNER]: 'runner-token', [REPORT_MANAGER]: 'reports-token', [RATE_LIMIT_USER]: 'rate-limit-token' };
        if (!tokens[input.email] || input.password !== 'correct-horse-battery-staple') return json(res, 401, { message: 'Invalid login' });
        return json(res, 200, { access_token: tokens[input.email], expires_in: 3600 });
      }
      if (url.pathname === '/auth/v1/user') {
        const email = emailForToken((req.headers.authorization || '').replace(/^Bearer /, ''));
        return email ? json(res, 200, { id: email, email }) : json(res, 401, { message: 'Invalid token' });
      }
      if (url.pathname === '/api/v1/dashboard/access/check') {
        const email = (url.searchParams.get('email') || '').toLowerCase();
        const approved = active.has(email);
        return json(res, 200, { approved, email, role: approved ? 'viewer' : null, permissions: approved ? (permissions.get(email) || []) : [] });
      }
      const actor = (req.headers['x-dashboard-user-email'] || '').toLowerCase();
      const isOwner = actor === OWNER;
      if (url.pathname === '/api/v1/dashboard/access' && req.method === 'GET') {
        return isOwner ? json(res, 200, { data: [...active].map(email => ({ email, permissions: permissions.get(email) || [], is_active: true })) }) : json(res, 403, { error: 'Only owner' });
      }
      if (url.pathname === '/api/v1/dashboard/access' && req.method === 'PUT') {
        if (!isOwner) return json(res, 403, { error: 'Only owner' });
        const input = await body(req);
        const email = String(input.email || '').trim().toLowerCase();
        active.add(email);
        permissions.set(email, input.permissions || []);
        return json(res, 200, { data: { email, permissions: permissions.get(email), is_active: true } });
      }
      if (url.pathname === '/api/v1/dashboard/access' && req.method === 'DELETE') {
        if (!isOwner) return json(res, 403, { error: 'Only owner' });
        const email = (url.searchParams.get('email') || '').toLowerCase();
        active.delete(email);
        permissions.set(email, []);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/v1/dashboard/audit') {
        return isOwner ? json(res, 200, { data: [] }) : json(res, 403, { error: 'Only owner' });
      }
      if (url.pathname === '/api/v1/dashboard/reports/enabled' && req.method === 'POST') {
        if (!(isOwner || (active.has(actor) && (permissions.get(actor) || []).includes('reports.manage')))) return json(res, 403, { error: 'No report permission' });
        const input = await body(req);
        if (!['war', 'capital_raid'].includes(input.event_type) || !input.event_uid || typeof input.enabled !== 'boolean') return json(res, 400, { error: 'Invalid report control' });
        return json(res, 200, { data: { event_type: input.event_type, event_uid: input.event_uid, enabled: input.enabled } });
      }
      if (url.pathname === '/api/v1/dashboard/reports/retry' && req.method === 'POST') {
        if (!(isOwner || (active.has(actor) && (permissions.get(actor) || []).includes('reports.manage')))) return json(res, 403, { error: 'No report permission' });
        const input = await body(req);
        if (!['war', 'capital_raid'].includes(input.event_type) || !input.event_uid) return json(res, 400, { error: 'Invalid report identity' });
        return json(res, 202, { data: { event_type: input.event_type, event_uid: input.event_uid, state: 'ready' } });
      }
      if (url.pathname === '/api/v1/dashboard/sync/refresh' && req.method === 'POST') {
        const allowed = isOwner || (active.has(actor) && (permissions.get(actor) || []).includes('sync.run'));
        if (!allowed) return json(res, 403, { error: 'No sync permission' });
        const input = await body(req);
        if (input.confirmation !== 'RUN_FULL_SYNC') return json(res, 400, { error: 'Confirmation required' });
        return json(res, 202, { data: { id: '00000000-0000-4000-8000-000000000001', status: 'running' } });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
  const upstreamPort = await listen(upstream);
  upstreamBase = 'http://127.0.0.1:' + upstreamPort;

  const probe = http.createServer();
  const dashboardPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  dashboardBase = 'http://127.0.0.1:' + dashboardPort;
  child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, PORT: String(dashboardPort), NODE_ENV: 'test',
      SUPABASE_URL: upstreamBase, SUPABASE_ANON_KEY: 'test-anon-key',
      DASHBOARD_OWNER_EMAIL: OWNER, PONYO_API_URL: upstreamBase,
      PONYO_API_KEY: 'test-api-key', PONYO_CONTROL_API_KEY: 'test-control-api-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', () => {});
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('Dashboard process exited during startup');
    try {
      const response = await fetch(dashboardBase + '/health');
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(50);
  }
  assert.equal(ready, true, 'dashboard server should start');
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(1500)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (upstream?.listening) await new Promise(resolve => upstream.close(resolve));
});

test('login mutations reject missing Origin and unapproved accounts', async () => {
  const noOrigin = await login(OWNER, false);
  assert.equal(noOrigin.response.status, 403);
  const denied = await login('unknown@example.com');
  assert.equal(denied.response.status, 403);
});

test('owner alone can view and manage access', async () => {
  const owner = await login(OWNER);
  assert.equal(owner.response.status, 200);
  const ownerAccess = await request('/api/access', { headers: { cookie: owner.cookie } });
  assert.equal(ownerAccess.status, 200);
  const viewer = await login(VIEWER);
  assert.equal(viewer.response.status, 200);
  const viewerAccess = await request('/api/access', { headers: { cookie: viewer.cookie } });
  assert.equal(viewerAccess.status, 403);
  const viewerGrant = await mutate('/api/access', 'PUT', viewer.cookie, { email: 'new@example.com', permissions: [] });
  assert.equal(viewerGrant.status, 403);
  const viewerRevoke = await mutate('/api/access?email=' + encodeURIComponent(VIEWER), 'DELETE', viewer.cookie);
  assert.equal(viewerRevoke.status, 403);
});

test('viewers cannot run sync, while an explicitly permitted runner can', async () => {
  const viewer = await login(VIEWER);
  const denied = await mutate('/api/sync/refresh', 'POST', viewer.cookie, { confirmation: 'RUN_FULL_SYNC' });
  assert.equal(denied.status, 403);
  const runner = await login(RUNNER);
  const allowed = await mutate('/api/sync/refresh', 'POST', runner.cookie, { confirmation: 'RUN_FULL_SYNC' });
  assert.equal(allowed.status, 202);
});

test('revoking a grant invalidates an existing session on its next request', async () => {
  const owner = await login(OWNER);
  const viewer = await login(VIEWER);
  const revoked = await mutate('/api/access?email=' + encodeURIComponent(VIEWER), 'DELETE', owner.cookie);
  assert.equal(revoked.status, 200);
  const response = await session(viewer.cookie);
  assert.equal(response.status, 401);
});

test('report management permission is required for pause, enable, and retry', async () => {
  active.add(VIEWER);
  const viewer = await login(VIEWER);
  const deniedPause = await mutate('/api/reports/enabled', 'POST', viewer.cookie, { event_type: 'war', event_uid: 'CW-123', enabled: false });
  assert.equal(deniedPause.status, 403);
  const deniedRetry = await mutate('/api/reports/retry', 'POST', viewer.cookie, { event_type: 'war', event_uid: 'CW-123' });
  assert.equal(deniedRetry.status, 403);

  const manager = await login(REPORT_MANAGER);
  const paused = await mutate('/api/reports/enabled', 'POST', manager.cookie, { event_type: 'capital_raid', event_uid: 'CR-456', enabled: false });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).data.enabled, false);
  const retry = await mutate('/api/reports/retry', 'POST', manager.cookie, { event_type: 'war', event_uid: 'CW-123' });
  assert.equal(retry.status, 202);

  const noOrigin = await request('/api/reports/retry', {
    method: 'POST', headers: { cookie: manager.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ event_type: 'war', event_uid: 'CW-123' })
  });
  assert.equal(noOrigin.status, 403);
});

test('security headers are present and malformed session cookies fail closed', async () => {
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), true);
  assert.equal(health.headers.get('permissions-policy')?.includes('camera=()'), true);
  const malformed = await session('ponyo_dashboard_session=%E0%A4%A');
  assert.equal(malformed.status, 401);
});

test('login throttling is enforced per approved account', async () => {
  for (let i = 0; i < 10; i++) {
    const attempt = await login(RATE_LIMIT_USER, true, '203.0.113.' + (i + 1));
    assert.equal(attempt.response.status, 200, 'attempt ' + (i + 1) + ' should be accepted within the configured limit');
  }
  const blocked = await login(RATE_LIMIT_USER, true, '203.0.113.99');
  assert.equal(blocked.response.status, 429);
});
