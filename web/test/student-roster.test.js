const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { rosterSchema, normalizeRosterName, academicYearAt, studentRosterScope, validateRosterImport, importRoster, lookupRoster, publicRosterCandidates } = require('../lib/student-roster');
const { runImport } = require('../import-roster');
const { rosterDatabase } = require('./helpers/roster-db');
const input = () => ({ academic_year: 2026, grade: 1, entries: [{ name: '가상 동명', class_number: 1 }, { name: '가상 동명', class_number: 2 }, { name: '가상 별명', class_number: 3 }] });

test('roster matching normalizes only NFKC and whitespace and scopes cohorts at the Korean school-year boundary', () => {
  assert.equal(normalizeRosterName('  가상\u3000동명\n'), '가상동명');
  assert.equal(normalizeRosterName('Ａ Ｂ'), 'AB'); assert.notEqual(normalizeRosterName('가상 동명'), normalizeRosterName('가상 동멍'));
  assert.equal(academicYearAt('2027-02-28T14:59:59Z'), 2026); assert.equal(academicYearAt('2027-02-28T15:00:00Z'), 2027);
  assert.deepEqual(studentRosterScope({ google_email: '26_999@bssm.hs.kr' }, { now: '2026-11-14T00:00:00Z' }), { academic_year: 2026, grade: 1 });
  assert.deepEqual(studentRosterScope({ google_email: '25_999@bssm.hs.kr' }, { now: '2026-11-14T00:00:00Z' }), { academic_year: 2026, grade: 2 });
  assert.equal(studentRosterScope({ google_email: 'teacher1@bssm.hs.kr' }), null);
  assert.equal(studentRosterScope({ google_email: '26_999@bssm.hs.kr' }, { isAdmin: true }), null);
});

test('imports validate the complete private payload before DB access and revision is independent of row order', async () => {
  const valid = input(); assert.equal(validateRosterImport(valid).revision, validateRosterImport({ ...valid, entries: [...valid.entries].reverse() }).revision);
  for (const invalid of [{ ...valid, entries: [] }, { ...valid, grade: 0 }, { ...valid, entries: [{ name: '가상', class_number: 5 }] },
    { ...valid, entries: [{ name: '가상 동명', class_number: 1 }, { name: '가상동명', class_number: 1 }] }, { ...valid, entries: [{ name: '가상', class_number: 1, email: 'invented' }] }]) {
    let acquired = false;
    await assert.rejects(importRoster({ getConnection() { acquired = true; } }, invalid), error => /^ROSTER_IMPORT_/.test(error.code));
    assert.equal(acquired, false);
  }
  assert.ok(rosterSchema.some(sql => sql.includes('UNIQUE KEY roster_year_user_unique (academic_year, claimed_user_id)')));
});

test('private imports are idempotent, preserve opaque IDs and claims, and deactivate rather than delete omitted rows', async () => {
  const db = rosterDatabase(), original = input();
  const first = await importRoster(db, original); assert.equal(first.inserted, 3);
  const ids = [...db.state.entries.keys()];
  const claimed = db.state.entries.get(ids[0]); claimed.claimed_user_id = 99;
  const second = await importRoster(db, { ...original, entries: [...original.entries].reverse() });
  assert.equal(second.inserted, 0); assert.equal(second.updated, 0); assert.deepEqual([...db.state.entries.keys()], ids);
  const changed = await importRoster(db, { ...original, entries: [original.entries[1], { name: '가상 새학생', class_number: 4 }] });
  assert.equal(changed.inserted, 1); assert.equal(changed.deactivated, 2);
  assert.equal(db.state.entries.get(ids[0]).claimed_user_id, 99); assert.equal(db.state.entries.get(ids[0]).is_active, 0);
  assert.ok(!db.queries.some(({ sql }) => /DELETE FROM|SET claimed_user_id/.test(sql)));
});

test('failed imports roll back every partial row and a concurrent identical import remains idempotent', async () => {
  const db = rosterDatabase(); db.failImport = true;
  await assert.rejects(importRoster(db, input())); assert.equal(db.state.entries.size, 0); assert.equal(db.state.imports.size, 0);
  db.failImport = false;
  const results = await Promise.all([importRoster(db, input()), importRoster(db, input())]);
  assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 3); assert.equal(db.state.entries.size, 3);
});

test('lookup exposes only the current same-name candidates and never claim ownership or another grade', async () => {
  const db = rosterDatabase(); await importRoster(db, input());
  const rows = await lookupRoster(db, { name: '가상 동명' }, { academic_year: 2026, grade: 1 }); assert.equal(rows.length, 2);
  rows[0].claimed_user_id = 77;
  const visible = publicRosterCandidates(rows); assert.equal(visible.length, 1); assert.deepEqual(Object.keys(visible[0]), ['roster_id', 'grade', 'class_number', 'name']);
  assert.equal((await lookupRoster(db, { name: '가상 동멍' }, { academic_year: 2026, grade: 1 })).length, 0);
  assert.equal((await lookupRoster(db, { name: '가상 동명' }, { academic_year: 2026, grade: 2 })).length, 0);
});

test('stdin CLI validates before opening DB and emits no private row or raw database error text', async () => {
  let connected = false;
  await assert.rejects(runImport({ input: Readable.from(['{"bad":true}']), createPool: () => { connected = true; } })); assert.equal(connected, false);
  const db = rosterDatabase();
  const result = await runImport({ input: Readable.from([JSON.stringify(input())]), env: { DB_USER: 'test', DB_PASSWORD: 'test' }, createPool: () => db });
  assert.equal(result.entries, 3); assert.equal(JSON.stringify(result).includes('가상'), false);
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../import-roster.js')], { input: '{"secret_names":"never-print-this"}', encoding: 'utf8' });
  assert.equal(cli.status, 1); assert.equal(cli.stdout, ''); assert.equal(cli.stderr.includes('never-print-this'), false); assert.match(cli.stderr, /ROSTER_IMPORT_SHAPE/);
});
