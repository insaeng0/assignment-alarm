'use strict';
const { createHash } = require('node:crypto');
const SCHOOL = Object.freeze({ name: '부산소프트웨어마이스터고등학교', office: 'C10', code: '7150658' });
const SOURCE = 'https://open.neis.go.kr/portal/data/service/selectServicePage.do?infId=OPEN17220190722175038389180&infSeq=2';
const fail = code => Object.assign(new Error(code), { code });
function validMonth(month) { return typeof month === 'string' && /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(month); }
// Match whole day-off labels, so related school events such as '어린이날 행사' stay visible.
const DAY_OFF_TITLE = /^(?:(?:토요|일요|재량|학교장재량)?휴업일?|휴무일|공휴일|대체(?:공휴일|휴일)|신정|설(?:날|연휴)?|추석(?:연휴)?|삼일절|3[·.]1절|어린이날|부처님오신날|석가탄신일|현충일|광복절|개천절|한글날|성탄절|크리스마스|기독탄신일)(?:\([^)]*\))*$/u;
function normalizeRows(rows, month) {
  const unique = new Map();
  for (const row of rows) {
    if (row.ATPT_OFCDC_SC_CODE !== SCHOOL.office || String(row.SD_SCHUL_CODE) !== SCHOOL.code) throw fail('NEIS_INVALID_RESPONSE');
    const raw = String(row.AA_YMD || '');
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const parsed = new Date(date + 'T12:00:00Z');
    if (!/^\d{8}$/.test(raw) || date.slice(0, 7) !== month || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw fail('NEIS_INVALID_RESPONSE');
    const title = String(row.EVENT_NM || '').trim();
    if (!title || title.length > 300) throw fail('NEIS_INVALID_RESPONSE');
    if (DAY_OFF_TITLE.test(title.normalize('NFKC').replace(/\s/g, ''))) continue;
    const detail = String(row.EVENT_CNTNT || '').trim().slice(0, 4000);
    const grades = ['ONE_GRADE_EVENT_YN', 'TW_GRADE_EVENT_YN', 'THREE_GRADE_EVENT_YN'].flatMap((field, index) => row[field] === 'Y' ? [index + 1] : []);
    const id = createHash('sha256').update(JSON.stringify([date, title, detail, grades])).digest('hex').slice(0, 24);
    unique.set(id, { id, date, title, detail, grades, category: /고사|시험|평가/.test(title) ? 'exam' : 'event' });
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'ko'));
}
class SchoolSchedule {
  constructor({ apiKey = '', fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
    this.apiKey = apiKey.trim(); this.fetch = fetchImpl; this.now = now; this.cache = new Map(); this.pending = new Map(); this.cooldown = 0;
  }
  async getMonth(month) {
    if (!validMonth(month)) throw fail('NEIS_INVALID_MONTH');
    if (!this.apiKey || this.apiKey.length > 256 || /[\r\n]/.test(this.apiKey)) throw fail('NEIS_NOT_CONFIGURED');
    const cached = this.cache.get(month);
    if (cached && this.now() - cached.fetched < 3600000) return structuredClone(cached.value);
    if (this.pending.has(month)) return structuredClone(await this.pending.get(month));
    if (this.pending.size >= 4 || this.now() < this.cooldown) throw fail('NEIS_BUSY');
    const job = this.load(month).then(events => {
      const value = { school: SCHOOL.name, month, source: SOURCE, updatedAt: new Date(this.now()).toISOString(), events };
      this.cache.delete(month); this.cache.set(month, { fetched: this.now(), value });
      while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value);
      return value;
    }).catch(() => { this.cooldown = this.now() + 30000; throw fail('NEIS_UNAVAILABLE'); }).finally(() => this.pending.delete(month));
    this.pending.set(month, job);
    return structuredClone(await job);
  }
  async load(month) {
    const signal = AbortSignal.timeout(10000);
    const [year, mm] = month.split('-').map(Number);
    const prefix = month.replace('-', '');
    const last = String(new Date(Date.UTC(year, mm, 0)).getUTCDate()).padStart(2, '0');
    const rows = []; let expectedTotal = null;
    for (let page = 1; page <= 5; page++) {
      const url = new URL('https://open.neis.go.kr/hub/SchoolSchedule');
      for (const [key, value] of Object.entries({ KEY: this.apiKey, Type: 'json', pIndex: page, pSize: 100, ATPT_OFCDC_SC_CODE: SCHOOL.office, SD_SCHUL_CODE: SCHOOL.code, AA_FROM_YMD: prefix + '01', AA_TO_YMD: prefix + last })) url.searchParams.set(key, String(value));
      // This API selects JSON using Type=json; Accept: application/json causes an upstream HTTP 500.
      const response = await this.fetch(url, { signal, redirect: 'error', headers: { Accept: '*/*' } });
      if (!response.ok || !response.body) throw fail('NEIS_UNAVAILABLE');
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1024 * 1024) throw fail('NEIS_INVALID_RESPONSE');
          chunks.push(Buffer.from(part.value));
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (data.RESULT?.CODE === 'INFO-200') { if (rows.length) throw fail('NEIS_INVALID_RESPONSE'); return []; }
      if (data.RESULT || !Array.isArray(data.SchoolSchedule)) throw fail('NEIS_INVALID_RESPONSE');
      const head = data.SchoolSchedule.find(section => Array.isArray(section.head))?.head;
      const total = head?.find(entry => entry.list_total_count !== undefined)?.list_total_count;
      if (head?.find(entry => entry.RESULT)?.RESULT?.CODE !== 'INFO-000' || !Number.isInteger(total) || total < 0 || total > 500 || (expectedTotal !== null && total !== expectedTotal)) throw fail('NEIS_INVALID_RESPONSE');
      expectedTotal = total;
      const part = data.SchoolSchedule.find(section => Array.isArray(section.row))?.row;
      if (!part?.length || part.length > 100 || rows.length + part.length > total) throw fail('NEIS_INVALID_RESPONSE');
      rows.push(...part);
      if (rows.length === total) return normalizeRows(rows, month);
      if (part.length < 100) throw fail('NEIS_INVALID_RESPONSE'); // Never mistake the five-row sample for a complete month.
    }
    throw fail('NEIS_INVALID_RESPONSE');
  }
}
module.exports = { SchoolSchedule, validMonth, normalizeRows, SCHOOL };
