'use strict';

const crypto = require('node:crypto');
const rosterSchema = [
  `CREATE TABLE IF NOT EXISTS student_roster_imports (
    academic_year SMALLINT UNSIGNED NOT NULL,
    grade TINYINT UNSIGNED NOT NULL,
    revision CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    entry_count INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (academic_year, grade)
  )`,
  `CREATE TABLE IF NOT EXISTS student_roster_entries (
    roster_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    academic_year SMALLINT UNSIGNED NOT NULL,
    grade TINYINT UNSIGNED NOT NULL,
    class_number TINYINT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL,
    normalized_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    claimed_user_id INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY roster_scope_name_unique (academic_year, grade, class_number, normalized_name),
    UNIQUE KEY roster_year_user_unique (academic_year, claimed_user_id),
    KEY roster_lookup_idx (academic_year, grade, normalized_name, is_active),
    FOREIGN KEY (claimed_user_id) REFERENCES users(user_id) ON DELETE SET NULL
  )`
];

function rosterError(code, status = 400, rowIndex) {
  return Object.assign(new Error(code), { code, status, ...(rowIndex === undefined ? {} : { rowIndex }) });
}
function normalizeRosterName(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, '') : '';
}
function academicYearAt(now = new Date()) {
  const korea = new Date(new Date(now).getTime() + 9 * 60 * 60 * 1000);
  return korea.getUTCFullYear() - (korea.getUTCMonth() < 2 ? 1 : 0);
}
function studentRosterScope(profile, { isAdmin = false, now = new Date() } = {}) {
  if (isAdmin) return null;
  const match = /^(\d{2})_[0-9]+@bssm\.hs\.kr$/.exec(String(profile?.google_email || '').trim().toLowerCase());
  if (!match) return null;
  const academic_year = academicYearAt(now);
  const grade = academic_year - (2000 + Number(match[1])) + 1;
  return grade >= 1 && grade <= 3 ? { academic_year, grade } : null;
}
function matchName(profile) {
  return normalizeRosterName(profile?.roster_name ?? profile?.name);
}
async function lookupRoster(connection, profile, scope, { lock = false } = {}) {
  if (!scope || !matchName(profile) || matchName(profile).length > 100) return [];
  // An import and a registration serialize on this scope row. A row lock on
  // each candidate then prevents two accounts from claiming the same place.
  const [imports] = await connection.execute(
    `SELECT revision FROM student_roster_imports WHERE academic_year = ? AND grade = ?${lock ? ' FOR UPDATE' : ''}`,
    [scope.academic_year, scope.grade]
  );
  if (!imports.length) return [];
  const [rows] = await connection.execute(
    `SELECT roster_id, grade, class_number, name, normalized_name, claimed_user_id FROM student_roster_entries
     WHERE academic_year = ? AND grade = ? AND normalized_name = ? AND is_active = 1
     ORDER BY class_number, roster_id${lock ? ' FOR UPDATE' : ''}`,
    [scope.academic_year, scope.grade, matchName(profile)]
  );
  // JS exact equality also rejects an unexpected accent/collation match.
  return rows.filter(row => row.normalized_name === matchName(profile));
}
function publicRosterCandidates(rows) {
  return rows.filter(row => row.claimed_user_id === null || row.claimed_user_id === undefined)
    .map(({ roster_id, grade, class_number, name }) => ({ roster_id, grade, class_number, name }));
}
function validateRosterImport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['academic_year', 'grade', 'entries'].includes(key))) throw rosterError('ROSTER_IMPORT_SHAPE');
  if (!Number.isInteger(input.academic_year) || input.academic_year < 2000 || input.academic_year > 2199
      || !Number.isInteger(input.grade) || input.grade < 1 || input.grade > 3) throw rosterError('ROSTER_IMPORT_SCOPE');
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 1000) throw rosterError('ROSTER_IMPORT_SIZE');
  const seen = new Set();
  const entries = input.entries.map((entry, rowIndex) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['name', 'class_number'].includes(key))) throw rosterError('ROSTER_IMPORT_ROW', 400, rowIndex);
    const name = typeof entry.name === 'string' ? entry.name.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
    const normalized_name = normalizeRosterName(name);
    if (!normalized_name || name.length > 100 || /[\p{C}]/u.test(name) || !Number.isInteger(entry.class_number)
        || entry.class_number < 1 || entry.class_number > 4) throw rosterError('ROSTER_IMPORT_ROW', 400, rowIndex);
    const key = entry.class_number + ':' + normalized_name;
    if (seen.has(key)) throw rosterError('ROSTER_IMPORT_DUPLICATE', 400, rowIndex);
    seen.add(key);
    return { name, normalized_name, class_number: entry.class_number };
  }).sort((a, b) => a.class_number - b.class_number || (a.normalized_name < b.normalized_name ? -1 : a.normalized_name > b.normalized_name ? 1 : 0));
  const payload = { academic_year: input.academic_year, grade: input.grade, entries };
  return { ...payload, revision: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}

async function importRoster(pool, input) {
  const roster = validateRosterImport(input); // Validate everything before acquiring a connection.
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'INSERT IGNORE INTO student_roster_imports (academic_year, grade, revision, entry_count) VALUES (?, ?, ?, 0)',
      [roster.academic_year, roster.grade, '0'.repeat(64)]
    );
    const [imports] = await connection.execute('SELECT revision FROM student_roster_imports WHERE academic_year = ? AND grade = ? FOR UPDATE', [roster.academic_year, roster.grade]);
    if (imports[0]?.revision === roster.revision) {
      await connection.commit();
      return { revision: roster.revision, entries: roster.entries.length, inserted: 0, updated: 0, deactivated: 0 };
    }
    const [oldRows] = await connection.execute('SELECT roster_id, class_number, name, normalized_name, is_active FROM student_roster_entries WHERE academic_year = ? AND grade = ? FOR UPDATE', [roster.academic_year, roster.grade]);
    const old = new Map(oldRows.map(row => [row.class_number + ':' + row.normalized_name, row]));
    let inserted = 0, updated = 0, deactivated = 0;
    for (const entry of roster.entries) {
      const existing = old.get(entry.class_number + ':' + entry.normalized_name);
      if (existing) {
        old.delete(entry.class_number + ':' + entry.normalized_name);
        if (existing.name !== entry.name || Number(existing.is_active) !== 1) {
          await connection.execute('UPDATE student_roster_entries SET name = ?, is_active = 1 WHERE roster_id = ?', [entry.name, existing.roster_id]);
          updated++;
        }
      } else {
        await connection.execute('INSERT INTO student_roster_entries (roster_id, academic_year, grade, class_number, name, normalized_name) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), roster.academic_year, roster.grade, entry.class_number, entry.name, entry.normalized_name]);
        inserted++;
      }
    }
    for (const row of old.values()) {
      if (Number(row.is_active) !== 1) continue;
      await connection.execute('UPDATE student_roster_entries SET is_active = 0 WHERE roster_id = ?', [row.roster_id]);
      deactivated++;
    }
    await connection.execute('UPDATE student_roster_imports SET revision = ?, entry_count = ? WHERE academic_year = ? AND grade = ?', [roster.revision, roster.entries.length, roster.academic_year, roster.grade]);
    await connection.commit();
    return { revision: roster.revision, entries: roster.entries.length, inserted, updated, deactivated };
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally { connection.release(); }
}

module.exports = { rosterSchema, rosterError, normalizeRosterName, academicYearAt, studentRosterScope,
  lookupRoster, publicRosterCandidates, validateRosterImport, importRoster };
