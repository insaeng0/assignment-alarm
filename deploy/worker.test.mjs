import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { FRONTEND_ORIGIN } from './worker.mjs';

test('the gateway pins its private destination, preserves auth and overwrites forwarding metadata', async () => {
  let received;
  const response = await worker.fetch(new Request('https://api.example/api/assignments?grade=1', { headers: {
    Origin: FRONTEND_ORIGIN, Authorization: 'Bearer test-access', Cookie: 'private=drop',
    'CF-Connecting-IP': '203.0.113.4', 'X-Forwarded-For': 'spoof', 'X-Forwarded-Host': 'evil.example'
  } }), { ASSIGNMENT_API: { fetch: async request => { received = request; return new Response('[]'); } } });
  assert.equal(response.status, 200);
  assert.equal(received.url, 'http://assignment.internal/api/assignments?grade=1');
  assert.equal(received.headers.get('Authorization'), 'Bearer test-access');
  assert.equal(received.headers.get('Cookie'), null);
  assert.equal(received.headers.get('X-Forwarded-For'), '203.0.113.4');
  assert.equal(received.headers.get('X-Forwarded-Host'), 'api.example');
  assert.equal(received.headers.get('X-Forwarded-Proto'), 'https');
  assert.equal(received.redirect, 'manual');
});

test('foreign origins, unrelated paths and unsupported methods never reach the Pi', async () => {
  const env = { ASSIGNMENT_API: { fetch() { throw new Error('must not be called'); } } };
  for (const [path, method, origin, status] of [
    ['/api/public-config', 'GET', 'https://evil.example', 403],
    ['/', 'GET', FRONTEND_ORIGIN, 404],
    ['/uploads/private.txt', 'GET', FRONTEND_ORIGIN, 404],
    ['/api/assignments', 'PATCH', FRONTEND_ORIGIN, 405]
  ]) assert.equal((await worker.fetch(new Request('https://api.example' + path, { method, headers: { Origin: origin } }), env)).status, status);
});

test('JSON writes and authenticated image requests pass through without becoming an open proxy', async () => {
  const body = JSON.stringify({ credential: 'test-google-credential' });
  const env = { ASSIGNMENT_API: { fetch: async request => {
    assert.equal(await request.text(), body);
    assert.equal(request.headers.get('Content-Type'), 'application/json');
    return new Response('{}', { headers: { 'Access-Control-Allow-Origin': FRONTEND_ORIGIN } });
  } } };
  assert.equal((await worker.fetch(new Request('https://api.example/api/auth/google', { method: 'POST', headers: { Origin: FRONTEND_ORIGIN, 'Content-Type': 'application/json' }, body }), env)).status, 200);
  const image = await worker.fetch(new Request('https://api.example/uploads/assignment-images/test.png'), { ASSIGNMENT_API: { fetch: async request => {
    assert.equal(new URL(request.url).hostname, 'assignment.internal'); return new Response('', { status: 401 });
  } } });
  assert.equal(image.status, 401);
});

test('preflight keeps its requested method and headers while errors remain readable only by Pages', async () => {
  const request = new Request('https://api.example/api/auth/google', { method: 'OPTIONS', headers: { Origin: FRONTEND_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  let received;
  const result = await worker.fetch(request, { ASSIGNMENT_API: { fetch: async req => { received = req; return new Response(null, { status: 204 }); } } });
  assert.equal(result.status, 204);
  assert.equal(received.headers.get('Access-Control-Request-Method'), 'POST');
  assert.equal(received.headers.get('Access-Control-Request-Headers'), 'content-type');
  const failure = await worker.fetch(request, { ASSIGNMENT_API: { fetch: async () => { throw new Error('private details'); } } });
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get('Access-Control-Allow-Origin'), FRONTEND_ORIGIN);
  assert.ok(!(await failure.text()).includes('private details'));
});
