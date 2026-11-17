'use strict';

// Fixed windows are process-local. A full store refuses new identities instead
// of evicting live limits, which would let key churn reset an attacker's budget.
function inspectRateLimit(store, key, { windowMs, limit, maxTrackedClients }, now) {
  if (!(store instanceof Map) || typeof key !== 'string' || key.length > 256
      || !Number.isSafeInteger(windowMs) || windowMs < 1
      || !Number.isSafeInteger(limit) || limit < 1
      || !Number.isSafeInteger(maxTrackedClients) || maxTrackedClients < 1 || maxTrackedClients > 50000
      || !Number.isSafeInteger(now)) throw new TypeError('Invalid rate limit policy.');
  let earliestExpiry = Infinity;
  for (const [trackedKey, entry] of store) {
    if (!entry || entry.expiresAt <= now) store.delete(trackedKey);
    else earliestExpiry = Math.min(earliestExpiry, entry.expiresAt);
  }
  const entry = store.get(key);
  if (entry) {
    if (entry.count >= limit) return { allowed: false, retryAfterMs: Math.max(entry.expiresAt - now, 1000) };
    return { allowed: true };
  }
  if (store.size >= maxTrackedClients) {
    return { allowed: false, retryAfterMs: Math.max(earliestExpiry - now, 1000) };
  }
  return { allowed: true };
}

function consumeRateLimitGroup(policies, now = Date.now()) {
  const results = policies.map(({ store, key, policy }) => inspectRateLimit(store, key, policy, now));
  const denied = results.filter(result => !result.allowed);
  if (denied.length) return { allowed: false, retryAfterMs: Math.max(...denied.map(result => result.retryAfterMs)) };
  for (const { store, key, policy } of policies) {
    const entry = store.get(key);
    if (entry) entry.count++;
    else store.set(key, { count: 1, expiresAt: now + policy.windowMs });
  }
  return { allowed: true };
}

function consumeRateLimitAttempt(store, key, policy, now = Date.now()) {
  return consumeRateLimitGroup([{ store, key, policy }], now);
}

function checkRateLimitAttempt(store, key, policy, now = Date.now()) {
  return inspectRateLimit(store, key, policy, now);
}

function boundedPositiveInteger(value, fallback, maximum = 50000) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

module.exports = { consumeRateLimitAttempt, checkRateLimitAttempt, consumeRateLimitGroup, boundedPositiveInteger };
