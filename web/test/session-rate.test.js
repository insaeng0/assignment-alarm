const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { RefreshSessions, tokenHash } = require('../lib/refresh-sessions');

const secret = 'synthetic-session-rate-tests-only-signing-secret';
const realm = 'a'.repeat(64);
const frontend = 'https://rate.example';
const transactions = [], statements = [];
let existing = true;
let issuance = { window_ms: Date.now() - 30000, issue_count: 20 };
let family;
const pool = {
  on() { return this; },
  async execute(sql, params = []) {
    statements.push(sql);
    if (sql.includes('FROM users WHERE google_sub')) {
      const id = Number(/^rate-member-(\d+)-sub$/.exec(params[0])?.[1]) || 1;
      return [existing ? [{ user_id: id, name: '가상회원', grade: 1, class_number: 1, is_admin: 0, google_sub: `rate-member-${id}-sub`, google_email: `rate-member-${id}@bssm.hs.kr` }] : []];
    }
    if (sql.includes('FROM auth_refresh_issuance')) return [[issuance]];
    if (sql.includes('FROM auth_refresh_families') && sql.endsWith('FOR UPDATE')) return [[family]];
    return [{ affectedRows: 1 }];
  },
  async getConnection() { return { execute: this.execute.bind(this),
    async beginTransaction() { transactions.push('begin'); }, async commit() { transactions.push('commit'); },
    async rollback() { transactions.push('rollback'); }, release() { transactions.push('release'); } }; }
};
class FakeGoogleClient {
  async verifyIdToken({ idToken }) {
    if (idToken === 'invalid') throw new Error('Synthetic invalid Google credential');
    const id = /^school-(\d+)$/.exec(idToken)?.[1] || 1;
    return { getPayload: () => ({ sub: `rate-member-${id}-sub`, email: `rate-member-${id}@bssm.hs.kr`, email_verified: true, hd: 'bssm.hs.kr', name: '가상회원' }) };
  }
}
Object.assign(process.env, { NODE_ENV: 'production', JWT_SECRET: secret, DB_USER: 'test', DB_PASSWORD: 'test',
  GOOGLE_CLIENT_ID: 'test-client', APP_ORIGIN: frontend, FRONTEND_ORIGIN: frontend,
  PAGES_AUTH_MODE: 'bearer', AUTH_REALM_ID: realm, PAGES_ACCESS_MAX_SESSIONS: '5', TRUST_PROXY: 'false' });
const load = Module._load;
Module._load = function(name) {
  if (name === 'mysql2/promise') return { createPool: () => pool };
  if (name === 'google-auth-library') return { OAuth2Client: FakeGoogleClient };
  return load.apply(this, arguments);
};
let app;
try { ({ app } = require('../server')); } finally { Module._load = load; }
let server, base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(resolve => server.close(resolve)); });
async function post(route, body) {
  const response = await fetch(base + route, { method: 'POST', headers: { Origin: frontend, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await response.text(); return { response, data: JSON.parse(raw), raw };
}

test('actual remembered-session issuance limits propagate through Google login and profile completion without leaking reservations', async () => {
  existing = false;
  const setups = [];
  for (let id = 1; id <= 6; id++) {
    const setup = await post('/api/auth/google', { credential: 'school-' + id });
    assert.equal(setup.response.status, 200); assert.ok(setup.data.setupToken);
    setups.push(setup.data.setupToken);
  }
  existing = true; issuance = { window_ms: Date.now() - 30000, issue_count: 20 };
  for (let id = 1; id <= 6; id++) {
    const route = id % 2 ? '/api/auth/google' : '/api/auth/google/register';
    const before = statements.length, txBefore = transactions.length;
    const result = await post(route, { credential: 'school-' + id, setupToken: setups[id - 1], rememberMe: true });
    assert.equal(result.response.status, 429); assert.equal(result.data.code, 'REFRESH_ISSUANCE_LIMITED');
    const retryAfter = Number(result.response.headers.get('retry-after'));
    assert.ok(retryAfter >= 869 && retryAfter <= 870);
    assert.equal(result.data.accessToken, undefined); assert.equal(result.data.refreshToken, undefined);
    assert.ok(!result.raw.includes(secret)); assert.ok(!result.raw.includes('rate-member-'));
    assert.deepEqual(transactions.slice(txBefore), ['begin', 'rollback', 'release']);
    assert.ok(!statements.slice(before).some(sql => sql.startsWith('INSERT INTO auth_refresh_families') || sql.startsWith('UPDATE auth_refresh_families')));
  }
  // Capacity is five: six distinct users returning 429 also prove their
  // reserved access slots were removed instead of the sixth failing 503.
  const invalid = await post('/api/auth/google', { credential: 'invalid', rememberMe: true });
  assert.equal(invalid.response.status, 401); assert.equal(invalid.response.headers.get('retry-after'), null);
});

test('durable issuance and renewal limits return the exact remaining window before any credential writes', async () => {
  const now = 1000000;
  const sessions = new RefreshSessions({ pool, secret, authRealm: realm, now: () => now });
  issuance = { window_ms: 900000, issue_count: 20 };
  const before = statements.length;
  await assert.rejects(sessions.create(1), error => error.code === 'REFRESH_ISSUANCE_LIMITED' && error.status === 429 && error.retryAfterMs === 800000);
  const refreshToken = 'b'.repeat(64) + '.' + 'c'.repeat(64);
  family = { family_id: 'b'.repeat(64), user_id: 1, current_token_hash: tokenHash(refreshToken), expires_at_ms: now + 900000,
    revoked: 0, rate_window_ms: 900000, rate_count: 60 };
  await assert.rejects(sessions.rotate(refreshToken, 'd'.repeat(32)), error => error.code === 'REFRESH_RATE_LIMITED' && error.status === 429 && error.retryAfterMs === 800000);
  assert.ok(!statements.slice(before).some(sql => sql.startsWith('INSERT INTO auth_refresh_families') || sql.startsWith('INSERT INTO auth_refresh_history') || sql.startsWith('UPDATE auth_refresh_families')));
});
