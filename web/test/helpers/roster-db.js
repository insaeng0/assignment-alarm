'use strict';

// Synthetic in-memory fixture: transactions use isolated snapshots and a mutex.
// Assertions in the HTTP tests exercise the real server, not these SQL branches.
function rosterDatabase() {
  let state = { imports: new Map(), entries: new Map(), users: new Map(), nextId: 1000 };
  let tail = Promise.resolve();
  const queries = [], events = [];
  const duplicate = () => { throw Object.assign(new Error('synthetic duplicate'), { code: 'ER_DUP_ENTRY' }); };
  const db = {
    queries, events, failClaim: false, failInsert: false, failImport: false,
    get state() { return state; }, on() { return this; }, async end() {},
    async execute(sql, params = []) { return execute(state, sql, params); },
    async getConnection() {
      let draft, unlock;
      return {
        async beginTransaction() {
          let release; const wait = tail; tail = new Promise(done => { release = done; }); await wait;
          unlock = release; draft = structuredClone(state); events.push('begin');
        },
        async execute(sql, params = []) { return execute(draft || state, sql, params); },
        async commit() { state = draft; draft = null; events.push('commit'); unlock?.(); unlock = null; },
        async rollback() { draft = null; events.push('rollback'); unlock?.(); unlock = null; },
        release() { unlock?.(); unlock = null; events.push('release'); }
      };
    }
  };
  async function execute(data, sql, params) {
    queries.push({ sql, params });
    if (sql.includes('FROM users WHERE google_sub')) return [[...data.users.values()].filter(user => user.google_sub === params[0])];
    if (sql.includes('FROM users WHERE user_id')) return [data.users.has(Number(params[0])) ? [data.users.get(Number(params[0]))] : []];
    if (sql.startsWith('UPDATE users SET is_admin')) { data.users.get(params[1]).is_admin = params[0]; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE users SET google_email')) { data.users.get(params[2]).google_email = params[0]; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('INSERT INTO users')) {
      if (db.failInsert) throw new Error('synthetic insert failure');
      if ([...data.users.values()].some(user => user.google_sub === params[2])) duplicate();
      const id = data.nextId++;
      data.users.set(id, { user_id: id, name: params[1], google_sub: params[2], google_email: params[3], grade: params[4], class_number: params[5], is_admin: params[7], is_alarm_enabled: 1 });
      return [{ insertId: id }];
    }
    if (sql.startsWith('INSERT IGNORE INTO student_roster_imports')) {
      const key = params[0] + ':' + params[1];
      if (!data.imports.has(key)) data.imports.set(key, { revision: params[2], academic_year: params[0], grade: params[1] });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT revision FROM student_roster_imports')) return [data.imports.has(params[0] + ':' + params[1]) ? [data.imports.get(params[0] + ':' + params[1])] : []];
    if (sql.startsWith('SELECT ') && sql.includes('FROM student_roster_entries')) {
      return [[...data.entries.values()].filter(row => row.academic_year === params[0] && row.grade === params[1]
        && (!sql.includes('normalized_name = ?') || (row.normalized_name === params[2] && row.is_active === 1)))];
    }
    if (sql.startsWith('INSERT INTO student_roster_entries')) {
      if (db.failImport) throw new Error('synthetic import failure');
      if ([...data.entries.values()].some(row => row.academic_year === params[1] && row.grade === params[2] && row.class_number === params[3] && row.normalized_name === params[5])) duplicate();
      data.entries.set(params[0], { roster_id: params[0], academic_year: params[1], grade: params[2], class_number: params[3], name: params[4], normalized_name: params[5], is_active: 1, claimed_user_id: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE student_roster_entries SET name')) {
      const row = data.entries.get(params[1]); row.name = params[0]; row.is_active = 1; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE student_roster_entries SET is_active')) { data.entries.get(params[0]).is_active = 0; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE student_roster_entries SET claimed_user_id')) {
      if (db.failClaim) throw new Error('synthetic claim failure');
      const row = data.entries.get(params[1]);
      if (!row || row.claimed_user_id !== null || row.is_active !== 1) return [{ affectedRows: 0 }];
      if ([...data.entries.values()].some(other => other.academic_year === row.academic_year && other.claimed_user_id === params[0])) duplicate();
      row.claimed_user_id = params[0]; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE student_roster_imports SET revision')) {
      Object.assign(data.imports.get(params[2] + ':' + params[3]), { revision: params[0], entry_count: params[1] }); return [{ affectedRows: 1 }];
    }
    return [[]];
  }
  return db;
}
module.exports = { rosterDatabase };
