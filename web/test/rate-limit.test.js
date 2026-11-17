const test = require('node:test');
const assert = require('node:assert/strict');
const { consumeRateLimitAttempt, checkRateLimitAttempt, consumeRateLimitGroup, boundedPositiveInteger } = require('../lib/rate-limit');
const policy = { windowMs: 10000, limit: 3, maxTrackedClients: 2 };

test('checking an in-flight request never reserves failure capacity or increments an attempt', () => {
  const store = new Map();
  for (let index = 0; index < 20; index++) assert.equal(checkRateLimitAttempt(store, 'one', policy, 1000).allowed, true);
  assert.equal(store.size, 0);
  consumeRateLimitAttempt(store, 'one', policy, 1000);
  for (let index = 0; index < 20; index++) checkRateLimitAttempt(store, 'one', policy, 1000);
  assert.equal(store.get('one').count, 1);
});

test('fixed windows limit exact attempts, report remaining time and expire without extending a ban', () => {
  const store = new Map();
  for (let index = 0; index < 3; index++) assert.equal(consumeRateLimitAttempt(store, 'one', policy, 1000 + index).allowed, true);
  assert.deepEqual(consumeRateLimitAttempt(store, 'one', policy, 2000), { allowed: false, retryAfterMs: 9000 });
  assert.equal(store.get('one').count, 3);
  assert.equal(consumeRateLimitAttempt(store, 'one', policy, 10999).retryAfterMs, 1000);
  assert.equal(consumeRateLimitAttempt(store, 'one', policy, 11000).allowed, true);
  assert.equal(store.get('one').count, 1);
});

test('identity churn never evicts a live counter or grows a full store', () => {
  const store = new Map();
  for (let index = 0; index < 3; index++) consumeRateLimitAttempt(store, 'limited-account', policy, 1000);
  consumeRateLimitAttempt(store, 'other-account', policy, 2000);
  for (let index = 0; index < 1000; index++) {
    assert.equal(consumeRateLimitAttempt(store, 'rotating-' + index, policy, 3000).allowed, false);
    assert.equal(store.size, 2);
  }
  assert.equal(store.has('limited-account'), true);
  assert.equal(consumeRateLimitAttempt(store, 'limited-account', policy, 3000).allowed, false);
  assert.equal(consumeRateLimitAttempt(store, 'new-account', policy, 11000).allowed, true);
  assert.equal(store.has('limited-account'), false);
  assert.equal(store.has('other-account'), true);
});

test('burst and sustained limits commit together and report the longest real retry delay', () => {
  const burst = new Map(), sustained = new Map();
  const policies = [
    { store: burst, key: 'one', policy },
    { store: sustained, key: 'one', policy: { ...policy, windowMs: 600000, limit: 4 } }
  ];
  for (let index = 0; index < 3; index++) assert.equal(consumeRateLimitGroup(policies, 1000).allowed, true);
  assert.equal(consumeRateLimitGroup(policies, 2000).allowed, false);
  assert.equal(sustained.get('one').count, 3, 'a burst denial does not use another sustained request');
  assert.equal(consumeRateLimitGroup(policies, 11000).allowed, true);
  assert.deepEqual(consumeRateLimitGroup(policies, 12000), { allowed: false, retryAfterMs: 589000 });
  assert.equal(burst.get('one').count, 1, 'a sustained denial does not use a burst request');
});

test('rate configuration rejects unbounded policies and bounds optional numeric settings', () => {
  for (const changes of [{ limit: Infinity }, { limit: 0 }, { windowMs: NaN }, { maxTrackedClients: 50001 }]) {
    assert.throws(() => consumeRateLimitAttempt(new Map(), 'one', { ...policy, ...changes }, 1000), TypeError);
  }
  assert.equal(boundedPositiveInteger('Infinity', 5000), 5000);
  assert.equal(boundedPositiveInteger('2oops', 5000), 5000);
  assert.equal(boundedPositiveInteger('999999999', 5000), 50000);
  assert.equal(boundedPositiveInteger('0', 5000), 5000);
  assert.equal(boundedPositiveInteger('12', 5000), 12);
});
