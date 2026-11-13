const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const mysql = require('mysql2');
const { databaseTimeOptions, installUtcDatabaseSessions, SET_UTC_SESSION } = require('../lib/database-time');

async function protocolFixture(t, { failInitialization = false } = {}) {
  const statements = [];
  const connections = new Set();
  const server = mysql.createServer(connection => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.stream.once('close', () => connections.delete(connection));
    connection.serverHandshake({
      protocolVersion: 10, serverVersion: '8.0.0-test', connectionId: 1,
      statusFlags: 2, characterSet: 45, capabilityFlags: 0xffffff,
      authCallback: (details, callback) => { callback(null); connection._resetSequenceId(); }
    });
    const query = sql => {
      connection.sequenceId = 1;
      statements.push(sql);
      if (sql === SET_UTC_SESSION) {
        if (failInitialization) connection.writeError({ code: 1298, message: 'Test session setup failure' });
        else connection.writeOk();
        return;
      }
      connection.writeColumns([
        { catalog: 'def', schema: 'test', table: 'assignments', orgTable: 'assignments', name: 'created_at', orgName: 'created_at', characterSet: 63, columnLength: 19, columnType: mysql.Types.TIMESTAMP, flags: 0, decimals: 0 },
        { catalog: 'def', schema: 'test', table: 'assignments', orgTable: 'assignments', name: 'due_date', orgName: 'due_date', characterSet: 63, columnLength: 10, columnType: mysql.Types.DATE, flags: 0, decimals: 0 }
      ]);
      connection.writeTextRow(['2026-11-13 03:30:00', '2026-11-20']);
      connection.writeEof();
    };
    // mysql2's test-server dispatcher routes SET through stmt_prepare.
    connection.on('query', query);
    connection.on('stmt_prepare', query);
    connection.on('packet', () => connection._resetSequenceId());
  });
  server.listen(0, '127.0.0.1');
  await once(server._server, 'listening');
  const pool = mysql.createPool({ host: '127.0.0.1', port: server._server.address().port,
    user: 'test', database: 'test', connectionLimit: 1, ...databaseTimeOptions }).promise();
  t.after(async () => {
    for (const connection of connections) connection.stream.destroy();
    await pool.end().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  });
  return { pool, statements };
}

test('only DATE remains a string while instants are parsed using UTC', { timeout: 5000 }, async t => {
  const { pool, statements } = await protocolFixture(t);
  installUtcDatabaseSessions(pool);
  const [rows] = await pool.query('SELECT created_at, due_date FROM assignments');
  assert.deepEqual(statements, [SET_UTC_SESSION, 'SELECT created_at, due_date FROM assignments']);
  assert.ok(rows[0].created_at instanceof Date);
  assert.equal(JSON.parse(JSON.stringify(rows[0])).created_at, '2026-11-13T03:30:00.000Z');
  assert.equal(rows[0].due_date, '2026-11-20');
  const koreanParts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(rows[0].created_at);
  assert.equal(koreanParts.find(part => part.type === 'hour').value, '12');
  assert.equal(koreanParts.find(part => part.type === 'minute').value, '30');
  assert.match(koreanParts.find(part => part.type === 'dayPeriod').value, /^(오후|PM)$/);
  await pool.query('SELECT second_read');
  assert.equal(statements.filter(sql => sql === SET_UTC_SESSION).length, 1);
  const connection = await pool.getConnection();
  connection.destroy();
  await pool.query('SELECT replacement_connection');
  assert.equal(statements.filter(sql => sql === SET_UTC_SESSION).length, 2);
});

test('failed UTC initialization destroys the connection before application SQL is sent', { timeout: 5000 }, async t => {
  const { pool, statements } = await protocolFixture(t, { failInitialization: true });
  const errors = [];
  installUtcDatabaseSessions(pool, { onError: error => errors.push(error.code) });
  await assert.rejects(pool.query('SELECT must_not_run'));
  assert.deepEqual(statements, [SET_UTC_SESSION]);
  assert.deepEqual(errors, ['DATABASE_TIMEZONE_INIT_FAILED']);
});

test('synchronous initialization exceptions discard the raw connection', () => {
  let initialize, destroyed = 0;
  installUtcDatabaseSessions({ on(event, listener) { assert.equal(event, 'connection'); initialize = listener; } });
  initialize({ query() { throw new Error('private connection details'); }, destroy() { destroyed++; } });
  assert.equal(destroyed, 1);
});
