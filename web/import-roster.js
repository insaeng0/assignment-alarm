#!/usr/bin/env node
'use strict';

// This operator-only command receives private data on stdin. It never serves it.
const { importRoster, validateRosterImport, rosterError } = require('./lib/student-roster');
const { databaseTimeOptions, installUtcDatabaseSessions } = require('./lib/database-time');

async function readPrivateJson(input) {
  const chunks = []; let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw rosterError('ROSTER_IMPORT_SIZE');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw rosterError('ROSTER_IMPORT_JSON'); }
}
function databaseOptions(env) {
  const user = env.MYSQLUSER || env.DB_USER;
  const password = env.MYSQLPASSWORD || env.DB_PASSWORD;
  if (!user || !password) throw rosterError('ROSTER_IMPORT_DATABASE_CONFIG');
  return {
    host: env.MYSQLHOST || env.DB_HOST || 'mysql', port: Number(env.MYSQLPORT || env.DB_PORT) || 3306,
    user, password, database: env.MYSQLDATABASE || env.DB_NAME || 'assignment_alarm',
    connectionLimit: 1, charset: 'utf8mb4', ...databaseTimeOptions,
    ...(env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true, ...(env.DB_SSL_CA ? { ca: env.DB_SSL_CA.replace(/\\n/g, '\n') } : {}) } } : {})
  };
}
async function runImport({ input = process.stdin, env = process.env, createPool } = {}) {
  const data = await readPrivateJson(input);
  validateRosterImport(data);
  const pool = (createPool || require('mysql2/promise').createPool)(databaseOptions(env));
  installUtcDatabaseSessions(pool);
  try { return await importRoster(pool, data); }
  finally { await pool.end(); }
}
if (require.main === module) {
  runImport().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    const safe = { error: /^ROSTER_IMPORT_[A-Z_]+$/.test(error?.code || '') ? error.code : 'ROSTER_IMPORT_FAILED' };
    if (Number.isInteger(error?.rowIndex)) safe.row_index = error.rowIndex;
    process.stderr.write(JSON.stringify(safe) + '\n');
    process.exitCode = 1;
  });
}
module.exports = { runImport, readPrivateJson, databaseOptions };
