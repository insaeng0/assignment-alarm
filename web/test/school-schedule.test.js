const test = require('node:test');
const assert = require('node:assert/strict');
const { SchoolSchedule, normalizeRows, validMonth, SCHOOL } = require('../lib/school-schedule');
const row = (overrides = {}) => ({ ATPT_OFCDC_SC_CODE: SCHOOL.office, SD_SCHUL_CODE: SCHOOL.code, AA_YMD: '20261218', EVENT_NM: '기말고사', EVENT_CNTNT: '1학년', ONE_GRADE_EVENT_YN: 'Y', TW_GRADE_EVENT_YN: 'N', THREE_GRADE_EVENT_YN: 'Y', ...overrides });
const payload = (rows, total = rows.length) => ({ SchoolSchedule: [{ head: [{ list_total_count: total }, { RESULT: { CODE: 'INFO-000' } }] }, { row: rows }] });
const response = data => new Response(JSON.stringify(data));

test('day-off labels are hidden without removing exams or related school activities', () => {
  const hidden = ['토요휴업일', '성탄절', '크리스마스', '대체공휴일', '추석 연휴', '설날', '재량휴업일', '학교장 재량 휴업일', '어린이날', '부처님 오신 날', '성탄절(크리스마스)', '한글날'];
  const visible = ['기말고사', '중간고사', '체험학습', '방학식', '개학식', '어린이날 행사', '성탄절 안전교육'];
  assert.deepEqual(normalizeRows([...hidden, ...visible].map(EVENT_NM => row({ EVENT_NM })), '2026-12').map(event => event.title).sort(), visible.sort());
});

test('strict month and actual school dates reject malformed and foreign records', () => {
  for (const value of ['2026-00', '2026-13', '2026-1', ['2026-12'], '2026-12&KEY=x']) assert.equal(validMonth(value), false);
  assert.equal(validMonth('2026-12'), true);
  for (const overrides of [{ SD_SCHUL_CODE: 'other' }, { ATPT_OFCDC_SC_CODE: 'other' }, { AA_YMD: '20261232' }, { AA_YMD: '20261118' }, { EVENT_NM: '' }]) assert.throws(() => normalizeRows([row(overrides)], '2026-12'), { code: 'NEIS_INVALID_RESPONSE' });
  assert.throws(() => normalizeRows([row({ AA_YMD: '20260230' })], '2026-02'), { code: 'NEIS_INVALID_RESPONSE' });
});
test('normalization deduplicates without merging same-day events and preserves grade flags', () => {
  const rows = normalizeRows([row(), row(), row({ EVENT_NM: '체험학습' })], '2026-12');
  assert.equal(rows.length, 2); assert.deepEqual(rows[0].grades, [1, 3]);
  assert.equal(rows.find(event => event.title === '기말고사').category, 'exam');
  assert.ok(rows.every(event => /^[a-f0-9]{24}$/.test(event.id) && event.date === '2026-12-18' && !('assignment_id' in event)));
});
test('key is required before upstream access and absent from public results', async () => {
  let calls = 0;
  const unavailable = new SchoolSchedule({ fetchImpl: async () => { calls++; } });
  await assert.rejects(unavailable.getMonth('2026-12'), { code: 'NEIS_NOT_CONFIGURED' }); assert.equal(calls, 0);
  const service = new SchoolSchedule({ apiKey: 'private-test-key', fetchImpl: async (url, options) => {
    calls++; assert.equal(url.origin + url.pathname, 'https://open.neis.go.kr/hub/SchoolSchedule');
    assert.equal(url.searchParams.get('KEY'), 'private-test-key'); assert.equal(url.searchParams.get('SD_SCHUL_CODE'), SCHOOL.code);
    assert.equal(url.searchParams.get('AA_TO_YMD'), '20261231'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Accept, '*/*'); assert.ok(options.signal);
    return response(payload([row()]));
  } });
  const result = await service.getMonth('2026-12');
  assert.equal(result.events.length, 1); assert.ok(!JSON.stringify(result).includes('private-test-key')); assert.equal(calls, 1);
});
test('concurrent queries coalesce, cache for one hour and isolate returned objects', async () => {
  let calls = 0, now = Date.UTC(2026, 10, 19);
  const service = new SchoolSchedule({ apiKey: 'test', now: () => now, fetchImpl: async () => { calls++; return response(payload([row()])); } });
  const [a, b] = await Promise.all([service.getMonth('2026-12'), service.getMonth('2026-12')]);
  a.events[0].title = 'modified'; assert.equal(b.events[0].title, '기말고사');
  assert.equal((await service.getMonth('2026-12')).events[0].title, '기말고사'); assert.equal(calls, 1);
  now += 3600001; await service.getMonth('2026-12'); assert.equal(calls, 2);
});
test('paginates complete data and rejects the five-row keyless sample as incomplete', async () => {
  let calls = 0;
  const service = new SchoolSchedule({ apiKey: 'test', fetchImpl: async url => { calls++; return response(payload(Array.from({ length: url.searchParams.get('pIndex') === '1' ? 100 : 1 }, (_, i) => row({ EVENT_NM: `${calls}-${i}` })), 101)); } });
  assert.equal((await service.getMonth('2026-12')).events.length, 101); assert.equal(calls, 2);
  const sample = new SchoolSchedule({ apiKey: 'test', fetchImpl: async () => response(payload(Array.from({ length: 5 }, () => row()), 7)) });
  await assert.rejects(sample.getMonth('2026-12'), { code: 'NEIS_UNAVAILABLE' }); assert.equal(sample.cache.size, 0);
});
test('provider failures, oversized bodies and redirects fail closed without key leakage and cool down', async () => {
  for (const fake of [async () => { throw new Error('https://provider/?KEY=private-test-key'); }, async () => new Response('x'.repeat(1048577)), async () => response(payload([row()], 501)), async () => response({ RESULT: { CODE: 'ERROR-290', MESSAGE: 'private-test-key' } }), async () => new Response('', { status: 302 })]) {
    let calls = 0;
    const service = new SchoolSchedule({ apiKey: 'private-test-key', fetchImpl: async (...args) => { calls++; return fake(...args); } });
    await assert.rejects(service.getMonth('2026-12'), error => error.code === 'NEIS_UNAVAILABLE' && !String(error).includes('private-test-key'));
    await assert.rejects(service.getMonth('2026-11'), { code: 'NEIS_BUSY' }); assert.equal(calls, 1);
  }
});
test('official no-data response is an empty successful month; pending work and cache are bounded', async () => {
  const service = new SchoolSchedule({ apiKey: 'test', fetchImpl: async () => response({ RESULT: { CODE: 'INFO-200' } }) });
  for (let year = 2020; year < 2047; year++) assert.deepEqual((await service.getMonth(`${year}-01`)).events, []);
  assert.equal(service.cache.size, 24);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const pending = new SchoolSchedule({ apiKey: 'test', fetchImpl: async () => { await blocked; return response({ RESULT: { CODE: 'INFO-200' } }); } });
  const jobs = [1, 2, 3, 4].map(mm => pending.getMonth(`2026-0${mm}`));
  await assert.rejects(pending.getMonth('2026-05'), { code: 'NEIS_BUSY' }); release(); await Promise.all(jobs); assert.equal(pending.pending.size, 0);
});
