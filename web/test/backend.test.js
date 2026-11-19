const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const secret = 'test-session-signing-key-with-at-least-32-bytes';
const imageRoot = path.join(os.tmpdir(), `assignment-alarm-tests-${process.pid}`);
Object.assign(process.env, {
  NODE_ENV: 'test', GEMINI_API_KEY: 'disabled-test-provider', JWT_SECRET: secret, DB_USER: 'test', DB_PASSWORD: 'test',
  GOOGLE_CLIENT_ID: 'test-client', ADMIN_GOOGLE_EMAILS: 'approved@bssm.hs.kr,26_40@bssm.hs.kr', ADMIN_MODE_OWNER_EMAIL: '26_40@bssm.hs.kr',
  APP_ORIGIN: 'https://assignment.example', ASSIGNMENT_IMAGE_DIR: imageRoot,
  ENABLE_ASSIGNMENT_IMAGE_UPLOADS: 'true', ASSIGNMENT_IMAGE_MAX_STORAGE_MB: '1', DB_SSL: 'true', DB_SSL_CA: 'test\\ncertificate'
});

const users = new Map([
  [1, { user_id: 1, name: '학생', grade: 1, class_number: 1, class_approved: 1, is_admin: 0 }],
  [2, { user_id: 2, name: '관리자', grade: 1, class_number: 1, class_approved: 0, is_admin: 1 }],
  [3, { user_id: 3, name: '다른 반 학생', grade: 2, class_number: 2, class_approved: 1, is_admin: 0 }]
]);
const queries = [];
let googleExisting = null;
let healthDown = false;
let queryFailure = false;
let dbOptions;
let completionAllowed = false;
let visibleImage = false;
let capturedInsert;
let calendarReadFixtures = null;
let rosterFixtures = null;
let assignmentWriteFails = false;
let userDeletionFails = false;
let modeWriteFails = false;
let deletedScope = { target_grade: 1, target_class: 1 };
const transactionCalls = [];
let assignmentOwner = 1;
let initiallyReadScope = { target_grade: 2, target_class: 2 };
let lockedScope = { target_grade: 2, target_class: 2 };
let dateAssignment = null;
let dateActorAtLock;
let dateWriteFails = false;
let googleVerificationGate = null;
let concurrentGoogleChecks = 0;
const fakePool = {
  on() { return this; },
  async execute(sql, params = []) {
    queries.push({ sql, params });
    if (sql === 'SELECT 1') {
      if (healthDown) throw Object.assign(new Error('private database detail'), { code: 'ECONNREFUSED' });
      return [[{ 1: 1 }]];
    }
    if (sql.includes('FROM users WHERE google_sub')) return [googleExisting ? [googleExisting] : []];
    if (sql.includes('FROM users WHERE user_id')) {
      if (sql.endsWith('FOR SHARE') && dateActorAtLock !== undefined) return [dateActorAtLock ? [{ ...dateActorAtLock }] : []];
      return [users.has(Number(params[0])) ? [users.get(Number(params[0]))] : []];
    }
    if (sql.startsWith('UPDATE users SET is_admin')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE users SET google_email')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE users SET ')) {
      if (sql.startsWith('UPDATE users SET admin_mode_enabled') && modeWriteFails) throw new Error('test mode write failure');
      const target = users.get(Number(params.at(-1)));
      const fields = sql.slice('UPDATE users SET '.length, sql.indexOf(' WHERE')).split(', ').map(field => field.split(' ')[0]);
      fields.forEach((field, index) => { if (target) target[field] = params[index]; });
      return [{ affectedRows: target ? 1 : 0 }];
    }
    if (sql.startsWith('INSERT INTO users')) {
      capturedInsert = { sql, params };
      return [{ insertId: 101 }];
    }
    if (calendarReadFixtures && sql.includes('FROM assignments a')) return [calendarReadFixtures];
    if (rosterFixtures && sql.includes('FROM users u') && sql.includes('LEFT JOIN user_assignments')) return [rosterFixtures];
    if (rosterFixtures && sql.startsWith('SELECT assignment_id, title, target_grade')) return [[{ assignment_id: 42, title: '우리 반 과제', target_grade: 1, target_class: 2 }]];
    if (sql.startsWith('SELECT assignment_id FROM assignments WHERE assignment_id')) return [completionAllowed ? [{ assignment_id: params[0] }] : []];
    if (sql.startsWith('SELECT assignment_id FROM assignments WHERE INSTR')) return [visibleImage ? [{ assignment_id: 42 }] : []];
    if (sql.startsWith('INSERT INTO user_assignments')) return [{ affectedRows: completionAllowed ? 1 : 0 }];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM users')) {
      if (queryFailure) throw new Error('database password should stay private');
      return [[{ total: users.size }]];
    }
    if (sql.includes('FROM users') && sql.includes('ORDER BY is_admin')) return [[...users.values()]];
    if (sql.startsWith('SELECT assignment_id, created_by, target_grade, target_class, due_date FROM assignments')) return [dateAssignment ? [{ ...dateAssignment }] : []];
    if (sql === 'UPDATE assignments SET due_date = ? WHERE assignment_id = ?') {
      if (dateWriteFails) throw new Error('private database detail during date write');
      const affectedRows = Number(Boolean(dateAssignment && Number(params[1]) === dateAssignment.assignment_id));
      if (affectedRows) dateAssignment.due_date = params[0];
      return [{ affectedRows }];
    }
    if (sql.startsWith('SELECT created_by, target_grade, target_class FROM assignments')) return [[{ created_by: assignmentOwner, ...initiallyReadScope }]];
    if (sql.startsWith('SELECT sender_id FROM messages')) return [[{ sender_id: assignmentOwner }]];
    if (sql.startsWith('DELETE FROM assignments WHERE assignment_id = ? AND') || sql.startsWith('DELETE FROM messages WHERE message_id = ? AND')) {
      return [{ affectedRows: Number(Number(params[2]) === deletedScope.target_grade && Number(params[3]) === deletedScope.target_class) }];
    }
    if (sql.startsWith('SELECT target_grade, target_class FROM assignments')) return [lockedScope ? [lockedScope] : []];
    if (sql.startsWith('INSERT INTO assignments')) return [{ insertId: 42 }];
    if (sql.startsWith('INSERT INTO messages')) return [{ insertId: 71 }];
    if (sql.startsWith('DELETE FROM assignments WHERE created_by') && userDeletionFails) throw new Error('test delete failure');
    if (sql.startsWith('INSERT IGNORE INTO user_assignments') && assignmentWriteFails) throw new Error('fan-out failed');
    if (sql.startsWith('SELECT user_id FROM users WHERE grade')) return [[]];
    return [[]];
  },
  async getConnection() {
    return { execute: this.execute.bind(this), async beginTransaction() { transactionCalls.push('begin'); }, async commit() { transactionCalls.push('commit'); }, async rollback() { transactionCalls.push('rollback'); }, release() { transactionCalls.push('release'); } };
  },
  async end() {}
};
class FakeGoogleClient {
  async verifyIdToken({ idToken, audience }) {
    assert.equal(audience, 'test-client');
    if (googleVerificationGate && idToken.startsWith('rate-concurrent-')) {
      concurrentGoogleChecks++;
      await googleVerificationGate;
    }
    const local = /^rate-[a-z0-9-]+$/.test(idToken) ? idToken : idToken === 'owner' ? '26_40' : idToken === 'approved' ? 'approved' : idToken === 'teacher' ? 'studentteacher' : 'attacker';
    return { getPayload: () => ({ sub: `${local}-sub`, email: `${local}@bssm.hs.kr`, email_verified: true, hd: idToken === 'wrong-hd' ? 'other.example' : idToken === 'missing-hd' ? undefined : 'bssm.hs.kr', name: '기존 관리자 이름' }) };
  }
}
const originalLoad = Module._load;
Module._load = function(name, parent, isMain) {
  if (name === 'mysql2/promise') return { createPool: (config) => { dbOptions = config; return fakePool; } };
  if (name === 'google-auth-library') return { OAuth2Client: FakeGoogleClient };
  if (name === 'openai') throw new Error('Disabled chatbot must never load the AI SDK');
  return originalLoad.apply(this, arguments);
};
let app;
let migrateSchema;
try { ({ app, migrateSchema } = require('../server')); } finally { Module._load = originalLoad; }
let server;
let base;
const session = (id = 1) => jwt.sign({ type: 'session', id }, secret, {
  algorithm: 'HS256', issuer: 'assignment-alarm', audience: 'session', expiresIn: '1h'
});
const setup = () => jwt.sign({ type: 'google-setup', profile: { google_sub: 'attacker-sub' } }, secret, {
  algorithm: 'HS256', issuer: 'assignment-alarm', audience: 'google-setup', expiresIn: '10m'
});
async function request(route, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { response, data, raw };
}

test.before(async () => {
  await fs.mkdir(imageRoot, { recursive: true });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(imageRoot, { recursive: true, force: true });
});
const realNow = Date.now.bind(Date);
let testClock = realNow();
test.beforeEach(t => {
  // Independent scenarios must not share the same account/IP window.
  testClock += 16 * 60_000;
  t.mock.method(Date, 'now', () => testClock);
});

test('public config disables chatbot even with a provider key and supports TLS database options', async () => {
  const { response, data } = await request('/api/public-config');
  assert.equal(response.status, 200);
  assert.equal(data.chatbotEnabled, false);
  assert.equal(data.imagesEnabled, true);
  assert.equal(dbOptions.ssl.rejectUnauthorized, true);
  assert.equal(dbOptions.ssl.ca, 'test\ncertificate');
  assert.equal(dbOptions.timezone, 'Z');
  assert.deepEqual(dbOptions.dateStrings, ['DATE']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('all chatbot entry points are gone and never query the database or provider', async () => {
  const before = queries.length;
  for (const [route, method] of [['/api/chatbot', 'POST'], ['/api/chatbot', 'GET'], ['/chatbot.html', 'GET'], ['/js/chatbot.js', 'GET'], ['/CHATBOT.HTML', 'GET'], ['/%63hatbot.html', 'GET'], ['/js/%2e%2e/chatbot.html', 'GET']]) {
    assert.equal((await request(route, { method })).response.status, 410);
  }
  assert.equal(queries.length, before);
});

test('setup token cannot authorize a session and malformed cookies cannot crash requests', async () => {
  assert.equal((await request('/api/auth/me', { token: setup() })).response.status, 401);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: 'other=%E0%A4%A; assignment_alarm_session=%ZZ' } })).response.status, 401);
  assert.equal((await request('/api/auth/me', { headers: { Cookie: `other=%ZZ; assignment_alarm_session=${session()}` } })).response.status, 200);
  assert.equal((await request('/api/auth/me', { token: session(999) })).response.status, 401);
});

test('cross-origin cookie writes and login/logout are rejected; same origin succeeds', async () => {
  for (const route of ['/api/auth/logout', '/api/auth/google', '/api/user-assignments']) {
    assert.equal((await request(route, { method: 'POST', body: {}, token: session(), headers: { Origin: 'https://evil.example' } })).response.status, 403);
  }
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-site' } })).response.status, 403);
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { Origin: 'null' } })).response.status, 403);
  assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { Origin: 'https://assignment.example', 'Sec-Fetch-Site': 'same-origin' } })).response.status, 200);
});

test('a matching Google display name never claims a legacy account', async () => {
  const before = queries.length;
  const { response, data } = await request('/api/auth/google', { method: 'POST', body: { credential: 'attacker' } });
  assert.equal(response.status, 200);
  assert.equal(data.requiresProfile, true);
  assert.equal(data.user, undefined);
  assert.ok(!queries.slice(before).some(({ sql }) => /WHERE\s+name\s*=/.test(sql)));
  const registered = await request('/api/auth/google/register', { method: 'POST', body: { setupToken: data.setupToken, grade: 1, class_number: 1 } });
  assert.equal(registered.response.status, 200);
  assert.equal(registered.data.user.id, 101);
  assert.equal(capturedInsert.params[1], '기존 관리자 이름');
  assert.equal(capturedInsert.params[7], 0);
});

test('Google login requires the school Workspace hosted-domain claim', async () => {
  for (const credential of ['missing-hd', 'wrong-hd']) {
    const result = await request('/api/auth/google', { method: 'POST', body: { credential } });
    assert.equal(result.response.status, 401);
    assert.equal(result.data.requiresProfile, undefined);
  }
});

test('teacher substring grants no admin; explicit approved email does; stale grants are revoked', async () => {
  for (const [credential, expectedAdmin] of [['teacher', 0], ['approved', 1]]) {
    const initial = await request('/api/auth/google', { method: 'POST', body: { credential } });
    const registered = await request('/api/auth/google/register', { method: 'POST', body: { setupToken: initial.data.setupToken, grade: 1, class_number: 1 } });
    assert.equal(registered.response.status, 200);
    assert.equal(registered.data.user.is_admin, expectedAdmin);
  }
  googleExisting = { ...users.get(2), google_sub: 'attacker-sub', is_admin: 1 };
  const existing = await request('/api/auth/google', { method: 'POST', body: { credential: 'attacker' } });
  assert.equal(existing.data.user.is_admin, 0);
  assert.ok(queries.some(({ sql, params }) => sql.startsWith('UPDATE users SET is_admin = ?') && params[0] === 0));
  googleExisting = null;
});

test('user/profile/admin/completion endpoints enforce ownership and current database roles', async () => {
  assert.equal((await request('/api/users/3', { token: session() })).response.status, 403);
  assert.equal((await request('/api/users/3', { method: 'PUT', body: { is_alarm_enabled: 1 }, token: session() })).response.status, 403);
  assert.equal((await request('/api/admin/users', { token: session() })).response.status, 403);
  assert.equal((await request('/api/user-assignments/3', { token: session() })).response.status, 403);
  assert.equal((await request('/api/users/3/assignments', { token: session() })).response.status, 403);
  completionAllowed = false;
  assert.equal((await request('/api/user-assignments', { method: 'PUT', body: { assignment_id: 42, is_completed: true }, token: session() })).response.status, 403);
  completionAllowed = true;
  assert.equal((await request('/api/user-assignments', { method: 'PUT', body: { assignment_id: 42, is_completed: 'not-a-boolean' }, token: session() })).response.status, 400);
  assert.equal((await request('/api/user-assignments', { method: 'PUT', body: { assignment_id: 42, is_completed: true }, token: session() })).response.status, 200);
  assert.equal((await request('/api/user-assignments', { method: 'PUT', body: { assignment_id: 42, is_completed: true }, token: session(2) })).response.status, 403);
});

test('only the configured verified owner can switch effective admin privileges and restore them without losing eligibility', async () => {
  const owner = { user_id: 40, name: '소유자', grade: 1, class_number: 2, is_admin: 1, admin_mode_enabled: 1,
    google_sub: '26_40-sub', google_email: '26_40@bssm.hs.kr', is_alarm_enabled: 1 };
  users.set(40, owner);
  const change = (enabled, extra = {}) => request('/api/users/me/admin-mode', { method: 'PUT', token: session(40),
    headers: { Origin: 'https://assignment.example' }, body: { enabled, ...extra } });
  try {
    const off = await change(false);
    assert.equal(off.response.status, 200);
    assert.equal(off.data.user.is_admin, 0);
    assert.equal(off.data.user.can_switch_admin_mode, true);
    assert.equal(off.data.user.admin_mode_enabled, false);
    assert.equal(off.data.user.google_sub, undefined);
    assert.equal(owner.is_admin, 1, 'underlying admin eligibility is preserved');
    for (const route of ['/api/admin/users', '/api/admin/assignments', '/api/admin/messages', '/api/users/3', '/api/assignments/42/status']) {
      assert.equal((await request(route, { token: session(40) })).response.status, 403, route);
    }
    for (const route of ['/api/auth/me', '/api/users/40']) {
      const profile = await request(route, { token: session(40) });
      assert.equal(profile.data.is_admin, 0); assert.equal(profile.data.can_switch_admin_mode, true);
    }
    const deletion = await request('/api/admin/users/40', { token: session(2), method: 'DELETE' });
    assert.equal(deletion.response.status, 400, 'owner off still cannot be deleted by another admin');
    const on = await change(true);
    assert.equal(on.data.user.is_admin, 1); assert.equal(on.data.user.admin_mode_enabled, true);
    assert.equal((await request('/api/admin/users', { token: session(40) })).response.status, 200);
    assert.equal((await change(true)).data.success, true, 'idempotent confirmed writes invalidate old role-dependent lists');
    for (const enabled of [0, 1, 'true', null]) assert.equal((await change(enabled)).response.status, 400);
    assert.equal((await change(false, { user_id: 2 })).response.status, 400);
    for (const token of [session(1), session(2)]) {
      assert.equal((await request('/api/users/me/admin-mode', { method: 'PUT', token, headers: { Origin: 'https://assignment.example' }, body: { enabled: true } })).response.status, 403);
    }
    assert.equal((await request('/api/users/me/admin-mode', { method: 'PUT', token: session(40), body: { enabled: false } })).response.status, 403);
    assert.equal((await request('/api/users/me/admin-mode', { method: 'PUT', token: session(40), headers: { Origin: 'https://evil.example' }, body: { enabled: false } })).response.status, 403);
    for (const field of ['admin_mode_enabled', 'can_switch_admin_mode']) {
      assert.equal((await request('/api/users/40', { method: 'PUT', token: session(40), body: { [field]: true } })).response.status, 403);
    }
    modeWriteFails = true;
    assert.equal((await change(false)).response.status, 500);
    assert.equal(owner.admin_mode_enabled, 1);
  } finally { users.delete(40); modeWriteFails = false; }
});

test('owner student mode survives both Google login paths and does not trust a matching unverified identity or ineligible role', async () => {
  const owner = { user_id: 40, name: '소유자', grade: 1, class_number: 2, is_admin: 1, admin_mode_enabled: 0,
    google_sub: '26_40-sub', google_email: '26_40@bssm.hs.kr', is_alarm_enabled: 1 };
  users.set(40, owner); googleExisting = owner;
  try {
    const login = await request('/api/auth/google', { method: 'POST', body: { credential: 'owner' } });
    assert.equal(login.data.user.is_admin, 0); assert.equal(login.data.user.can_switch_admin_mode, true);
    const setupToken = jwt.sign({ type: 'google-setup', profile: { google_sub: owner.google_sub, google_email: owner.google_email, name: owner.name } }, secret,
      { algorithm: 'HS256', issuer: 'assignment-alarm', audience: 'google-setup', expiresIn: '10m' });
    const registered = await request('/api/auth/google/register', { method: 'POST', body: { setupToken, grade: 1, class_number: 2 } });
    assert.equal(registered.data.user.is_admin, 0); assert.equal(owner.admin_mode_enabled, 0);
    for (const change of [{ google_sub: null }, { is_admin: 0 }, { google_email: '26_400@bssm.hs.kr' }]) {
      users.set(40, { ...owner, ...change });
      const result = await request('/api/users/me/admin-mode', { method: 'PUT', token: session(40), headers: { Origin: 'https://assignment.example' }, body: { enabled: true } });
      assert.equal(result.response.status, 403);
    }
  } finally { users.delete(40); googleExisting = null; }
});

test('student mode cannot change or delete formerly owned work outside its current class, including scope changes during a write', async () => {
  const owner = { user_id: 40, name: '소유자', grade: 1, class_number: 2, is_admin: 1, admin_mode_enabled: 0, google_sub: '26_40-sub', google_email: '26_40@bssm.hs.kr' };
  users.set(40, owner); assignmentOwner = 40;
  try {
    initiallyReadScope = { target_grade: 2, target_class: 2 }; deletedScope = { target_grade: 2, target_class: 2 };
    assert.equal((await request('/api/assignments/42', { method: 'PUT', token: session(40), body: { title: '타반 수정' } })).response.status, 403);
    assert.equal((await request('/api/assignments/42', { method: 'DELETE', token: session(40) })).response.status, 403);
    assert.equal((await request('/api/messages/71', { method: 'DELETE', token: session(40) })).response.status, 403);
    initiallyReadScope = { target_grade: 1, target_class: 2 }; lockedScope = { target_grade: 2, target_class: 2 };
    const before = queries.length;
    assert.equal((await request('/api/assignments/42', { method: 'PUT', token: session(40), body: { title: '경쟁 수정' } })).response.status, 403);
    assert.ok(!queries.slice(before).some(({ sql }) => sql.startsWith('UPDATE assignments')));
    lockedScope = initiallyReadScope; deletedScope = initiallyReadScope;
    assert.equal((await request('/api/assignments/42', { method: 'PUT', token: session(40), body: { title: '우리 반 수정' } })).response.status, 200);
    assert.equal((await request('/api/assignments/42', { method: 'DELETE', token: session(40) })).response.status, 200);
    assert.equal((await request('/api/messages/71', { method: 'DELETE', token: session(40) })).response.status, 200);
  } finally { users.delete(40); assignmentOwner = 1; initiallyReadScope = { target_grade: 2, target_class: 2 }; lockedScope = initiallyReadScope; deletedScope = { target_grade: 1, target_class: 1 }; }
});

test('schema migration adds an enabled-by-default admin mode without resetting roles or stored user data', async () => {
  const statements = [];
  await migrateSchema({ async execute(sql) { statements.push(sql); return [[]]; } });
  assert.ok(statements.includes('ALTER TABLE users ADD COLUMN admin_mode_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER is_admin'));
  assert.ok(!statements.some(sql => /^(?:DELETE|DROP TABLE|TRUNCATE|UPDATE users SET (?:is_admin|admin_mode_enabled))/.test(sql)));
});

test('integer and calendar date validation reject partial numbers and nonexistent dates', async () => {
  for (const route of ['/api/users/1abc', '/api/users/-1', '/api/users/9007199254740993']) {
    assert.equal((await request(route, { token: session() })).response.status, 400);
  }
  const payload = { title: '테스트', content: '과제', due_date: '2026-02-30' };
  assert.equal((await request('/api/assignments', { method: 'POST', body: payload, token: session() })).response.status, 400);
  assert.equal((await request('/api/assignments', { method: 'POST', body: { ...payload, due_date: '2026-13-01' }, token: session() })).response.status, 400);
  assert.equal((await request('/api/assignments', { method: 'POST', body: { ...payload, due_date: '2028-02-29' }, token: session() })).response.status, 200);
});

test('assignment creation rolls back if student assignment initialization fails', async () => {
  assignmentWriteFails = true;
  transactionCalls.length = 0;
  const result = await request('/api/assignments', { method: 'POST', body: { title: '롤백 검증', due_date: '2026-10-31' }, token: session() });
  assert.equal(result.response.status, 500);
  assert.deepEqual(transactionCalls, ['begin', 'rollback', 'release']);
  assignmentWriteFails = false;
});

test('partial retarget uses the locked current scope and content-only edits preserve completion rows', async () => {
  initiallyReadScope = { target_grade: 1, target_class: 1 };
  lockedScope = { target_grade: 2, target_class: 1 };
  let before = queries.length;
  const retarget = await request('/api/assignments/42', { method: 'PUT', body: { target_class: 2 }, token: session(2) });
  assert.equal(retarget.response.status, 200);
  const writes = queries.slice(before);
  assert.ok(writes.some(({ sql }) => sql.endsWith('FOR UPDATE')));
  const initialized = writes.find(({ sql }) => sql.startsWith('INSERT IGNORE INTO user_assignments'));
  assert.deepEqual(initialized.params, ['42', 2, 2, 2]);
  before = queries.length;
  assert.equal((await request('/api/assignments/42', { method: 'PUT', body: { title: '이름만 변경' }, token: session(2) })).response.status, 200);
  assert.ok(!queries.slice(before).some(({ sql }) => sql.startsWith('DELETE FROM user_assignments')));
  lockedScope = null;
  assert.equal((await request('/api/assignments/42', { method: 'PUT', body: { title: '삭제된 과제' }, token: session(2) })).response.status, 404);
  initiallyReadScope = lockedScope = { target_grade: 2, target_class: 2 };
});

test('image uploads validate bytes, stay private, and follow assignment visibility', async () => {
  const forged = 'data:image/png;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
  assert.equal((await request('/api/uploads/assignment-image', { method: 'POST', body: { image_data_url: forged }, token: session() })).response.status, 400);
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aONkAAAAASUVORK5CYII=';
  await fs.writeFile(path.join(imageRoot, 'quota-test.bin'), Buffer.alloc(1024 * 1024));
  assert.equal((await request('/api/uploads/assignment-image', { method: 'POST', body: { image_data_url: image }, token: session() })).response.status, 507);
  await fs.unlink(path.join(imageRoot, 'quota-test.bin'));
  const upload = await request('/api/uploads/assignment-image', { method: 'POST', body: { image_data_url: image }, token: session() });
  assert.equal(upload.response.status, 200);
  assert.match(upload.data.url, /^\/uploads\/assignment-images\/1-\d+-[a-f0-9]{32}\.png$/);
  assert.equal((await request(upload.data.url)).response.status, 401);
  assert.equal((await request(upload.data.url.replace('/uploads/', '/%75ploads/'))).response.status, 404);
  assert.equal((await request('/assets/%2e%2e' + upload.data.url)).response.status, 401);
  assert.equal((await request(upload.data.url, { token: session(3) })).response.status, 403);
  const stolenReference = { title: '도용 URL', due_date: '2026-10-31', content: `![이미지](${upload.data.url})` };
  assert.equal((await request('/api/assignments', { method: 'POST', body: stolenReference, token: session(3) })).response.status, 403);
  assignmentOwner = 3;
  assert.equal((await request('/api/assignments/42', { method: 'PUT', body: { content: stolenReference.content }, token: session(3) })).response.status, 403);
  assignmentOwner = 1;
  const own = await request(upload.data.url, { token: session() });
  assert.equal(own.response.status, 200);
  assert.equal(own.response.headers.get('cache-control'), 'private, no-store');
  visibleImage = true;
  assert.equal((await request(upload.data.url, { token: session(3) })).response.status, 200);
  visibleImage = false;
  assert.equal((await request('/uploads/not-a-valid-image.png', { token: session() })).response.status, 404);
});

test('malformed/oversized API bodies and unknown routes return explicit JSON failures', async () => {
  let response = await fetch(`${base}/api/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, '요청 형식이 올바르지 않습니다.');
  assert.equal((await request('/api/auth/google', { method: 'POST', body: { credential: 'x'.repeat(40000) } })).response.status, 413);
  assert.equal((await request('/api/unknown')).response.status, 404);
  queryFailure = true;
  const failed = await request('/api/admin/users', { token: session(2) });
  assert.equal(failed.response.status, 503);
  assert.ok(!failed.raw.includes('password'));
  queryFailure = false;
});

test('health checks distinguish a connected database from an outage', async () => {
  assert.equal((await request('/api/health')).response.status, 200);
  healthDown = true;
  const failed = await request('/api/health');
  assert.equal(failed.response.status, 503);
  assert.deepEqual(failed.data, { status: 'unavailable' });
  healthDown = false;
});

test('class approval no longer blocks existing or newly selected classes and legacy flags stay untouched', async () => {
  users.set(4, { user_id: 4, name: '학생', grade: 1, class_number: 1, class_approved: 0, is_admin: 0 });
  const identity = await request('/api/auth/me', { token: session(4) });
  assert.equal(identity.response.status, 200);
  assert.equal(identity.data.is_class_approved, true);
  assert.equal(identity.data.can_complete_assignments, true);
  for (const route of ['/api/assignments', '/api/messages', '/api/notifications', '/api/users/4', '/api/users/4/assignments', '/api/user-assignments/4']) {
    const result = await request(route, { token: session(4) });
    assert.equal(result.response.status, 200, route);
    assert.notEqual(result.data.code, 'CLASS_APPROVAL_REQUIRED');
  }
  assert.equal(users.get(4).class_approved, 0, 'legacy column is preserved without being an access gate');
});

test('profile ownership and authority remain enforced while admins edit classes without approval', async () => {
  const student = users.get(4);
  for (const body of [{ grade: 2 }, { class_number: 3 }, { is_admin: true }, { can_complete_assignments: true }, { google_email: '26_40@bssm.hs.kr' }, { google_sub: 'forged' }]) {
    assert.equal((await request('/api/users/4', { method: 'PUT', token: session(4), body })).response.status, 403);
  }
  assert.equal((await request('/api/users/3', { method: 'PUT', token: session(4), body: { is_alarm_enabled: true } })).response.status, 403);
  assert.equal((await request('/api/admin/users/4', { method: 'PUT', token: session(4), body: { grade: 1 } })).response.status, 403);
  for (const body of [{ grade: 0 }, { grade: 4 }, { class_number: 5 }, { grade: '2x' }]) {
    assert.equal((await request('/api/admin/users/4', { method: 'PUT', token: session(2), body })).response.status, 400);
  }
  student.class_approved = 1;
  const result = await request('/api/admin/users/4', { method: 'PUT', token: session(2), body: { grade: 3, class_number: 2 } });
  assert.equal(result.response.status, 200);
  assert.equal(student.grade, 3);
  assert.equal(student.class_number, 2);
  assert.equal(student.class_approved, 1, 'class edits do not reset the unused legacy approval column');
  assert.equal(result.data.is_class_approved, true);
  assert.equal(result.data.can_complete_assignments, true);
});

test('verified student admins complete only their own class as themselves while teacher admins stay read-only', async () => {
  users.set(6, { user_id: 6, name: '학생 관리자', grade: 1, class_number: 2, is_admin: 1, google_sub: 'student-admin-sub', google_email: '26_40@bssm.hs.kr' });
  users.set(7, { user_id: 7, name: '선생님', grade: 1, class_number: 2, is_admin: 1, google_sub: 'teacher-sub', google_email: 'teacher12@bssm.hs.kr' });
  users.set(8, { user_id: 8, name: '별도 관리자', grade: 1, class_number: 2, is_admin: 1, google_sub: 'other-admin-sub', google_email: 'staff@bssm.hs.kr' });
  assert.equal((await request('/api/auth/me', { token: session(6) })).data.can_complete_assignments, true);
  assert.equal((await request('/api/auth/me', { token: session(7) })).data.can_complete_assignments, false);
  assert.equal((await request('/api/auth/me', { token: session(8) })).data.can_complete_assignments, false);
  assert.equal((await request('/api/auth/me', { token: session(6) })).data.google_sub, undefined);
  completionAllowed = true;
  const before = queries.length;
  let result = await request('/api/user-assignments', { method: 'PUT', token: session(6), body: { assignment_id: 42, is_completed: true, user_id: 3, target_grade: 3, target_class: 4 } });
  assert.equal(result.response.status, 200);
  const write = queries.slice(before).find(({ sql }) => sql.startsWith('INSERT INTO user_assignments'));
  assert.deepEqual(write.params, [6, 1, 42, 1, 2, 1]);
  assert.match(write.sql, /target_grade = \? AND \(target_class = \? OR target_class IS NULL\)/);
  for (const id of [7, 8]) {
    result = await request('/api/user-assignments', { method: 'PUT', token: session(id), body: { assignment_id: 42, is_completed: true, can_complete_assignments: true } });
    assert.equal(result.response.status, 403);
  }
  completionAllowed = false;
  assert.equal((await request('/api/user-assignments', { method: 'PUT', token: session(6), body: { assignment_id: 99, is_completed: true } })).response.status, 403);
  assert.equal((await request('/api/user-assignments/3', { token: session(6) })).response.status, 403);
});

test('admin calendars join only their own class completion and teacher rosters include student admins', async () => {
  calendarReadFixtures = [{ assignment_id: 42, target_grade: 1, target_class: 2, is_completed: 1 }, { assignment_id: 99, target_grade: 2, target_class: 1, is_completed: 0 }];
  try {
    for (const route of ['/api/assignments', '/api/users/6/assignments']) {
      const before = queries.length;
      const result = await request(route, { token: session(6) });
      assert.equal(result.response.status, 200);
      const read = queries.slice(before).find(({ sql }) => sql.includes('FROM assignments a'));
      assert.deepEqual(read.params, [6, 1, 2]);
      assert.match(read.sql, /ua.user_id = \?/);
      assert.match(read.sql, /a.target_grade = \? AND \(a.target_class = \? OR a.target_class IS NULL\)/);
      assert.equal(result.data[0].is_completed, 1);
      assert.equal(result.data[1].is_completed, 0);
    }
  } finally { calendarReadFixtures = null; }
  rosterFixtures = [users.get(1), users.get(6), users.get(7), users.get(8)].map(user => ({ ...user, is_completed: 1 }));
  try {
    const result = await request('/api/assignments/42/status', { token: session(7) });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data.students.map(user => user.user_id), [1, 6]);
    assert.ok(result.data.students.every(user => user.google_sub === undefined && user.google_email === undefined));
  } finally { rosterFixtures = null; }
});

test('students publish notices only to their own grade or class while administrators choose the target', async () => {
  for (const type of ['grade', 'class']) {
    const before = queries.length;
    const result = await request('/api/messages', { method: 'POST', token: session(1), body: { content: '학생 공지', type, target_grade: 3, target_class: 4, sender_id: 3 } });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.message_id, 71);
    const write = queries.slice(before).find(query => query.sql.startsWith('INSERT INTO messages'));
    assert.deepEqual(write.params, [1, '학생 공지', type, 1, type === 'class' ? 1 : null]);
  }
  const before = queries.length;
  assert.equal((await request('/api/messages', { method: 'POST', token: session(2), body: { content: '관리자 공지', type: 'class', target_grade: 3, target_class: 4 } })).response.status, 200);
  assert.deepEqual(queries.slice(before).find(query => query.sql.startsWith('INSERT INTO messages')).params, [2, '관리자 공지', 'class', 3, 4]);
  assert.equal((await request('/api/messages', { method: 'POST', token: session(1), body: { content: 'bad', type: 'all' } })).response.status, 400);
  assert.equal((await request('/api/messages', { method: 'POST', body: { content: 'anonymous', type: 'grade' } })).response.status, 401);
});

test('deleting a user atomically removes their created assignments and all related completion rows', async () => {
  const before = queries.length, txBefore = transactionCalls.length;
  const result = await request('/api/admin/users/3', { method: 'DELETE', token: session(2) });
  assert.equal(result.response.status, 200);
  const writes = queries.slice(before);
  assert.ok(writes.some(query => query.sql.includes('FOR UPDATE') && query.params[0] === 3));
  for (const prefix of ['DELETE FROM user_assignments WHERE user_id', 'DELETE FROM user_assignments WHERE assignment_id IN', 'DELETE FROM assignments WHERE created_by', 'DELETE FROM messages WHERE sender_id', 'DELETE FROM users WHERE user_id']) {
    assert.ok(writes.some(query => query.sql.startsWith(prefix) && query.params[0] === 3), prefix);
  }
  assert.deepEqual(transactionCalls.slice(txBefore), ['begin', 'commit', 'release']);
  userDeletionFails = true;
  const rollbackBefore = transactionCalls.length;
  try { assert.equal((await request('/api/admin/users/3', { method: 'DELETE', token: session(2) })).response.status, 500); }
  finally { userDeletionFails = false; }
  assert.deepEqual(transactionCalls.slice(rollbackBefore), ['begin', 'rollback', 'release']);
  assert.equal((await request('/api/admin/users/2', { method: 'DELETE', token: session(2) })).response.status, 400);
  assert.equal((await request('/api/admin/users/3', { method: 'DELETE', token: session(1) })).response.status, 403);
});

async function withDateFixture(id, userChanges, run) {
  const previous = users.get(id);
  const user = { user_id: id, name: '날짜 이동 테스트 학생', grade: 1, class_number: 1, is_admin: 0, ...userChanges };
  users.set(id, user);
  dateAssignment = { assignment_id: 42, created_by: id, target_grade: 1, target_class: 1, due_date: '2026-11-17' };
  const move = (body = { due_date: '2026-11-18', expected_due_date: '2026-11-17' }, options = {}) =>
    request('/api/assignments/42/due-date', { method: 'PUT', token: session(id), body, ...options });
  try { await run(move, user); }
  finally {
    if (previous) users.set(id, previous); else users.delete(id);
    dateAssignment = null; dateActorAtLock = undefined; dateWriteFails = false;
  }
}

test('date-only movement requires authentication, strict dates and an exact two-field payload', async () => {
  await withDateFixture(110, {}, async move => {
    assert.equal((await move(undefined, { token: undefined })).response.status, 401);
    assert.equal((await move(undefined, { headers: { Origin: 'https://evil.example' } })).response.status, 403);
    const valid = { due_date: '2026-11-18', expected_due_date: '2026-11-17' };
    const invalid = [{}, { due_date: valid.due_date }, { expected_due_date: valid.expected_due_date },
      { ...valid, due_date: '2026-02-30' }, { ...valid, due_date: '2026-13-01' },
      { ...valid, due_date: '2026-11-18T00:00:00Z' }, { ...valid, due_date: 20261118 },
      { ...valid, due_date: null }, { ...valid, expected_due_date: '2026-02-30' },
      { ...valid, expected_due_date: '2026-11-17 extra' }, { ...valid, title: '다른 필드 변경' },
      { ...valid, created_by: 110, target_grade: 3, target_class: 4, is_admin: true }];
    const before = queries.length;
    for (const body of invalid) assert.equal((await move(body)).response.status, 400, JSON.stringify(body));
    for (const id of ['1abc', '0042', '0', '-1', '9007199254740993']) {
      assert.equal((await request(`/api/assignments/${id}/due-date`, { method: 'PUT', token: session(110), body: valid })).response.status, 400, id);
    }
    assert.ok(!queries.slice(before).some(query => query.sql.startsWith('UPDATE assignments')));
    assert.equal(dateAssignment.due_date, '2026-11-17');
  });
});

test('students move only their own exact current-class assignment and cannot learn a forbidden current date', async () => {
  await withDateFixture(111, {}, async move => {
    const before = queries.length, txBefore = transactionCalls.length;
    const saved = await move();
    assert.equal(saved.response.status, 200);
    assert.deepEqual(saved.data, { success: true, due_date: '2026-11-18' });
    assert.equal(dateAssignment.due_date, '2026-11-18');
    const writes = queries.slice(before);
    assert.ok(writes.some(query => query.sql.endsWith('FOR SHARE') && query.params[0] === 111));
    assert.ok(writes.some(query => query.sql.endsWith('FOR UPDATE') && query.sql.includes('FROM assignments')));
    assert.deepEqual(writes.find(query => query.sql.startsWith('UPDATE assignments')).params, ['2026-11-18', 42]);
    assert.ok(!writes.some(query => /(?:INSERT|DELETE|UPDATE).*user_assignments/.test(query.sql)), 'completion rows remain intact');
    assert.deepEqual(transactionCalls.slice(txBefore), ['begin', 'commit', 'release']);
    for (const changes of [{ created_by: 999 }, { target_grade: 2 }, { target_class: 2 }, { target_class: null }]) {
      dateAssignment = { assignment_id: 42, created_by: 111, target_grade: 1, target_class: 1, due_date: '2026-11-19', ...changes };
      const start = queries.length;
      const forbidden = await move();
      assert.equal(forbidden.response.status, 403, JSON.stringify(changes));
      assert.equal(forbidden.data.due_date, undefined);
      assert.equal(forbidden.data.code, undefined, 'forbidden access is not a date-conflict oracle');
      assert.ok(!queries.slice(start).some(query => query.sql.startsWith('UPDATE assignments')));
    }
  });
});

test('active admins can move every assignment regardless of author, class, or completion eligibility', async () => {
  await withDateFixture(112, { is_admin: 1, google_sub: 'teacher-admin-test', google_email: 'teacher999@bssm.hs.kr' }, async move => {
    for (const target_class of [1, 4, null]) {
      dateAssignment = { assignment_id: 42, created_by: 999, target_grade: 3, target_class, due_date: '2026-11-17' };
      const result = await move();
      assert.equal(result.response.status, 200);
      assert.equal(result.data.due_date, '2026-11-18');
      assert.equal(dateAssignment.created_by, 999); assert.equal(dateAssignment.target_grade, 3); assert.equal(dateAssignment.target_class, target_class);
    }
  });
});

test('owner student mode restricts date movement to owned current-class tasks while admin mode restores global movement', async () => {
  await withDateFixture(113, { is_admin: 1, admin_mode_enabled: 0, google_sub: '26_40-sub', google_email: '26_40@bssm.hs.kr' }, async (move, owner) => {
    assert.equal((await move()).response.status, 200);
    dateAssignment = { assignment_id: 42, created_by: 113, target_grade: 2, target_class: 4, due_date: '2026-11-17' };
    assert.equal((await move()).response.status, 403);
    dateAssignment.created_by = 999; dateAssignment.target_grade = 1; dateAssignment.target_class = 1;
    assert.equal((await move()).response.status, 403);
    owner.admin_mode_enabled = 1;
    assert.equal((await move()).response.status, 200);
  });
});

test('date movement rechecks locked database authority after authentication and uses the current locked assignment scope', async () => {
  await withDateFixture(114, { is_admin: 1 }, async (move, user) => {
    dateAssignment.created_by = 999; dateAssignment.target_grade = 3; dateAssignment.target_class = 4;
    dateActorAtLock = { ...user, is_admin: 0 };
    assert.equal((await move()).response.status, 403, 'a role revoked after authentication cannot move other users tasks');
    dateAssignment.created_by = 114; dateAssignment.target_grade = 1; dateAssignment.target_class = 1;
    dateActorAtLock = { ...user, is_admin: 0, class_number: 2 };
    assert.equal((await move()).response.status, 403, 'a freshly changed class is authoritative');
    dateActorAtLock = { ...user, is_admin: 0 };
    dateAssignment.target_class = 4;
    assert.equal((await move()).response.status, 403, 'the locked current assignment scope is authoritative');
    dateAssignment.target_class = 1;
    for (const changes of [{ grade: null }, { class_number: null }, { grade: 0 }, { class_number: 0 }, { grade: 4 }, { class_number: 5 }]) {
      dateActorAtLock = { ...user, is_admin: 0, ...changes };
      assert.equal((await move()).response.status, 403, JSON.stringify(changes));
    }
    dateActorAtLock = { ...user, is_admin: 0, class_number: null };
    dateAssignment.target_class = null;
    assert.equal((await move()).response.status, 403, 'null actor class must not match a grade-wide assignment');
    dateActorAtLock = null;
    assert.equal((await move()).response.status, 401);
  });
});

test('stale drags return only the authorized authoritative date, missing tasks return 404, and unchanged dates are harmless', async () => {
  await withDateFixture(115, {}, async move => {
    const original = dateAssignment;
    dateAssignment = null;
    assert.equal((await move()).response.status, 404);
    dateAssignment = original;
    const before = queries.length;
    const conflict = await move({ due_date: '2026-11-18', expected_due_date: '2026-11-16' });
    assert.equal(conflict.response.status, 409); assert.equal(conflict.data.code, 'ASSIGNMENT_DATE_CONFLICT');
    assert.equal(conflict.data.due_date, '2026-11-17');
    assert.ok(!queries.slice(before).some(query => query.sql.startsWith('UPDATE assignments')));
    const unchanged = await move({ due_date: '2026-11-17', expected_due_date: '2026-11-17' });
    assert.deepEqual(unchanged.data, { success: true, due_date: '2026-11-17' });
    assert.equal((await move({ due_date: '2028-02-29', expected_due_date: '2026-11-17' })).response.status, 200);
    const stale = await move();
    assert.equal(stale.response.status, 409); assert.equal(stale.data.due_date, '2028-02-29');
    assert.equal(dateAssignment.due_date, '2028-02-29');
  });
});

test('date-write failures roll back without leaking database details and use the existing per-user write limit', async () => {
  await withDateFixture(116, {}, async move => {
    dateWriteFails = true;
    const txBefore = transactionCalls.length;
    const result = await move();
    assert.equal(result.response.status, 503); assert.ok(!result.raw.includes('private database'));
    assert.equal(dateAssignment.due_date, '2026-11-17');
    assert.deepEqual(transactionCalls.slice(txBefore), ['begin', 'rollback', 'release']);
  });
  await withDateFixture(117, {}, async move => {
    const sameDate = { due_date: '2026-11-17', expected_due_date: '2026-11-17' };
    for (let attempt = 0; attempt < 120; attempt++) assert.equal((await move(sameDate)).response.status, 200);
    const txBefore = transactionCalls.length;
    const limited = await move(sameDate);
    assert.equal(limited.response.status, 429); assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
    assert.equal(transactionCalls.length, txBefore, 'a rate-limited drag never enters a write transaction');
  });
});

test('creation bursts share an account budget across tasks and notices without blocking corrections or completion', async () => {
  await withDateFixture(201, {}, async move => {
    const sameDate = { due_date: '2026-11-17', expected_due_date: '2026-11-17' };
    const task = { title: '정상 과제', due_date: '2026-11-17' };
    const notice = { content: '정상 공지', type: 'class' };
    for (const [route, body] of [['/api/assignments', task], ['/api/messages', notice], ['/api/assignments', task]]) {
      assert.equal((await request(route, { method: 'POST', token: session(201), body })).response.status, 200);
    }
    const before = queries.length;
    const blocked = await request('/api/messages', { method: 'POST', token: session(201), body: notice });
    assert.equal(blocked.response.status, 429); assert.equal(blocked.data.code, 'CREATE_RATE_LIMITED');
    assert.equal(blocked.response.headers.get('retry-after'), '10');
    assert.ok(!queries.slice(before).some(query => query.sql.startsWith('INSERT INTO')));
    for (let index = 0; index < 25; index++) assert.equal((await move(sameDate)).response.status, 200);
    completionAllowed = true;
    try {
      assert.equal((await request('/api/user-assignments', { method: 'PUT', token: session(201), body: { assignment_id: 42, is_completed: true } })).response.status, 200);
    } finally { completionAllowed = false; }
  });
});

test('spaced creation remains limited to twenty per account in the shared ten-minute window', async () => {
  await withDateFixture(202, {}, async () => {
    for (let index = 0; index < 20; index++) {
      if (index && index % 3 === 0) testClock += 10001;
      const result = await request('/api/messages', { method: 'POST', token: session(202), body: { content: '시간 간격 검증', type: 'class' } });
      assert.equal(result.response.status, 200);
    }
    const blocked = await request('/api/assignments', { method: 'POST', token: session(202), body: { title: '공유 예산 검증', due_date: '2026-11-17' } });
    assert.equal(blocked.response.status, 429); assert.equal(blocked.data.code, 'CREATE_RATE_LIMITED');
    assert.ok(Number(blocked.response.headers.get('retry-after')) > 500);
    testClock += 600000;
    assert.equal((await request('/api/messages', { method: 'POST', token: session(202), body: { content: '기간 만료', type: 'class' } })).response.status, 200);
  });
});

test('verified signup attempts accumulate across successful responses, rotated IPs and forged body identities', async () => {
  const previousTrust = app.get('trust proxy');
  app.set('trust proxy', 'loopback');
  try {
    const auth = await request('/api/auth/google', { method: 'POST', body: { credential: 'rate-signup' }, headers: { 'X-Forwarded-For': '198.51.100.200' } });
    assert.equal(auth.response.status, 200); assert.ok(auth.data.setupToken);
    googleExisting = { ...users.get(1), google_sub: 'rate-signup-sub', google_email: 'rate-signup@bssm.hs.kr' };
    for (let index = 0; index < 20; index++) {
      const result = await request('/api/auth/google/register', { method: 'POST', headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` },
        body: { setupToken: auth.data.setupToken, google_sub: 'forged-' + index, google_email: 'forged-' + index + '@bssm.hs.kr' } });
      assert.equal(result.response.status, 200);
    }
    const before = queries.length;
    const blocked = await request('/api/auth/google/register', { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.99' }, body: { setupToken: auth.data.setupToken } });
    assert.equal(blocked.response.status, 429); assert.equal(blocked.data.code, 'REGISTRATION_RATE_LIMITED');
    assert.equal(blocked.response.headers.get('retry-after'), '900');
    assert.equal(queries.length, before, 'rejected registration does not query or hash a new password');
    assert.ok(!blocked.raw.includes('rate-signup'));
  } finally { googleExisting = null; app.set('trust proxy', previousTrust); }
});

test('successful Google logins cannot reset the verified account limit by changing IP address', async () => {
  const previousTrust = app.get('trust proxy'); app.set('trust proxy', 'loopback');
  googleExisting = { ...users.get(1), google_sub: 'rate-login-sub', google_email: 'rate-login@bssm.hs.kr' };
  try {
    for (let index = 0; index < 30; index++) {
      const result = await request('/api/auth/google', { method: 'POST', body: { credential: 'rate-login', google_sub: 'ignored-' + index }, headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` } });
      assert.equal(result.response.status, 200);
    }
    const blocked = await request('/api/auth/google', { method: 'POST', body: { credential: 'rate-login' }, headers: { 'X-Forwarded-For': '203.0.113.99' } });
    assert.equal(blocked.response.status, 429); assert.equal(blocked.data.code, 'AUTH_IDENTITY_RATE_LIMITED');
    assert.equal(blocked.response.headers.get('retry-after'), '900');
    assert.ok(!blocked.raw.includes('rate-login'));
  } finally { googleExisting = null; app.set('trust proxy', previousTrust); }
});

test('many school members can authenticate on one trusted IP while successful setup responses retain its total cap', async () => {
  const previousTrust = app.get('trust proxy'); app.set('trust proxy', 'loopback');
  try {
    for (let index = 0; index < 300; index++) {
      const result = await request('/api/auth/google', { method: 'POST', body: { credential: 'rate-campus-' + index }, headers: { 'X-Forwarded-For': '198.51.100.240' } });
      assert.equal(result.response.status, 200, 'verified new members do not accumulate failed logins');
      assert.equal(result.data.requiresProfile, true);
    }
    const blocked = await request('/api/auth/google', { method: 'POST', body: { credential: 'rate-campus-last' }, headers: { 'X-Forwarded-For': '198.51.100.240' } });
    assert.equal(blocked.response.status, 429); assert.equal(blocked.data.code, 'AUTH_IP_RATE_LIMITED');
    assert.equal(blocked.response.headers.get('retry-after'), '900');
  } finally { app.set('trust proxy', previousTrust); }
});

test('simultaneous legitimate school Google checks are not counted as failed authentications', async () => {
  const previousTrust = app.get('trust proxy'); app.set('trust proxy', 'loopback');
  let release;
  googleVerificationGate = new Promise(resolve => { release = resolve; });
  concurrentGoogleChecks = 0;
  const requests = Array.from({ length: 35 }, (_, index) => request('/api/auth/google', {
    method: 'POST', body: { credential: 'rate-concurrent-' + index }, headers: { 'X-Forwarded-For': '198.51.100.241' }
  }));
  try {
    for (let tick = 0; tick < 200 && concurrentGoogleChecks < 35; tick++) await new Promise(resolve => setTimeout(resolve, 1));
    const admittedBeforeVerification = concurrentGoogleChecks;
    release();
    const results = await Promise.all(requests);
    assert.equal(admittedBeforeVerification, 35);
    assert.ok(results.every(result => result.response.status === 200));
  } finally { release(); await Promise.all(requests); googleVerificationGate = null; app.set('trust proxy', previousTrust); }
});

test('image limits follow authenticated accounts across IP changes and do not consume the creation budget', async () => {
  const previousTrust = app.get('trust proxy'); app.set('trust proxy', 'loopback');
  try {
    await withDateFixture(203, {}, async () => {
      for (let index = 0; index < 10; index++) {
        const result = await request('/api/uploads/assignment-image', { method: 'POST', token: session(203), body: {}, headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` } });
        assert.equal(result.response.status, 400);
      }
      const blocked = await request('/api/uploads/assignment-image', { method: 'POST', token: session(203), body: {}, headers: { 'X-Forwarded-For': '203.0.113.99' } });
      assert.equal(blocked.response.status, 429); assert.equal(blocked.data.code, 'IMAGE_UPLOAD_RATE_LIMITED');
      assert.equal(blocked.response.headers.get('retry-after'), '600');
      assert.equal((await request('/api/messages', { method: 'POST', token: session(203), body: { content: '업로드와 별도 예산', type: 'class' } })).response.status, 200);
    });
  } finally { app.set('trust proxy', previousTrust); }
});

test('untrusted forwarded addresses cannot rotate the failed authentication IP limit or unlock disabled local registration', async () => {
  const previousTrust = app.get('trust proxy'); app.set('trust proxy', false);
  try {
    for (let index = 0; index < 20; index++) {
      const route = index % 2 ? '/api/auth/login' : '/api/auth/register';
      const result = await request(route, { method: 'POST', body: { name: 'ignored', is_admin: true }, headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` } });
      assert.equal(result.response.status, 403);
    }
    const blocked = await request('/api/auth/google/register', { method: 'POST', body: { setupToken: 'invalid' }, headers: { 'X-Forwarded-For': '203.0.113.99' } });
    assert.equal(blocked.response.status, 429); assert.equal(blocked.data.code, 'AUTH_RATE_LIMITED');
    assert.equal(blocked.response.headers.get('retry-after'), '900');
  } finally { app.set('trust proxy', previousTrust); }
});

test('school schedules require authentication, strict month query and current grade privileges', async t => {
  const { SchoolSchedule } = require('../lib/school-schedule');
  let reads = 0;
  t.mock.method(SchoolSchedule.prototype, 'getMonth', async month => { reads++; return { month, school: '부산소프트웨어마이스터고등학교', source: 'https://open.neis.go.kr', events: [{ id: 'one', grades: [1] }, { id: 'two', grades: [2] }, { id: 'all', grades: [1, 2, 3] }] }; });
  assert.equal((await request('/api/school-events?month=2026-12')).response.status, 401);
  for (const query of ['month=2026-13', 'month=2026-12&month=2026-11', 'month=2026-12&school=other', '']) assert.equal((await request('/api/school-events?' + query, { token: session() })).response.status, 400);
  assert.equal(reads, 0);
  const student = await request('/api/school-events?month=2026-12', { token: session(1) });
  assert.equal(student.response.status, 200); assert.deepEqual(student.data.events.map(event => event.id), ['one', 'all']);
  assert.deepEqual((await request('/api/school-events?month=2026-12', { token: session(3) })).data.events.map(event => event.id), ['two', 'all']);
  assert.equal((await request('/api/school-events?month=2026-12', { token: session(2) })).data.events.length, 3);
  const admin = { ...users.get(2) };
  try {
    Object.assign(users.get(2), { is_admin: 0, grade: 1 });
    assert.equal((await request('/api/school-events?month=2026-12', { token: session(2) })).data.events.length, 2);
  } finally { users.set(2, admin); }
});
test('school schedule provider errors stay private and retry requests have a separate per-user budget', async t => {
  const { SchoolSchedule } = require('../lib/school-schedule');
  let reads = 0;
  t.mock.method(SchoolSchedule.prototype, 'getMonth', async () => { reads++; throw Object.assign(new Error('secret-provider-key'), { code: 'NEIS_NOT_CONFIGURED' }); });
  for (let index = 0; index < 30; index++) {
    const result = await request('/api/school-events?month=2026-12', { token: session(1), headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` } });
    assert.equal(result.response.status, 503); assert.equal(result.data.code, 'SCHOOL_EVENTS_NOT_CONFIGURED'); assert.ok(!result.raw.includes('secret-provider-key'));
  }
  const blocked = await request('/api/school-events?month=2026-11', { token: session(1) });
  assert.equal(blocked.response.status, 429); assert.equal(blocked.data.code, 'SCHOOL_EVENTS_RATE_LIMITED'); assert.equal(reads, 30);
  assert.equal((await request('/api/school-events?month=2026-12', { token: session(3) })).response.status, 503);
  assert.equal((await request('/api/assignments', { token: session(1) })).response.status, 200);
  assert.equal((await request('/api/school-events?month=2026-12', { token: session(1), method: 'POST', body: {} })).response.status, 404);
});
