const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const jwt = require('jsonwebtoken');
const { importRoster, academicYearAt } = require('../lib/student-roster');
const { rosterDatabase } = require('./helpers/roster-db');
const year = academicYearAt(), cohort = String(year % 100).padStart(2, '0');
const secret = 'roster-tests-only-synthetic-signing-secret-over-32-bytes';
const profiles = {
  one: { name: '가상 단일', sub: 'one', email: `${cohort}_101@bssm.hs.kr` },
  sameA: { name: '가상 동명', sub: 'same-a', email: `${cohort}_102@bssm.hs.kr` },
  sameB: { name: '가상 동명', sub: 'same-b', email: `${cohort}_103@bssm.hs.kr` },
  other: { name: '가상 없음', sub: 'other', email: `${cohort}_104@bssm.hs.kr` },
  older: { name: '가상 단일', sub: 'older', email: `${String((year - 1) % 100).padStart(2, '0')}_105@bssm.hs.kr` },
  teacher: { name: '가상 단일', sub: 'teacher', email: 'teacher1@bssm.hs.kr' },
  admin: { name: '가상 단일', sub: 'admin', email: `${cohort}_106@bssm.hs.kr` }
};
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: secret, DB_USER: 'test', DB_PASSWORD: 'test', GOOGLE_CLIENT_ID: 'test-client',
  APP_ORIGIN: 'https://roster.example', FRONTEND_ORIGIN: '', PAGES_AUTH_MODE: 'cookie', AUTH_REALM_ID: '',
  ADMIN_GOOGLE_EMAILS: profiles.admin.email, ADMIN_MODE_OWNER_EMAIL: '', ALLOW_TEACHER_NUMBER_ADMINS: 'true', ADMIN_EXCLUDED_GOOGLE_EMAILS: '' });
let db = rosterDatabase();
const fakePool = { on() {}, execute: (...args) => db.execute(...args), getConnection: () => db.getConnection(), async end() {} };
const load = Module._load;
Module._load = function(name) {
  if (name === 'mysql2/promise') return { createPool: () => fakePool };
  if (name === 'google-auth-library') return { OAuth2Client: class { async verifyIdToken({ idToken }) {
    const profile = profiles[idToken]; if (!profile) throw new Error('synthetic bad Google credential');
    return { getPayload: () => ({ ...profile, email_verified: true, hd: 'bssm.hs.kr' }) };
  } } };
  return load.apply(this, arguments);
};
let app; try { ({ app } = require('../server')); } finally { Module._load = load; }
let server, base;
const roster = () => ({ academic_year: year, grade: 1, entries: [
  { name: '가상 단일', class_number: 1 }, { name: '가상 동명', class_number: 2 }, { name: '가상 동명', class_number: 3 }
] });
async function request(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: 'https://roster.example', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const google = credential => request('/api/auth/google', { credential });
const register = (setupToken, data = {}) => request('/api/auth/google/register', { setupToken, ...data });
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(done => server.once('listening', done)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(done => server.close(done)); });
test.beforeEach(async () => { db = rosterDatabase(); await importRoster(db, roster()); });

test('school login returns only unclaimed same-name opaque candidates and signs the required scope without exposing the roster', async () => {
  const one = await google('one'); assert.equal(one.status, 200); assert.equal(one.data.rosterRequired, true); assert.equal(one.data.rosterCandidates.length, 1);
  assert.deepEqual(Object.keys(one.data.rosterCandidates[0]), ['roster_id', 'grade', 'class_number', 'name']);
  assert.match(one.data.rosterCandidates[0].roster_id, /^[a-f0-9-]{36}$/);
  const token = jwt.verify(one.data.setupToken, secret, { issuer: 'assignment-alarm', audience: 'google-setup', algorithms: ['HS256'] });
  assert.deepEqual(token.roster, { academic_year: year, grade: 1, required: true });
  assert.equal(token.profile.roster_name, '가상단일'); assert.equal(JSON.stringify(token).includes('가상 동명'), false);
  const same = await google('sameA'); assert.equal(same.data.rosterCandidates.length, 2);
  assert.deepEqual(same.data.rosterCandidates.map(row => row.class_number), [2, 3]);
  for (const route of ['/api/roster', '/api/roster/candidates', '/api/student-roster']) assert.equal((await request(route)).status, 404);
});

test('registration requires a live same-name selection, rejects field tampering and commits user and claim together', async () => {
  const auth = await google('one'), candidate = auth.data.rosterCandidates[0];
  let result = await register(auth.data.setupToken, { grade: 1, class_number: 4 });
  assert.equal(result.status, 400); assert.equal(result.data.code, 'ROSTER_SELECTION_REQUIRED'); assert.equal(db.state.users.size, 0);
  result = await register(auth.data.setupToken, { roster_id: candidate.roster_id, grade: 2, class_number: 4 });
  assert.equal(result.status, 400); assert.equal(db.state.users.size, 0);
  const otherId = [...db.state.entries.values()].find(row => row.name === '가상 동명').roster_id;
  assert.equal((await register(auth.data.setupToken, { roster_id: otherId, grade: 1, class_number: 2, name: '가상 동명' })).status, 400);
  result = await register(auth.data.setupToken, { roster_id: candidate.roster_id });
  assert.equal(result.status, 200); assert.equal(result.data.user.grade, 1); assert.equal(result.data.user.class_number, 1);
  assert.equal(db.state.entries.get(candidate.roster_id).claimed_user_id, result.data.user.id); assert.equal(db.state.users.size, 1);
  const replay = await register(auth.data.setupToken, { roster_id: otherId, grade: 3, class_number: 4 });
  assert.equal(replay.status, 200); assert.equal(replay.data.user.id, result.data.user.id); assert.equal(replay.data.user.class_number, 1);
});

test('unknown names, unavailable grades, teachers and configured admins keep manual class selection without an approval gate', async () => {
  for (const credential of ['other', 'older', 'teacher', 'admin']) {
    const auth = await google(credential); assert.equal(auth.data.rosterRequired, false, credential); assert.deepEqual(auth.data.rosterCandidates, []);
    const registered = await register(auth.data.setupToken, { grade: 2, class_number: 4 });
    assert.equal(registered.status, 200, credential); assert.equal(registered.data.user.class_number, 4); assert.equal(registered.data.user.is_class_approved, true);
  }
});

test('a setup issued before a matching import cannot bypass newly required selection and a removed signed candidate cannot become manual', async () => {
  await importRoster(db, { academic_year: year, grade: 1, entries: [{ name: '가상 새이름', class_number: 4 }] });
  const before = await google('one'); assert.equal(before.data.rosterRequired, false);
  await importRoster(db, roster());
  assert.equal((await register(before.data.setupToken, { grade: 3, class_number: 4 })).data.code, 'ROSTER_SELECTION_REQUIRED');
  const required = await google('one');
  await importRoster(db, { academic_year: year, grade: 1, entries: [{ name: '가상 새이름', class_number: 4 }] });
  assert.equal((await register(required.data.setupToken, { grade: 3, class_number: 4 })).data.code, 'ROSTER_SELECTION_REQUIRED');
  assert.equal(db.state.users.size, 0);
});

test('two different accounts cannot claim one homonym place and an already-linked member cannot retarget through another candidate', async () => {
  const a = await google('sameA'), b = await google('sameB'), selected = a.data.rosterCandidates[0];
  const results = await Promise.all([register(a.data.setupToken, { roster_id: selected.roster_id }), register(b.data.setupToken, { roster_id: selected.roster_id })]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]); assert.equal(db.state.users.size, 1);
  const winner = results.findIndex(row => row.status === 200), winnerCredential = winner === 0 ? 'sameA' : 'sameB';
  const linked = await google(winnerCredential); assert.equal(linked.data.requiresProfile, undefined); assert.equal(linked.data.user.class_number, selected.class_number);
  const winnerToken = winner === 0 ? a.data.setupToken : b.data.setupToken;
  const again = await register(winnerToken, { roster_id: a.data.rosterCandidates[1].roster_id, grade: 1, class_number: 3 });
  assert.equal(again.status, 200); assert.equal(again.data.user.class_number, selected.class_number);
  assert.equal([...db.state.entries.values()].filter(row => row.claimed_user_id !== null).length, 1);
  const loser = await google(winner === 0 ? 'sameB' : 'sameA'); assert.equal(loser.data.rosterCandidates.length, 1);
  assert.equal(loser.data.rosterAmbiguous, true, 'one available place still requires explicit choice when the name is ambiguous');
});

test('the same Google sub cannot take two homonym places through concurrent signup requests', async () => {
  const auth = await google('sameA');
  const results = await Promise.all(auth.data.rosterCandidates.map(candidate => register(auth.data.setupToken, { roster_id: candidate.roster_id })));
  assert.ok(results.every(result => [200, 409].includes(result.status)));
  assert.equal(db.state.users.size, 1); assert.equal([...db.state.entries.values()].filter(row => row.claimed_user_id !== null).length, 1);
});

test('a claim write failure rolls back the new account and a failed user insert never claims a row', async () => {
  const auth = await google('one'), candidate = auth.data.rosterCandidates[0];
  db.failClaim = true;
  assert.equal((await register(auth.data.setupToken, { roster_id: candidate.roster_id })).status, 500);
  assert.equal(db.state.users.size, 0); assert.equal(db.state.entries.get(candidate.roster_id).claimed_user_id, null);
  db.failClaim = false; db.failInsert = true;
  assert.equal((await register(auth.data.setupToken, { roster_id: candidate.roster_id })).status, 500);
  assert.equal(db.state.users.size, 0); assert.equal(db.state.entries.get(candidate.roster_id).claimed_user_id, null);
});

test('an existing Google account wins before name matching and its stored class is never overwritten', async () => {
  db.state.users.set(7, { user_id: 7, name: '기존 가상회원', grade: 3, class_number: 4, google_sub: profiles.one.sub, google_email: profiles.one.email, is_admin: 0 });
  const auth = await google('one'); assert.equal(auth.data.user.id, 7); assert.equal(auth.data.user.grade, 3); assert.equal(auth.data.user.class_number, 4);
  assert.equal(auth.data.rosterCandidates, undefined); assert.equal([...db.state.entries.values()].some(row => row.claimed_user_id !== null), false);
});
