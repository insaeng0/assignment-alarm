'use strict';

// DATE is a calendar day. TIMESTAMP/DATETIME are instants serialized by JSON as UTC ISO.
const databaseTimeOptions = Object.freeze({
  timezone: 'Z',
  dateStrings: Object.freeze(['DATE'])
});
const SET_UTC_SESSION = "SET time_zone = '+00:00'";

function installUtcDatabaseSessions(pool, { onError = () => {} } = {}) {
  if (!pool || typeof pool.on !== 'function') throw new TypeError('A mysql2 pool is required.');
  const initialize = connection => {
    let failed = false;
    const discard = () => {
      if (failed) return;
      failed = true;
      // A failed session must never be returned to this pool with an unknown time zone.
      try { connection.destroy(); } finally {
        const error = new Error('Database UTC session initialization failed.');
        error.code = 'DATABASE_TIMEZONE_INIT_FAILED';
        onError(error);
      }
    };
    try {
      // mysql2 emits `connection` before giving it to a caller. Synchronously queue this
      // query here; an async listener would allow the caller's first query to run first.
      connection.query(SET_UTC_SESSION, error => { if (error) discard(); });
    } catch { discard(); }
  };
  pool.on('connection', initialize);
  return initialize;
}

module.exports = { databaseTimeOptions, installUtcDatabaseSessions, SET_UTC_SESSION };
