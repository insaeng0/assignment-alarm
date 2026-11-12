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
  GOOGLE_CLIENT_ID: 'test-client', ADMIN_GOOGLE_EMAILS: 'approved@bssm.hs.kr',
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
let transferredDuringLookup = false;
let transferLookupCount = 0;
let assignmentWriteFails = false;
const transactionCalls = [];
let assignmentOwner = 1;
let initiallyReadScope = { target_grade: 2, target_class: 2 };
let lockedScope = { target_grade: 2, target_class: 2 };
const fakePool = {
  async execute(sql, params = []) {
    queries.push({ sql, params });
    if (sql === 'SELECT 1') {
      if (healthDown) throw Object.assign(new Error('private database detail'), { code: 'ECONNREFUSED' });
      return [[{ 1: 1 }]];
    }
    if (sql.includes('FROM users WHERE google_sub')) return [googleExisting ? [googleExisting] : []];
    if (sql.includes('FROM users WHERE user_id')) {
      if (transferredDuringLookup && params[0] === 5) {
        transferLookupCount += 1;
        return [[{ user_id: 5, name: '이동 중인 학생', grade: transferLookupCount > 1 ? 2 : 1, class_number: 1, class_approved: transferLookupCount > 1 ? 0 : 1, is_admin: 0 }]];
      }
      return [users.has(params[0]) ? [users.get(params[0])] : []];
    }
    if (sql.startsWith('UPDATE users SET is_admin')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE users SET google_email')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE users SET ') && (sql.includes('class_approved = ?') || sql.startsWith('UPDATE users SET grade'))) {
      const target = users.get(params.at(-1));
      const fields = sql.slice('UPDATE users SET '.length, sql.indexOf(' WHERE')).split(', ').map(field => field.split(' ')[0]);
      fields.forEach((field, index) => { if (target) target[field] = params[index]; });
      return [{ affectedRows: target ? 1 : 0 }];
    }
    if (sql.startsWith('INSERT INTO users')) {
      capturedInsert = { sql, params };
      return [{ insertId: 101 }];
    }
    if (sql.startsWith('SELECT assignment_id FROM assignments WHERE assignment_id')) return [completionAllowed ? [{ assignment_id: params[0] }] : []];
    if (sql.startsWith('SELECT assignment_id FROM assignments WHERE INSTR')) return [visibleImage ? [{ assignment_id: 42 }] : []];
    if (sql.startsWith('INSERT INTO user_assignments')) return [{ affectedRows: completionAllowed ? 1 : 0 }];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM users')) {
      if (queryFailure) throw new Error('database password should stay private');
      return [[{ total: users.size }]];
    }
    if (sql.includes('FROM users') && sql.includes('ORDER BY is_admin')) return [[...users.values()]];
    if (sql.startsWith('SELECT created_by, target_grade, target_class FROM assignments')) return [[{ created_by: assignmentOwner, ...initiallyReadScope }]];
    if (sql.startsWith('SELECT target_grade, target_class FROM assignments')) return [lockedScope ? [lockedScope] : []];
    if (sql.startsWith('INSERT INTO assignments')) return [{ insertId: 42 }];
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
    const local = idToken === 'approved' ? 'approved' : idToken === 'teacher' ? 'studentteacher' : 'attacker';
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

test('public config disables chatbot even with a provider key and supports TLS database options', async () => {
  const { response, data } = await request('/api/public-config');
  assert.equal(response.status, 200);
  assert.equal(data.chatbotEnabled, false);
  assert.equal(data.imagesEnabled, true);
  assert.equal(dbOptions.ssl.rejectUnauthorized, true);
  assert.equal(dbOptions.ssl.ca, 'test\ncertificate');
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

test('pending class membership can inspect identity and log out but cannot read or mutate class data', async () => {
  users.set(4, { user_id: 4, name: '승인 대기 학생', grade: 1, class_number: 1, class_approved: 0, is_admin: 0 });
  const identity = await request('/api/auth/me', { token: session(4) });
  assert.equal(identity.response.status, 200);
  assert.equal(identity.data.is_class_approved, false);
  const protectedRoutes = [
    ['/api/assignments', 'GET'], ['/api/messages', 'GET'], ['/api/notifications', 'GET'],
    ['/api/users/4', 'GET'], ['/api/users/4/assignments', 'GET'], ['/api/user-assignments/4', 'GET'],
    ['/api/assignments', 'POST'], ['/api/user-assignments', 'PUT'], ['/api/users/4', 'PUT'],
    ['/api/admin/users/4', 'PUT'], ['/api/uploads/assignment-image', 'POST'],
    [`/uploads/assignment-images/4-1234-${'a'.repeat(32)}.png`, 'GET']
  ];
  for (const [route, method] of protectedRoutes) {
    const result = await request(route, { method, token: session(4), ...(method === 'GET' ? {} : { body: { class_approved: true } }) });
    assert.equal(result.response.status, 403, route);
    assert.equal(result.data.code, 'CLASS_APPROVAL_REQUIRED', route);
  }
  assert.equal((await request('/api/auth/logout', { method: 'POST', token: session(4) })).response.status, 200);
  assert.equal((await request('/api/admin/users', { token: session(2) })).response.status, 200);
});

test('only admins approve classes and moving a student resets approval unless explicitly reapproved', async () => {
  const student = users.get(4);
  assert.equal((await request('/api/admin/users/4', { method: 'PUT', token: session(), body: { class_approved: true } })).response.status, 403);
  transactionCalls.length = 0;
  let result = await request('/api/admin/users/4', { method: 'PUT', token: session(2), body: { class_approved: true } });
  assert.equal(result.response.status, 200);
  assert.equal(student.class_approved, 1);
  assert.ok(queries.some(({ sql }) => sql.includes('class_approved FROM users') && sql.endsWith('FOR UPDATE')));
  assert.deepEqual(transactionCalls, ['begin', 'commit', 'release']);
  assert.equal((await request('/api/auth/me', { token: session(4) })).data.is_class_approved, true);
  for (const body of [{ grade: 2 }, { class_number: 2 }, { class_approved: true }, { is_class_approved: true }, { is_admin: true }]) {
    assert.equal((await request('/api/users/4', { method: 'PUT', token: session(4), body })).response.status, 403);
  }
  result = await request('/api/admin/users/4', { method: 'PUT', token: session(2), body: { grade: 2 } });
  assert.equal(result.response.status, 200);
  assert.equal(student.grade, 2);
  assert.equal(student.class_approved, 0);
  assert.equal((await request('/api/assignments', { token: session(4) })).data.code, 'CLASS_APPROVAL_REQUIRED');
  result = await request('/api/admin/users/4', { method: 'PUT', token: session(2), body: { grade: 3, class_number: 2, class_approved: true } });
  assert.equal(result.response.status, 200);
  assert.equal(student.class_approved, 1);
  assert.equal(student.grade, 3);
  assert.equal(student.class_number, 2);
  const list = await request('/api/admin/users', { token: session(2) });
  assert.equal(list.data.items.find(item => item.user_id === 4).is_class_approved, true);
});

test('migration adds unverified class membership as pending and never autoapproves existing users', async () => {
  for (const exists of [false, true]) {
    const statements = [];
    await migrateSchema({ async execute(sql) {
      statements.push(sql);
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS') && sql.includes("COLUMN_NAME = 'class_approved'")) return [exists ? [{ COLUMN_NAME: 'class_approved' }] : []];
      return [[]];
    } });
    const approvalChanges = statements.filter(sql => /ALTER TABLE users ADD COLUMN class_approved/.test(sql));
    assert.equal(approvalChanges.length, exists ? 0 : 1);
    if (!exists) assert.match(approvalChanges[0], /NOT NULL DEFAULT 0/);
    assert.ok(!statements.some(sql => /UPDATE users SET class_approved\s*=\s*1/.test(sql)));
  }
});

test('a concurrent unapproved class transfer cannot introduce a newly readable class scope', async () => {
  transferredDuringLookup = true;
  transferLookupCount = 0;
  const before = queries.length;
  try {
    const result = await request('/api/assignments', { token: session(5) });
    assert.equal(result.response.status, 404);
    assert.equal(transferLookupCount, 2);
    assert.ok(!queries.slice(before).some(({ sql }) => sql.includes('FROM assignments')));
  } finally { transferredDuringLookup = false; }
});
