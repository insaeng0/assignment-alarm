'use strict';

const crypto = require('node:crypto');

const INACTIVITY_MS = 90 * 24 * 60 * 60 * 1000;
const RETRY_GRACE_MS = 30 * 1000;
const MAX_PER_USER = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 60;

// These tables hold authentication state only. Existing users, assignments,
// notices, completion records and uploaded files are never rewritten here.
const refreshSchema = [
  `CREATE TABLE IF NOT EXISTS auth_refresh_lock (
    lock_id TINYINT NOT NULL PRIMARY KEY
  )`,
  'INSERT IGNORE INTO auth_refresh_lock (lock_id) VALUES (1)',
  `CREATE TABLE IF NOT EXISTS auth_refresh_issuance (
    user_id INT NOT NULL PRIMARY KEY, window_ms BIGINT UNSIGNED NOT NULL, issue_count INT UNSIGNED NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS auth_refresh_families (
    family_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    user_id INT NOT NULL,
    auth_realm_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    current_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    revoked TINYINT(1) NOT NULL DEFAULT 0,
    rate_window_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
    rate_count INT UNSIGNED NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    KEY refresh_realm_active_idx (auth_realm_id, revoked, expires_at_ms),
    KEY refresh_user_created_idx (user_id, created_at_ms)
  )`,
  `CREATE TABLE IF NOT EXISTS auth_refresh_history (
    family_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    rotated_at_ms BIGINT UNSIGNED NOT NULL,
    next_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    next_expires_at_ms BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (family_id, token_hash),
    FOREIGN KEY (family_id) REFERENCES auth_refresh_families(family_id) ON DELETE CASCADE
  )`
];

function failure(code = 'REFRESH_INVALID', status = 401) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function parseRefreshToken(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) throw failure();
  return { familyId: value.slice(0, 64), token: value };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sameHash(left, right) {
  return typeof left === 'string' && typeof right === 'string' && /^[a-f0-9]{64}$/.test(left)
    && /^[a-f0-9]{64}$/.test(right)
    && crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

class RefreshSessions {
  constructor({ pool, secret, authRealm, maxFamilies = 5000, now = Date.now, onRevoke = () => {} }) {
    this.pool = pool;
    this.authRealm = authRealm;
    this.maxFamilies = maxFamilies;
    this.now = now;
    this.onRevoke = onRevoke;
    this.rotationKey = crypto.createHmac('sha256', secret).update('assignment-alarm:refresh-rotation:v1\0' + (authRealm || '')).digest();
  }

  configured() {
    return typeof this.authRealm === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(this.authRealm);
  }

  assertConfigured() {
    if (!this.configured()) throw failure('AUTH_REALM_REQUIRED', 503);
  }

  async transaction(operation) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await operation(conn);
      await conn.commit();
      for (const familyId of result.revokedFamilies || []) this.onRevoke(familyId);
      if (result.failure) throw Object.assign(result.failure, { transactionCommitted: true });
      return result;
    } catch (error) {
      if (!error.transactionCommitted) { try { await conn.rollback(); } catch {} }
      throw error;
    } finally { conn.release(); }
  }

  async create(userId) {
    this.assertConfigured();
    const now = this.now();
    return this.transaction(async conn => {
      // One small singleton lock serializes family creation, so concurrent
      // logins cannot exceed the global or per-user bound.
      await conn.execute('SELECT lock_id FROM auth_refresh_lock WHERE lock_id = 1 FOR UPDATE');
      await conn.execute('DELETE FROM auth_refresh_families WHERE revoked = 1 OR expires_at_ms <= ?', [now]);
      const [issued] = await conn.execute('SELECT window_ms, issue_count FROM auth_refresh_issuance WHERE user_id = ? FOR UPDATE', [userId]);
      const reset = !issued[0] || now - Number(issued[0].window_ms) >= RATE_WINDOW_MS;
      const count = reset ? 0 : Number(issued[0].issue_count);
      if (count >= 20) throw failure('REFRESH_ISSUANCE_LIMITED', 429);
      await conn.execute('INSERT INTO auth_refresh_issuance (user_id, window_ms, issue_count) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE window_ms = VALUES(window_ms), issue_count = VALUES(issue_count)', [userId, reset ? now : Number(issued[0].window_ms), count + 1]);
      const [active] = await conn.execute(
        'SELECT family_id, user_id FROM auth_refresh_families WHERE auth_realm_id = ? AND revoked = 0 AND expires_at_ms > ? ORDER BY created_at_ms, family_id FOR UPDATE',
        [this.authRealm, now]
      );
      const own = active.filter(row => Number(row.user_id) === userId);
      const revokedFamilies = [];
      while (own.length >= MAX_PER_USER) {
        const familyId = own.shift().family_id;
        await conn.execute('UPDATE auth_refresh_families SET revoked = 1 WHERE family_id = ?', [familyId]);
        revokedFamilies.push(familyId);
      }
      if (active.length - revokedFamilies.length >= this.maxFamilies) throw failure('PAGES_SESSION_CAPACITY', 503);
      const familyId = crypto.randomBytes(32).toString('hex');
      const refreshToken = familyId + '.' + crypto.randomBytes(32).toString('hex');
      const expiresAt = now + INACTIVITY_MS;
      await conn.execute(
        'INSERT INTO auth_refresh_families (family_id, user_id, auth_realm_id, current_token_hash, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
        [familyId, userId, this.authRealm, tokenHash(refreshToken), now, expiresAt]
      );
      return { familyId, userId, refreshToken, refreshExpiresAt: new Date(expiresAt).toISOString(), revokedFamilies };
    });
  }

  nextToken(oldToken, requestId) {
    const familyId = parseRefreshToken(oldToken).familyId;
    const secret = crypto.createHmac('sha256', this.rotationKey)
      .update('assignment-alarm:next-refresh:v1\0' + oldToken + '\0' + requestId).digest('hex');
    return familyId + '.' + secret;
  }

  async rotate(refreshToken, requestId) {
    this.assertConfigured();
    const { familyId } = parseRefreshToken(refreshToken);
    if (typeof requestId !== 'string' || !/^[a-f0-9]{32,128}$/i.test(requestId) || requestId.length % 2) throw failure('REFRESH_REQUEST_INVALID', 400);
    requestId = requestId.toLowerCase();
    const presentedHash = tokenHash(refreshToken);
    const now = this.now();
    return this.transaction(async conn => {
      const [rows] = await conn.execute(
        'SELECT family_id, user_id, current_token_hash, expires_at_ms, revoked, rate_window_ms, rate_count FROM auth_refresh_families WHERE family_id = ? AND auth_realm_id = ? FOR UPDATE',
        [familyId, this.authRealm]
      );
      const family = rows[0];
      if (!family || Number(family.revoked) || Number(family.expires_at_ms) <= now) throw failure();
      if (!sameHash(presentedHash, family.current_token_hash)) {
        const [history] = await conn.execute(
          'SELECT request_id, rotated_at_ms, next_token_hash, next_expires_at_ms FROM auth_refresh_history WHERE family_id = ? AND token_hash = ? FOR UPDATE',
          [familyId, presentedHash]
        );
        const consumed = history[0];
        // Guessing a family ID plus a random secret must never log out its owner.
        if (!consumed) throw failure();
        if (now - Number(consumed.rotated_at_ms) <= RETRY_GRACE_MS) {
          if (consumed.request_id !== requestId || !sameHash(consumed.next_token_hash, family.current_token_hash)) {
            throw failure('REFRESH_RACE', 409);
          }
          const retryToken = this.nextToken(refreshToken, requestId);
          if (!sameHash(tokenHash(retryToken), family.current_token_hash)) throw failure();
          return { familyId, userId: Number(family.user_id), refreshToken: retryToken,
            refreshExpiresAt: new Date(Number(consumed.next_expires_at_ms)).toISOString(), idempotent: true };
        }
        await conn.execute('UPDATE auth_refresh_families SET revoked = 1 WHERE family_id = ?', [familyId]);
        return { failure: failure(), revokedFamilies: [familyId] };
      }
      const resetWindow = now - Number(family.rate_window_ms) >= RATE_WINDOW_MS;
      const windowStart = resetWindow ? now : Number(family.rate_window_ms);
      const count = resetWindow ? 0 : Number(family.rate_count);
      if (count >= RATE_LIMIT) throw failure('REFRESH_RATE_LIMITED', 429);
      const next = this.nextToken(refreshToken, requestId);
      const nextHash = tokenHash(next);
      const expiresAt = now + INACTIVITY_MS;
      await conn.execute(
        'INSERT INTO auth_refresh_history (family_id, token_hash, request_id, rotated_at_ms, next_token_hash, next_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
        [familyId, presentedHash, requestId, now, nextHash, expiresAt]
      );
      await conn.execute(
        'UPDATE auth_refresh_families SET current_token_hash = ?, expires_at_ms = ?, rate_window_ms = ?, rate_count = ? WHERE family_id = ?',
        [nextHash, expiresAt, windowStart, count + 1, familyId]
      );
      // Bounded replay evidence: older consumed credentials remain invalid, but
      // only the latest 256 can trigger family-wide replay revocation.
      const [retained] = await conn.execute('SELECT token_hash FROM auth_refresh_history WHERE family_id = ? ORDER BY rotated_at_ms DESC, token_hash DESC LIMIT 256', [familyId]);
      if (retained.length) await conn.execute('DELETE FROM auth_refresh_history WHERE family_id = ? AND token_hash NOT IN (' + retained.map(() => '?').join(',') + ')', [familyId, ...retained.map(row => row.token_hash)]);
      return { familyId, userId: Number(family.user_id), refreshToken: next, refreshExpiresAt: new Date(expiresAt).toISOString(), idempotent: false };
    });
  }

  async revoke(refreshToken) {
    this.assertConfigured();
    const { familyId } = parseRefreshToken(refreshToken);
    const presentedHash = tokenHash(refreshToken);
    return this.transaction(async conn => {
      const [rows] = await conn.execute(
        'SELECT family_id, user_id, current_token_hash, expires_at_ms, revoked, rate_window_ms, rate_count FROM auth_refresh_families WHERE family_id = ? AND auth_realm_id = ? FOR UPDATE',
        [familyId, this.authRealm]
      );
      const family = rows[0];
      if (!family) return { revokedFamilies: [] };
      let valid = sameHash(presentedHash, family.current_token_hash);
      if (!valid) {
        const [history] = await conn.execute('SELECT token_hash FROM auth_refresh_history WHERE family_id = ? AND token_hash = ? FOR UPDATE', [familyId, presentedHash]);
        valid = history.length > 0;
      }
      if (!valid) return { revokedFamilies: [] };
      await conn.execute('UPDATE auth_refresh_families SET revoked = 1 WHERE family_id = ?', [familyId]);
      return { revokedFamilies: [familyId] };
    });
  }
}

module.exports = { RefreshSessions, refreshSchema, INACTIVITY_MS, RETRY_GRACE_MS, tokenHash };
