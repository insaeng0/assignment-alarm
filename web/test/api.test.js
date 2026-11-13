const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function createAPI(options = {}) {
  const storage = options.storageMap || new Map();
  const session = options.sessionMap || new Map();
  const document = options.document || { documentElement: { classList: { toggle() {} }, dataset: {} }, body: null };
  const window = { location: { origin: options.origin || 'https://school.example', pathname: options.pathname || '/calendar.html', href: '', replace(value) { this.href = value; this.replaced = value; } }, ASSIGNMENT_CONFIG: options.config || {}, dispatchEvent() {} };
  if (options.embedded) { window.top = {}; window.self = {}; }
  if (options.windowEvents) window.addEventListener = (name, handler) => options.windowEvents.set(name, handler);
  const context = vm.createContext({ window, document, URL: options.URL || URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout, crypto: require('node:crypto').webcrypto, indexedDB: options.indexedDB, navigator: options.navigator,
    CustomEvent: class {}, alert() {}, fetch: options.fetch,
    ...(options.MutationObserver ? { MutationObserver: options.MutationObserver } : {}),
    sessionStorage: options.sessionStorage || { getItem:k=>session.get(k)||null, setItem:(k,v)=>session.set(k,v), removeItem:k=>session.delete(k) },
    localStorage: options.storage || { getItem:k=>storage.get(k)||null, setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/api.js'), 'utf8'), context);
  return { api: window.API, window, storage, session, context, document };
}
test('HTML and markdown cannot execute script URLs or injected attributes', () => {
  const { api } = createAPI();
  assert.equal(api.escapeHTML('<script>"&'), '&lt;script&gt;&quot;&amp;');
  assert.equal(api.renderTextWithLinks('[열기](javascript:alert(1))').includes('<a '), false);
  assert.equal(api.renderTextWithLinks('![x](data:image/svg+xml,test)').includes('<img '), false);
  assert.ok(api.renderTextWithLinks('[링크](https://example.com/?q="x")').includes('q=%22x%22'));
});
test('notification navigation accepts only app pages', () => {
  const { api } = createAPI();
  for (const unsafe of ['javascript:alert(1)', '//evil.example', '/api/auth/logout', 'https://evil.example/calendar.html']) assert.equal(api.safeInternalLink(unsafe), '');
  assert.equal(api.safeInternalLink('calendar.html?assignment=3'), '/calendar.html?assignment=3');
});

test('database timestamps and notification labels use explicit UTC input and school AM/PM across browser time zones', () => {
  const previousZone = process.env.TZ;
  try {
    let expected;
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Seoul']) {
      process.env.TZ = zone;
      const { api } = createAPI();
      assert.equal(api.parseServerTime('2026-11-13 06:05:09').toISOString(), '2026-11-13T06:05:09.000Z');
      assert.equal(api.parseServerTime('2026-11-13 06:05:09.123456').toISOString(), '2026-11-13T06:05:09.123Z');
      assert.equal(api.parseServerTime('2026-11-13T15:05:09+09:00').toISOString(), '2026-11-13T06:05:09.000Z');
      const formatted = api.formatDateTime('2026-11-13 06:05:09');
      expected ??= formatted; assert.equal(formatted, expected); assert.match(formatted, /오후/); assert.match(formatted, /3:05/);
      assert.equal(formatted, api.formatDateTime('2026-11-13T06:05:09.000Z'));
      assert.match(api.formatNotificationTime('2026-11-13T00:05:00.000Z'), /오전/);
      assert.match(api.formatNotificationTime('2026-11-13T15:05:00.000Z'), /오전/);
      assert.equal(api.formatDateTime('2026-11-13'), '', 'DATE-only deadlines must not enter timestamp formatting');
      for (const invalid of [null, '', 'bad timestamp']) assert.equal(api.formatDateTime(invalid), '');
    }
  } finally { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; }
});
test('string zero does not grant administrator UI', () => {
  const { api } = createAPI();
  assert.equal(api.normalizeUser({ id: 2, is_admin: '0', is_alarm_enabled: '0' }).is_admin, false);
  assert.equal(api.normalizeUser({ id: 2, is_admin: 1 }).is_admin, true);
});
test('blocked localStorage still permits memory user state', () => {
  const fail = () => { throw new Error('Storage denied'); };
  const { api } = createAPI({ storage: { getItem:fail, setItem:fail, removeItem:fail } });
  api.setUser({ id: 2, name:'학생', grade:1, class_number:1 });
  assert.equal(api.getUser().name, '학생');
  api.clearUser();
  assert.equal(api.getUser(), null);
});
test('network failures return a user-visible error without rejected promises', async () => {
  const { api } = createAPI({ fetch: async () => { throw new TypeError('network'); } });
  const result = await api.getAssignments();
  assert.equal(result.success, false);
  assert.match(result.error, /연결/);
});
test('proxy HTML error is handled instead of crashing JSON parsing', async () => {
  const { api } = createAPI({ fetch: async () => ({ status:502, ok:false, json:async()=>{ throw new SyntaxError('HTML'); } }) });
  const result = await api.getAssignments();
  assert.equal(result.status, 502);
  assert.equal(result.success, false);
});
test('expired authentication clears cached user and redirects', async () => {
  const { api, window } = createAPI({ fetch: async () => ({ status:401, ok:false, json:async()=>({error:'expired'}) }) });
  api.setUser({id:2});
  assert.equal((await api.me()).status, 401);
  assert.equal(api.getUser(), null);
  assert.equal(window.location.href, '/login.html');
});
test('failed logout keeps user state available for retry', async () => {
  const { api, window } = createAPI({ fetch: async () => { throw new TypeError('offline'); } });
  api.setUser({id:2});
  await api.logout();
  assert.equal(api.getUser().id, 2);
  assert.equal(window.location.href, '');
});

test('temporary server outage keeps cached identity for retry', async () => {
  const { api } = createAPI({ fetch: async () => ({ status:503, ok:false, json:async()=>({error:'일시 장애'}) }) });
  api.setUser({id:2,grade:1,class_number:2});
  await assert.rejects(api.ensureUser({force:true}), /일시 장애/);
  assert.equal(api.getUser().id, 2);
});

const bearerConfig = { apiBaseUrl: 'https://api.school.example', authMode: 'bearer' };
const token = 'header.payload.signature';
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

test('API requests resolve to the configured backend rather than the GitHub project path', async () => {
  const seen = [];
  const { api } = createAPI({ origin: 'https://student.github.io', pathname: '/assignment/calendar.html', config: { apiBaseUrl: 'https://api.school.example/' }, fetch: async (url, options) => { seen.push({ url, options }); return response([]); } });
  await api.getAssignments();
  assert.equal(seen[0].url, 'https://api.school.example/api/assignments');
  assert.equal(seen[0].options.credentials, 'include');
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(seen[0].options.headers['Content-Type'], undefined);
  const sameOrigin = createAPI({ fetch: async (url, options) => { seen.push({ url, options }); return response([]); } });
  await sameOrigin.api.getAssignments();
  assert.equal(seen[1].url, 'https://school.example/api/assignments');
  assert.equal(seen[1].options.credentials, 'same-origin');
});

test('Google bearer sessions stay in tab storage and attach only to the configured API', async () => {
  const seen = [];
  const expiration = expiresAt();
  const { api, storage, session } = createAPI({ config: bearerConfig, fetch: async (url, options) => { seen.push({ url, options }); return response(url.endsWith('/auth/google') ? { user: { id: 1 }, accessToken: token, expiresAt: expiration } : { user_id: 1 }); } });
  await api.googleAuth('verified-google-id-token');
  assert.equal(api.getToken(), token);
  assert.equal(JSON.parse(session.get('assignment-access:https://api.school.example')).expiresAt, expiration);
  assert.ok(![...storage.values()].some(value => String(value).includes(token)));
  api.requireAuth();
  assert.equal(api.getToken(), token, 'page initialization must preserve the tab session');
  await api.me();
  assert.equal(seen[1].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(seen[1].options.credentials, 'omit');
  assert.equal(seen[1].options.redirect, 'error');
  const before = seen.length;
  for (const bad of ['https://evil.example/api/assignments', 'https://api.school.example.evil.example/api/assignments', 'https://user:pass@api.school.example/api/assignments', '/uploads/private.png', '/api/../uploads/private.png']) {
    assert.equal((await api.get(bad)).success, false);
  }
  assert.equal(seen.length, before, 'invalid targets must be rejected before fetch sees a token');
});

test('tab session restore is scoped by API origin and survives a normal page reload', () => {
  const session = new Map();
  const storage = new Map();
  const first = createAPI({ config: bearerConfig, sessionMap: session, storageMap: storage });
  first.api.setToken(token, expiresAt());
  const second = createAPI({ config: bearerConfig, sessionMap: session, storageMap: storage });
  assert.equal(second.api.getToken(), token);
  const other = createAPI({ config: { ...bearerConfig, apiBaseUrl: 'https://other.school.example' }, sessionMap: session, storageMap: storage });
  assert.equal(other.api.getToken(), null);
  assert.equal(session.has('assignment-access:https://api.school.example'), false);
});

test('expired, malformed, and invalid token records cannot authorize requests', () => {
  const { api, session } = createAPI({ config: bearerConfig });
  for (const expiry of [null, Date.now() + 60_000, 'not-a-date', '2027-02-31T00:00:00.000Z', new Date(Date.now() - 1000).toISOString()]) {
    assert.equal(api.setToken(token, expiry), false);
  }
  for (const bad of ['plain-token', token + '\r\nX-Evil: yes', 'a'.repeat(9000)]) assert.equal(api.setToken(bad, expiresAt()), false);
  api.setToken(token, expiresAt());
  api.setUser({ id: 1, grade: 1, class_number: 2 });
  session.set(api.sessionKey(), JSON.stringify({ accessToken: token, expiresAt: new Date(Date.now() - 1000).toISOString(), apiOrigin: bearerConfig.apiBaseUrl }));
  assert.equal(api.getToken(), null);
  assert.equal(api.getUser(), null);
  assert.equal(session.has(api.sessionKey()), false);
  api.setToken(token, expiresAt());
  session.set(api.sessionKey(), '{invalid json');
  assert.equal(api.getToken(), null);
  assert.equal(session.has(api.sessionKey()), false);
});

test('blocked tab storage permits only in-memory sessions without localStorage fallback', () => {
  const fail = () => { throw new Error('blocked'); };
  const { api, storage } = createAPI({ config: bearerConfig, sessionStorage: { getItem: fail, setItem: fail, removeItem: fail } });
  assert.equal(api.setToken(token, expiresAt()), true);
  assert.equal(api.getToken(), token);
  assert.ok(![...storage.values()].some(value => String(value).includes(token)));
  api.clearToken();
  assert.equal(api.getToken(), null);
});

test('bearer 401 and logout clear tab credentials while preserving project-path redirects', async () => {
  const { api, session, window } = createAPI({ pathname: '/assignment/calendar.html', config: bearerConfig, fetch: async () => response({ error: 'expired' }, 401) });
  api.setToken(token, expiresAt());
  api.setUser({ id: 1 });
  await api.me();
  assert.equal(session.size, 0);
  assert.equal(api.getUser(), null);
  assert.equal(window.location.href, '/assignment/login.html');
  const offline = createAPI({ config: bearerConfig, fetch: async () => { throw Error('offline'); } });
  offline.api.setToken(token, expiresAt());
  offline.api.setUser({ id: 1 });
  await offline.api.logout();
  assert.equal(offline.api.getToken(), null);
  assert.equal(offline.api.getUser(), null);
  assert.equal(offline.window.location.href, '/login.html');
});

test('notification links and login detection work at a GitHub Pages project base', () => {
  const { api } = createAPI({ origin: 'https://student.github.io', pathname: '/assignment/calendar.html', config: bearerConfig });
  for (const value of ['calendar.html?assignment=3', '/calendar.html?assignment=3', '/assignment/calendar.html?assignment=3', 'https://student.github.io/assignment/calendar.html?assignment=3']) {
    assert.equal(api.safeInternalLink(value), '/assignment/calendar.html?assignment=3');
  }
  for (const value of ['https://evil.example/assignment/calendar.html', '/another-project/calendar.html', '/api/auth/logout', '//student.github.io/assignment/calendar.html', 'javascript:alert(1)', '/assignment/%63alendar.html']) assert.equal(api.safeInternalLink(value), '');
  assert.equal(api.isLoginPage(), false);
  for (const pathname of ['/assignment/', '/assignment', '/assignment/index.html', '/assignment/login.html']) assert.equal(createAPI({ pathname }).api.isLoginPage(), true);
});

test('assignment images use only bounded private uploads while external images become safe manual links and profiles remain supported', () => {
  const { api } = createAPI({ origin: 'https://student.github.io', pathname: '/assignment/calendar.html', config: bearerConfig });
  const protectedMarkup = api.renderTextWithLinks('![자료](/uploads/assignment-images/example.png)');
  assert.ok(protectedMarkup.includes('data-protected-image-src="https://api.school.example/uploads/assignment-images/example.png"'));
  assert.ok(!/\ssrc=/.test(protectedMarkup), 'private uploads must not issue an unauthenticated image request');
  const externalMarkup = api.renderTextWithLinks('![사진](https://images.example/photo.png)');
  assert.ok(externalMarkup.includes('href="https://images.example/photo.png"'));
  assert.ok(externalMarkup.includes('target="_blank" rel="noopener noreferrer"'));
  assert.ok(!externalMarkup.includes('<img'));
  assert.ok(!externalMarkup.includes('data-protected-image-src'));
  assert.equal(api.isSafeContentImageUrl('https://api.school.example/api/auth/me'), false);
  for (const value of ['https://school.example/uploads/assignment-images/photo.png', '/uploads/profile.png', 'https://images.example/huge.png']) {
    assert.equal(api.isSafeContentImageUrl(value), false);
    assert.ok(!api.renderTextWithLinks(`![열기](${value})`).includes('<img'));
  }
  assert.equal(api.isSafeContentImageUrl('javascript:alert(1)'), false);
  assert.equal(api.resolveContentUrl('uploads/example.png').href, 'https://api.school.example/uploads/example.png');
  const attributes = new Map();
  const image = { setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k) };
  api.setImageSource(image, '/uploads/profile.png');
  assert.equal(image.src, undefined);
  assert.equal(attributes.get('data-protected-image-src'), 'https://api.school.example/uploads/profile.png');
  assert.equal(api.normalizeUser({ id: 1, profile_image_url: '/uploads/profile.png' }).profile_image_url, 'https://api.school.example/uploads/profile.png');
  assert.equal(api.isSafeImageUrl('https://images.example/profile.png'), true, 'profile rendering keeps its separate policy');
});

test('protected image fetches use scoped bearer authorization, reject redirects and validate image bytes type', async () => {
  const seen = [];
  const blob = { type: 'image/png', size: 100 };
  const { api } = createAPI({ config: bearerConfig, fetch: async (url, options) => { seen.push({ url, options }); return { status: 200, ok: true, blob: async () => blob }; } });
  api.setToken(token, expiresAt());
  assert.equal(await api.requestImage('/uploads/example.png'), blob);
  assert.equal(seen[0].url, 'https://api.school.example/uploads/example.png');
  assert.equal(seen[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(seen[0].options.credentials, 'omit');
  assert.equal(seen[0].options.redirect, 'error');
  for (const value of ['https://evil.example/uploads/example.png', 'https://user:pass@api.school.example/uploads/example.png', 'https://api.school.example/api/auth/me', 'data:image/png,test']) await assert.rejects(api.requestImage(value));
  assert.equal(seen.length, 1);
  const invalid = createAPI({ config: bearerConfig, fetch: async () => ({ status: 200, ok: true, blob: async () => ({ type: 'text/html', size: 20 }) }) });
  invalid.api.setToken(token, expiresAt());
  await assert.rejects(invalid.api.requestImage('/uploads/example.png'), /지원하지/);
});

test('configuration errors and framed pages fail before any credentialed request', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return response({}); };
  for (const apiBaseUrl of ['javascript:alert(1)', 'http://remote.example', 'https://user:pass@api.school.example', 'https://api.school.example/api', "https://api'.example", 'https://api.school.example?x=1']) {
    const { api } = createAPI({ config: { apiBaseUrl, authMode: 'bearer' }, fetch });
    assert.equal((await api.me()).success, false);
  }
  const framed = createAPI({ config: bearerConfig, embedded: true, fetch });
  assert.match((await framed.api.me()).error, /새 탭/);
  await assert.rejects(framed.api.requestImage('/uploads/example.png'), /새 탭/);
  assert.equal(calls, 0);
});

test('public config detects auth-mode mismatch and cache is scoped to backend and mode', async () => {
  const { api } = createAPI({ config: bearerConfig, fetch: async () => response({ authMode: 'cookie', googleClientId: 'public-client-id' }) });
  const config = await api.publicConfig();
  assert.equal(config.googleClientId, null);
  assert.match(config.error, /로그인 방식/);
  api.setCachedPublicConfig({ googleClientId: 'id', authMode: 'bearer' });
  assert.equal(api.getCachedPublicConfig().googleClientId, 'id');
});

test('a failed public-config request recovers on the next call rather than caching a network outage', async () => {
  let calls = 0;
  const { api, storage } = createAPI({ config: bearerConfig, fetch: async () => {
    calls++;
    if (calls === 1) throw new TypeError('DNS unavailable');
    return response({ googleClientId: 'public-client-id', authMode: 'bearer' });
  } });
  const failed = await api.publicConfig();
  assert.equal(failed.success, false);
  assert.equal(failed.code, 'NETWORK_ERROR');
  assert.equal(storage.has(api.publicConfigCacheKey), false);
  const recovered = await api.publicConfig();
  assert.equal(recovered.googleClientId, 'public-client-id');
  assert.equal(calls, 2);
  assert.equal((await api.publicConfig()).googleClientId, 'public-client-id');
  assert.equal(calls, 2, 'healthy configuration may use the short cache');
});

test('legacy cached errors, HTTP failures, missing clients and auth-mode mismatch are discarded immediately', async () => {
  const invalid = [
    { success: false, error: 'old network failure', code: 'NETWORK_ERROR' },
    { success: false, status: 503, error: 'old HTTP failure' },
    { googleClientId: null, authMode: 'bearer' },
    { googleClientId: '', authMode: 'bearer' },
    { googleClientId: 'client', authMode: 'cookie' },
    { googleClientId: 'client', authMode: 'bearer', error: 'old config error' },
    { googleClientId: 'client' }
  ];
  for (const value of invalid) {
    let calls = 0;
    const { api, storage } = createAPI({ config: bearerConfig, fetch: async () => { calls++; return response({ googleClientId: 'recovered-client', authMode: 'bearer' }); } });
    storage.set(api.publicConfigCacheKey, JSON.stringify({ value, apiOrigin: bearerConfig.apiBaseUrl, authMode: 'bearer', fetchedAt: Date.now() }));
    assert.equal(api.getCachedPublicConfig(), null);
    assert.equal(storage.has(api.publicConfigCacheKey), false);
    assert.equal((await api.publicConfig()).googleClientId, 'recovered-client');
    assert.equal(calls, 1);
  }
});

test('missing-client and HTTP public-config failures are never persisted and can recover without a forced refresh', async () => {
  for (const failure of [response({ googleClientId: null, authMode: 'bearer' }), response({ error: 'service unavailable' }, 503)]) {
    let calls = 0;
    const { api, storage } = createAPI({ config: bearerConfig, fetch: async () => ++calls === 1 ? failure : response({ googleClientId: 'ready-client', authMode: 'bearer' }) });
    await api.publicConfig();
    assert.equal(storage.has(api.publicConfigCacheKey), false);
    assert.equal((await api.publicConfig()).googleClientId, 'ready-client');
    assert.equal(calls, 2);
  }
});

test('HTML 401 responses still clear bearer credentials before attempting JSON parsing', async () => {
  const { api, session } = createAPI({ config: bearerConfig, fetch: async () => ({ status: 401, ok: false, json: async () => { throw new SyntaxError('proxy HTML'); } }) });
  api.setToken(token, expiresAt());
  api.setUser({ id: 1 });
  assert.equal((await api.me()).status, 401);
  assert.equal(session.size, 0);
  assert.equal(api.getUser(), null);
});

test('protected image loader revokes blobs on removal/pagehide and reloads after pageshow', async () => {
  let observe;
  const images = [];
  const events = new Map();
  const revoked = [];
  let created = 0;
  class PreviewURL extends URL {
    static createObjectURL() { return 'blob:test-' + (++created); }
    static revokeObjectURL(value) { revoked.push(value); }
  }
  class Observer { constructor(callback) { observe = callback; } observe() {} }
  const document = {
    documentElement: { classList: { toggle() {} }, dataset: {} },
    body: { classList: { toggle() {} }, dataset: {} },
    querySelectorAll: () => images
  };
  const { api } = createAPI({ config: bearerConfig, document, windowEvents: events, URL: PreviewURL, MutationObserver: Observer, fetch: async () => ({ ok: true, status: 200, blob: async () => ({ type: 'image/png', size: 100 }) }) });
  api.setToken(token, expiresAt());
  const attributes = new Map([['data-protected-image-src', 'https://api.school.example/uploads/example.png']]);
  const image = { isConnected: true, getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key) };
  images.push(image);
  observe();
  await new Promise(setImmediate);
  assert.equal(image.src, 'blob:test-1');
  assert.equal(api.protectedImageStates.size, 1);
  events.get('pagehide')();
  assert.deepEqual(revoked, ['blob:test-1']);
  assert.equal(api.protectedImageStates.size, 0);
  events.get('pageshow')();
  await new Promise(setImmediate);
  assert.equal(image.src, 'blob:test-2');
  image.isConnected = false;
  images.pop();
  observe();
  assert.deepEqual(revoked, ['blob:test-1', 'blob:test-2']);
  assert.equal(api.protectedImageStates.size, 0);
});

test('registered students enter class pages regardless of legacy approval flags', () => {
  const { api } = createAPI();
  for (const is_class_approved of [undefined, false, 0, '0', true]) {
    const user = api.normalizeUser({ id: 1, is_admin: false, is_class_approved });
    assert.equal(api.hasClassAccess(user), true);
    assert.equal(api.landingPage(user), '/calendar.html');
  }
  assert.equal(api.hasClassAccess(null), false);
  assert.equal(api.landingPage(null), '/login.html');
});

test('legacy unapproved cached identities retain authentication and enter their class', async () => {
  const { api, window } = createAPI({ config: bearerConfig, pathname: '/assignment/calendar.html', fetch: async () => response({ user_id: 1, grade: 1, class_number: 2, is_class_approved: false, can_complete_assignments: true }) });
  api.setToken(token, expiresAt());
  api.setUser({ id: 1, grade: 1, class_number: 2, is_class_approved: false, can_complete_assignments: true });
  api.requireAuth();
  assert.equal((await api.ensureUser()).id, 1);
  assert.equal(window.location.href, '');
  assert.equal(api.getToken(), token);
});

test('concurrent class-page callers share identity lookup without an approval gate', async () => {
  let resolve, calls = 0;
  const { api, window } = createAPI({ fetch: async () => { calls++; return new Promise(done => { resolve = done; }); } });
  const first = api.ensureUser({ force: true }), second = api.ensureUser({ force: true });
  resolve(response({ user_id: 1, grade: 1, class_number: 2, is_class_approved: false, can_complete_assignments: true }));
  assert.equal((await first).id, 1); assert.equal((await second).id, 1);
  assert.equal(calls, 1); assert.equal(window.location.href, '');
});

test('ordinary permission failures preserve login and never route to an approval page', async () => {
  const { api, window } = createAPI({ config: bearerConfig, fetch: async () => response({ error: '권한이 없습니다.' }, 403) });
  api.setToken(token, expiresAt()); api.setUser({ id: 1, grade: 1, class_number: 1 });
  assert.equal((await api.getAssignments()).status, 403);
  assert.equal(api.getToken(), token); assert.equal(window.location.href, '');
});

function flowDocument() {
  const nodes = new Map();
  const listeners = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, classList: { toggle() {} }, addEventListener: (kind, handler) => listeners.set(id + ':' + kind, handler), setAttribute() {}, innerHTML: '', textContent: '', value: '' });
    return nodes.get(id);
  };
  return { nodes, listeners, document: { documentElement: { classList: { toggle() {} }, dataset: {} }, body: null, getElementById: node, querySelectorAll: () => [], addEventListener() {} } };
}

test('Google login finalization preserves completion capability and enters the calendar without approval', async () => {
  const ui = flowDocument();
  let me = null;
  const { api, window, context } = createAPI({ pathname: '/assignment/login.html', document: ui.document, fetch: async url => url.endsWith('/api/auth/me') ? response(me || { error: 'not logged in' }, me ? 200 : 401) : response({ authMode: 'cookie', googleClientId: null, error: 'test configuration' }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/login.js'), 'utf8'), context);
  await new Promise(setImmediate);
  me = { user_id: 1, name: '학생', grade: 1, class_number: 2, is_class_approved: false, is_admin: true, can_complete_assignments: true };
  context.testUser = me;
  await vm.runInContext('finalizeGoogleLogin(testUser)', context);
  assert.equal(window.location.replaced, '/assignment/calendar.html');
  assert.equal(api.getUser().can_complete_assignments, true);
  me = { ...me, is_class_approved: true };
  context.testUser = me;
  await vm.runInContext('finalizeGoogleLogin(testUser)', context);
  assert.equal(window.location.replaced, '/assignment/calendar.html');
  assert.equal(api.getUser().is_class_approved, true);
});

test('login exposes an explicit reconnect button after a network failure and retries only when pressed', async () => {
  const ui = flowDocument();
  let connected = false;
  let configCalls = 0;
  let rendered = 0;
  const { context, window } = createAPI({ pathname: '/assignment/login.html', document: ui.document, fetch: async url => {
    if (url.endsWith('/api/auth/me')) return response({ error: 'not logged in' }, 401);
    configCalls++;
    if (!connected) throw new TypeError('offline');
    return response({ googleClientId: 'ready-client', authMode: 'cookie' });
  } });
  window.google = { accounts: { id: { initialize() {}, renderButton() { rendered++; } } } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/login.js'), 'utf8'), context);
  await new Promise(setImmediate);
  assert.equal(configCalls, 1);
  assert.equal(ui.nodes.get('retryLoginConfig').hidden, false);
  assert.match(ui.nodes.get('authError').textContent, /연결/);
  connected = true;
  ui.listeners.get('retryLoginConfig:click')();
  await new Promise(setImmediate);
  assert.equal(configCalls, 2);
  assert.equal(rendered, 1);
  assert.equal(ui.nodes.get('retryLoginConfig').hidden, true);
  assert.equal(ui.nodes.get('authError').style.display, 'none');
});

test('an unset Google client is shown as a setup error without a network reconnect action', async () => {
  const ui = flowDocument();
  const { context } = createAPI({ pathname: '/assignment/login.html', document: ui.document, fetch: async url => url.endsWith('/api/auth/me') ? response({ error: 'not logged in' }, 401) : response({ googleClientId: null, authMode: 'cookie' }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/login.js'), 'utf8'), context);
  await new Promise(setImmediate);
  assert.equal(ui.nodes.get('retryLoginConfig').hidden, true);
  assert.match(ui.nodes.get('authError').textContent, /설정되지/);
});

test('old approval-page bookmarks redirect directly to the calendar', () => {
  const { window, context } = createAPI({ pathname: '/assignment/pending.html' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/pending.js'), 'utf8'), context);
  assert.equal(window.location.replaced, 'calendar.html');
  assert.ok(!fs.readFileSync(path.join(__dirname, '../src/pending.html'), 'utf8').includes('승인'));
});

test('administrator class edits have no approval checkbox or approval payload', async () => {
  const ui = flowDocument();
  const { api, context } = createAPI({ document: ui.document, windowEvents: new Map() });
  let admin = true; api.getUser = () => ({ id: 9, is_admin: admin }); api.ensureUser = async () => null;
  const updates = [];
  const student = { user_id: 7, name: '김학생', google_email: 'student@bssm.hs.kr', grade: 1, class_number: 2, is_admin: false, created_at: '2026-11-12T00:00:00.000Z' };
  api.updateAdminUser = async (id, payload) => { updates.push({ id, payload }); return { success: true }; };
  api.getAdminUsers = async () => ({ items: [student], total: 1, page: 1 });
  context.confirm = () => { throw new Error('Approval confirmation must not be shown'); };
  context.API = api; context.AppUI = { toast() {} };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/settings.js'), 'utf8'), context);
  context.testStudent = student;
  vm.runInContext('adminSettingsState.users = [testStudent]; renderAdminUsers();', context);
  const html = ui.nodes.get('adminUserList').innerHTML;
  assert.ok(html.includes('student@bssm.hs.kr')); assert.ok(!html.includes('승인')); assert.ok(!html.includes('admin-class-approval'));
  const fields = { '.admin-grade-select': { value: '1' }, '.admin-class-select': { value: '3' } };
  const item = { dataset: { id: '7' }, querySelector: selector => fields[selector] };
  const button = { disabled: false, closest: () => item, classList: { contains: name => name === 'save-admin-user' } };
  await ui.listeners.get('adminUserList:click')({ target: button });
  assert.equal(updates.length, 1); assert.equal(updates[0].id, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0].payload)), { grade: 1, class_number: 3 });
  admin = false; await ui.listeners.get('adminUserList:click')({ target: button });
  assert.equal(updates.length, 1, 'ordinary students cannot edit other users');
});

function rememberedStorage() {
  const records = new Map();
  const db = { objectStoreNames: { contains: () => true }, close() {}, transaction() {
    const tx = { objectStore() { return {
      get(key) { const req = {}; queueMicrotask(() => { req.result = records.has(key) ? structuredClone(records.get(key)) : undefined; req.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); }); return req; },
      put(record) { records.set(record.authRealm, structuredClone(record)); }, delete(key) { records.delete(key); }
    }; }, abort() { queueMicrotask(() => tx.onabort?.()); } };
    return tx;
  } };
  return { records, open() { const req = { result: db }; queueMicrotask(() => req.onsuccess?.()); return req; } };
}
const persistentRealm = 'a'.repeat(64);
const persistentConfig = { ...bearerConfig, authRealm: persistentRealm };
const ownerProfile = (enabled = true) => ({ id: 2, name: '소유자', grade: 1, class_number: 2, can_complete_assignments: true,
  is_admin: enabled, can_switch_admin_mode: true, admin_mode_enabled: enabled });
const refreshValue = char => 'b'.repeat(64) + '.' + char.repeat(64);
function persistentFixture() {
  const indexedDB = rememberedStorage(), storageMap = new Map(), requests = [];
  let current = refreshValue('c'), serial = 0, failNext = false;
  const retries = new Map();
  const refreshExpiry = () => new Date(Date.now() + 90 * 86400_000).toISOString();
  const session = () => ({ accessToken: token, expiresAt: expiresAt(), refreshToken: current, refreshExpiresAt: refreshExpiry(), authRealm: persistentRealm, user: { id: 2, grade: 1, class_number: 1, is_class_approved: true } });
  const fetcher = async (url, options = {}) => {
    requests.push({ url, options }); const route = new URL(url).pathname;
    if (route === '/api/public-config') return response({ authMode: 'bearer', authRealm: persistentRealm, googleClientId: 'test-client' });
    if (route === '/api/auth/google') { assert.equal(JSON.parse(options.body).rememberMe, true); return response(session()); }
    if (route === '/api/auth/refresh') {
      const body = JSON.parse(options.body), key = body.refreshToken + ':' + body.requestId;
      if (retries.has(key)) return response(retries.get(key));
      assert.equal(body.refreshToken, current); assert.match(body.requestId, /^[a-f0-9]{32}$/);
      current = refreshValue((++serial + 3).toString(16)); const result = session(); retries.set(key, result);
      if (failNext) { failNext = false; throw new TypeError('response lost after commit'); }
      return response(result);
    }
    if (route === '/api/auth/logout') return response({ success: true });
    return response({ user_id: 2, grade: 1, class_number: 1, is_class_approved: true });
  };
  let lockTail = Promise.resolve();
  const navigator = { locks: { request(_key, operation) { const next = lockTail.then(operation); lockTail = next.catch(() => {}); return next; } } };
  const open = extra => createAPI({ config: persistentConfig, storageMap, indexedDB, navigator, fetch: fetcher, ...extra });
  return { indexedDB, storageMap, requests, open, fetcher, loseNextResponse() { failNext = true; } };
}
test('remembered login survives a new browser context and relay origin changes while access stays tab scoped', async () => {
  const f = persistentFixture();
  await f.open().api.googleAuth('google-credential');
  assert.equal(f.indexedDB.records.size, 1);
  assert.ok(![...f.storageMap.values()].some(value => value.includes(refreshValue('c'))));
  const next = f.open({ config: { ...persistentConfig, apiBaseUrl: 'https://new-relay.example' } });
  assert.equal(next.api.getToken(), null);
  assert.equal((await next.api.me()).user_id, 2);
  const refresh = f.requests.find(item => item.url.endsWith('/auth/refresh'));
  assert.equal(new URL(refresh.url).origin, 'https://new-relay.example');
  assert.equal(refresh.options.credentials, 'omit'); assert.equal(refresh.options.redirect, 'error');
  assert.equal(refresh.options.headers.Authorization, undefined);
  assert.equal(next.api.getToken(), token);
});
test('a lost refresh response keeps the persisted request ID and retries without deleting remembered login', async () => {
  const f = persistentFixture(); await f.open().api.googleAuth('credential');
  const next = f.open(); f.loseNextResponse();
  assert.equal((await next.api.me()).success, false);
  const record = structuredClone(f.indexedDB.records.get(persistentRealm));
  assert.ok(record.pendingRequestId);
  assert.equal((await next.api.me()).user_id, 2);
  const sent = f.requests.filter(item => item.url.endsWith('/auth/refresh')).map(item => JSON.parse(item.options.body));
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
  assert.equal(f.indexedDB.records.get(persistentRealm).pendingRequestId, null);
});
test('a mismatched server realm never receives a remembered credential', async () => {
  const f = persistentFixture(); await f.open().api.googleAuth('credential');
  const next = f.open({ fetch: async url => { assert.ok(url.endsWith('/public-config')); return response({ authMode: 'bearer', googleClientId: 'client', authRealm: 'd'.repeat(64) }); } });
  const result = await next.api.me(); assert.equal(result.success, false);
  assert.equal(f.indexedDB.records.size, 1); assert.equal(next.window.location.href, '');
});
test('concurrent requests share renewal and logout prevents a late refresh from restoring credentials', async () => {
  const f = persistentFixture(); await f.open().api.googleAuth('credential');
  const next = f.open(); await Promise.all([next.api.me(), next.api.me()]);
  assert.equal(f.requests.filter(item => item.url.endsWith('/auth/refresh')).length, 1);
  let release, started;
  const begin = new Promise(resolve => { started = resolve; });
  const late = f.open({ fetch: async (url, options) => {
    if (url.endsWith('/auth/refresh')) { started(); await new Promise(resolve => { release = resolve; }); }
    return f.fetcher(url, options);
  } });
  const renewal = late.api.refreshRememberedSession(); await begin;
  await late.api.logout(); release(); await renewal;
  assert.equal(late.api.getToken(), null); assert.equal(f.indexedDB.records.size, 0);
});

test('list cache renders across page contexts but is scoped to identity, class, role and freshness', async () => {
  const storageMap = new Map(), sessionMap = new Map();
  const setup = extra => createAPI({ config: persistentConfig, storageMap, sessionMap, fetch: async () => response([{ assignment_id: 3, title: 'cached' }]), ...extra });
  const first = setup(); first.api.setToken(token, expiresAt()); first.api.setUser({ id: 2, grade: 1, class_number: 1, can_complete_assignments: true });
  await first.api.getAssignments();
  const next = setup();
  assert.equal(next.api.getCachedData('/api/assignments')[0].title, 'cached');
  next.api.setUser({ id: 2, grade: 1, class_number: 2, can_complete_assignments: true });
  assert.equal(next.api.getCachedData('/api/assignments'), null);
  next.api.setCachedData('/api/assignments', [{ assignment_id: 5 }]);
  next.api.clearUser(); assert.equal(next.api.getCachedData('/api/assignments'), null);
  assert.ok(![...storageMap.keys()].some(key => key.startsWith('assignment-data:')));
});
test('cache canonicalizes queries and never stores an older read across a write', async () => {
  let finish;
  const { api } = createAPI({ fetch: async (_url, options) => options.method === 'GET' ? new Promise(resolve => { finish = resolve; }) : response({ success: true }) });
  api.setUser({ id: 2, grade: 1, class_number: 1, is_admin: true });
  api.setCachedData('/api/admin/users?page=1&pageSize=10', { items: [{ user_id: 3 }], total: 1 });
  assert.equal(api.getCachedData('/api/admin/users?pageSize=10&page=1').total, 1);
  const read = api.getAssignments();
  await api.createAssignment({ title: 'new' });
  finish(response([{ assignment_id: 1 }])); await read;
  assert.equal(api.getCachedData('/api/assignments'), null);
});
test('small mutations use keepalive and successful writes are never repeated after concurrent token renewal', async () => {
  let finish, count = 0, saved;
  const { api } = createAPI({ config: persistentConfig, fetch: async (_url, options) => { count++; saved = options; return new Promise(resolve => { finish = resolve; }); } });
  api.setToken(token, expiresAt()); api.setUser({ id: 2, grade: 1, class_number: 1 });
  const write = api.createAssignment({ title: 'hello' });
  api.setToken('new.payload.signature', expiresAt()); finish(response({ success: true, assignment_id: 7 }));
  assert.equal((await write).assignment_id, 7); assert.equal(count, 1); assert.equal(saved.keepalive, true);
});
test('remembered restoration uses its authoritative profile without a redundant me request', async () => {
  const f = persistentFixture(); await f.open().api.googleAuth('credential');
  f.requests.length = 0;
  const fresh = f.open();
  const user = await fresh.api.ensureUser(); assert.equal(user.id, 2);
  assert.equal(f.requests.filter(item => item.url.endsWith('/auth/refresh')).length, 1);
  assert.equal(f.requests.filter(item => item.url.endsWith('/auth/me')).length, 0);
});

test('admin mode changes install only confirmed owner state, invalidate scoped caches, and share duplicate writes', async () => {
  let finish, writes = 0;
  const { api } = createAPI({ fetch: async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/users/me/admin-mode'); assert.equal(options.method, 'PUT');
    assert.deepEqual(JSON.parse(options.body), { enabled: false }); writes++;
    return new Promise(done => { finish = done; });
  } });
  api.setUser(ownerProfile());
  api.setCachedData('/api/admin/users', { items: [{ user_id: 3 }] });
  api.notificationCache = { identity: api.userIdentity(), items: ['old'], fetchedAt: Date.now() };
  const first = api.setAdminMode(false), duplicate = api.setAdminMode(false);
  assert.equal(api.getUser().is_admin, true); assert.equal(writes, 1);
  finish(response({ success: true, user: ownerProfile(false) }));
  assert.equal((await first).success, true); await duplicate;
  assert.equal(api.getUser().is_admin, false); assert.equal(api.getUser().can_switch_admin_mode, true);
  assert.equal(api.getCachedData('/api/admin/users'), null); assert.equal(api.notificationCache, null);
  assert.equal((await api.setAdminMode('true')).success, false); assert.equal(writes, 1);
});

test('a profile lookup started before a confirmed mode change cannot reinstall stale admin privileges', async () => {
  let finishBody, bodyStarted;
  const begun = new Promise(done => { bodyStarted = done; }); let reads = 0;
  const { api } = createAPI({ fetch: async url => {
    if (url.endsWith('/admin-mode')) return response({ success: true, user: ownerProfile(false) });
    reads++;
    return reads === 1 ? { status: 200, ok: true, json: () => { bodyStarted(); return new Promise(done => { finishBody = done; }); } } : response(ownerProfile(false));
  } });
  api.setUser(ownerProfile());
  const read = api.ensureUser({ force: true }); await begun;
  await api.setAdminMode(false); finishBody(ownerProfile());
  assert.equal((await read).is_admin, false); assert.equal(api.getUser().is_admin, false);
});

test('a refresh begun before mode-off keeps the rotated remembered credential without restoring the old role', async () => {
  const fixture = persistentFixture(); let finishBody, bodyStarted;
  const begun = new Promise(done => { bodyStarted = done; });
  const { api } = fixture.open({ fetch: async (url, options) => {
    if (url.endsWith('/admin-mode')) return response({ success: true, user: ownerProfile(false) });
    const result = await fixture.fetcher(url, options);
    if (!url.endsWith('/auth/refresh')) return result;
    const data = await result.json();
    return { status: 200, ok: true, json: () => { bodyStarted(); return new Promise(done => { finishBody = () => done({ ...data, user: ownerProfile() }); }); } };
  } });
  await api.googleAuth('credential'); api.setUser(ownerProfile());
  const old = fixture.indexedDB.records.get(persistentRealm).refreshToken;
  const renewal = api.refreshRememberedSession(); await begun;
  await api.setAdminMode(false); finishBody();
  assert.equal((await renewal).refreshed, true);
  assert.equal(api.getUser().is_admin, false); assert.equal(api.getUser().can_switch_admin_mode, true);
  assert.notEqual(fixture.indexedDB.records.get(persistentRealm).refreshToken, old);
});

test('successful nonremembered account switch discards the previous remembered identity while a failed login preserves it', async () => {
  const fixture = persistentFixture();
  const { api } = fixture.open({ fetch: async (url, options) => {
    if (url.endsWith('/auth/google')) {
      const body = JSON.parse(options.body);
      if (body.credential === 'B-failed') return response({ error: 'Google 인증 실패' }, 401);
      if (body.credential === 'B') {
        assert.equal(body.rememberMe, false);
        return response({ accessToken: 'new.payload.signature', expiresAt: expiresAt(), user: { id: 3, grade: 2, class_number: 2 } });
      }
    }
    return fixture.fetcher(url, options);
  } });
  await api.googleAuth('A');
  const previous = fixture.indexedDB.records.get(persistentRealm).refreshToken;
  await api.post('/api/auth/google', { credential: 'B-failed', rememberMe: false });
  assert.equal(fixture.indexedDB.records.get(persistentRealm).refreshToken, previous);
  assert.equal(api.getUser().id, 2); assert.equal(api.getToken(), token);
  await api.post('/api/auth/google', { credential: 'B', rememberMe: false });
  assert.equal(api.getUser().id, 3); assert.equal(api.getToken(), 'new.payload.signature');
  assert.equal(fixture.indexedDB.records.has(persistentRealm), false);
  const reopened = fixture.open();
  assert.equal(await reopened.api.readRememberedSession(), null);
});

test('a delayed previous-account refresh cannot repopulate remembered storage or replace a new nonremembered session', async () => {
  const fixture = persistentFixture(); let finishBody, bodyStarted;
  const begun = new Promise(done => { bodyStarted = done; });
  const { api } = fixture.open({ fetch: async (url, options) => {
    if (url.endsWith('/auth/google') && JSON.parse(options.body).credential === 'B') return response({ accessToken: 'new.payload.signature', expiresAt: expiresAt(), user: { id: 3, grade: 2, class_number: 2 } });
    const result = await fixture.fetcher(url, options);
    if (!url.endsWith('/auth/refresh')) return result;
    const data = await result.json();
    return { status: 200, ok: true, json: () => { bodyStarted(); return new Promise(done => { finishBody = () => done(data); }); } };
  } });
  await api.googleAuth('A');
  const renewal = api.refreshRememberedSession(); await begun;
  await api.post('/api/auth/google', { credential: 'B', rememberMe: false }); finishBody(); await renewal;
  assert.equal(api.getUser().id, 3); assert.equal(api.getToken(), 'new.payload.signature');
  assert.equal(fixture.indexedDB.records.has(persistentRealm), false);
});

test('a late refresh 401 cannot clear a new account or a newly confirmed mode on the same account', async () => {
  for (const boundary of ['account', 'mode']) {
    const fixture = persistentFixture(); let finishBody, bodyStarted;
    const begun = new Promise(done => { bodyStarted = done; });
    const { api } = fixture.open({ fetch: async (url, options) => {
      if (url.endsWith('/admin-mode')) return response({ success: true, user: ownerProfile(false) });
      if (url.endsWith('/auth/google') && JSON.parse(options.body).credential === 'B') return response({ accessToken: 'new.payload.signature', expiresAt: expiresAt(), user: { id: 3, grade: 2, class_number: 2 } });
      if (url.endsWith('/auth/refresh')) return { status: 401, ok: false,
        json: () => { bodyStarted(); return new Promise(done => { finishBody = () => done({ error: 'old refresh expired' }); }); } };
      return fixture.fetcher(url, options);
    } });
    await api.googleAuth('A'); api.setUser(ownerProfile());
    const renewal = api.refreshRememberedSession(); await begun;
    if (boundary === 'account') await api.post('/api/auth/google', { credential: 'B', rememberMe: false });
    else await api.setAdminMode(false);
    finishBody(); await renewal;
    assert.equal(api.getUser().id, boundary === 'account' ? 3 : 2, boundary);
    assert.equal(api.getUser().is_admin, false, boundary);
    assert.equal(api.getToken(), boundary === 'account' ? 'new.payload.signature' : token, boundary);
    assert.equal(fixture.indexedDB.records.has(persistentRealm), boundary !== 'account', boundary);
  }
});

test('an old account refresh conflict never rotates or consumes the new account remembered credential', async () => {
  const fixture = persistentFixture(); let finishConflict, started, refreshes = 0;
  const begun = new Promise(done => { started = done; });
  const bSession = () => ({ accessToken: 'new.payload.signature', expiresAt: expiresAt(), refreshToken: refreshValue('e'),
    refreshExpiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(), authRealm: persistentRealm, user: { id: 3, grade: 2, class_number: 2 } });
  const { api } = fixture.open({ fetch: async (url, options) => {
    if (url.endsWith('/auth/google') && JSON.parse(options.body).credential === 'B') return response(bSession());
    if (url.endsWith('/auth/refresh')) {
      refreshes++;
      if (refreshes > 1) return response({ ...bSession(), refreshToken: refreshValue('f') });
      started(); return new Promise(done => { finishConflict = () => done(response({ code: 'REFRESH_RACE' }, 409)); });
    }
    return fixture.fetcher(url, options);
  } });
  await api.googleAuth('A');
  const old = api.refreshRememberedSession(); await begun;
  await api.googleAuth('B'); finishConflict(); await old;
  assert.equal(refreshes, 1); assert.equal(api.getUser().id, 3); assert.equal(api.getToken(), 'new.payload.signature');
  assert.equal(fixture.indexedDB.records.get(persistentRealm).refreshToken, refreshValue('e'));
  assert.equal(fixture.indexedDB.records.get(persistentRealm).pendingRequestId, null);
});

test('a protected image does not retry across a mode change during token renewal', async () => {
  let finishRenewal, started;
  const begun = new Promise(done => { started = done; }); let fetches = 0;
  const { api } = createAPI({ config: bearerConfig, fetch: async () => { fetches++; return response({ error: 'expired' }, 401); } });
  api.setToken(token, expiresAt()); api.setUser(ownerProfile());
  api.refreshRememberedSession = () => { started(); return new Promise(done => { finishRenewal = done; }); };
  const pending = api.requestImage('/uploads/private.png'); await begun;
  api.setUser(ownerProfile(false)); api.setToken('new.payload.signature', expiresAt());
  finishRenewal({ refreshed: true });
  await assert.rejects(pending, error => error.code === 'AUTH_CHANGED');
  assert.equal(fetches, 1); assert.equal(api.getUser().is_admin, false);
});

test('an old protected-image response or body cannot cross an account, role, class or logout boundary', async () => {
  for (const boundary of ['account', 'role', 'class', 'logout']) {
    for (const delayedBody of [false, true]) {
      let finish, started;
      const begun = new Promise(done => { started = done; });
      const image = { type: 'image/png', size: 10 };
      const { api } = createAPI({ config: bearerConfig, fetch: async () => delayedBody
        ? { status: 200, ok: true, blob: () => { started(); return new Promise(done => { finish = () => done(image); }); } }
        : new Promise(done => { finish = () => done({ status: 200, ok: true, blob: async () => image }); started(); }) });
      api.setToken(token, expiresAt()); api.setUser(ownerProfile());
      const pending = api.requestImage('/uploads/private.png'); await begun;
      if (boundary === 'account') { api.setUser({ ...ownerProfile(), id: 3 }); api.setToken('new.payload.signature', expiresAt()); }
      if (boundary === 'role') api.setUser(ownerProfile(false));
      if (boundary === 'class') api.setUser({ ...ownerProfile(), class_number: 3 });
      if (boundary === 'logout') { api.logoutGeneration++; api.clearUser(); api.clearToken(); }
      finish(); await assert.rejects(pending, error => error.code === 'AUTH_CHANGED', `${boundary}/${delayedBody}`);
    }
  }
});

test('a stale image 401 never clears the new account token or retries with its credentials', async () => {
  let finish; let calls = 0;
  const { api } = createAPI({ config: bearerConfig, fetch: () => { calls++; return new Promise(done => { finish = done; }); } });
  api.setToken(token, expiresAt()); api.setUser(ownerProfile());
  const pending = api.requestImage('/uploads/private.png');
  api.setUser({ ...ownerProfile(false), id: 3 }); api.setToken('new.payload.signature', expiresAt());
  finish(response({ error: 'old expired token' }, 401));
  await assert.rejects(pending, error => error.code === 'AUTH_CHANGED');
  assert.equal(api.getToken(), 'new.payload.signature'); assert.equal(api.getUser().id, 3); assert.equal(calls, 1);
});

test('scope changes abort and revoke already displayed private image blobs', () => {
  const { api } = createAPI(); api.setUser(ownerProfile());
  let aborted = false, removed = false;
  api.protectedImageStates.set({ removeAttribute: key => { removed = key === 'src'; } },
    { controller: { abort: () => { aborted = true; } }, objectUrl: 'blob:test' });
  api.setUser(ownerProfile(false));
  assert.equal(aborted, true); assert.equal(removed, true); assert.equal(api.protectedImageStates.size, 0);
});

test('a profile response whose body arrives after logout cannot restore the old identity', async () => {
  let finishBody, started;
  const begun = new Promise(done => { started = done; });
  const { api } = createAPI({ fetch: async () => ({ status: 200, ok: true, json: () => { started(); return new Promise(done => { finishBody = done; }); } }) });
  api.setUser({ id: 1, grade: 1, class_number: 1 });
  const read = api.me(); await begun;
  api.logoutGeneration++; api.clearUser();
  finishBody({ user_id: 1, grade: 1, class_number: 1 });
  assert.equal((await read).code, 'AUTH_CHANGED'); assert.equal(api.getUser(), null);
});

test('a signed-out login page never reloads itself and successful login finalizes without another profile lookup', async () => {
  const ui = flowDocument(); let profileReads = 0;
  const { api, window, context } = createAPI({ pathname: '/assignment/login.html', document: ui.document, fetch: async url => {
    if (url.endsWith('/auth/me')) { profileReads++; return response({ error: 'not logged in' }, 401); }
    return response({ googleClientId: null, authMode: 'cookie' });
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/login.js'), 'utf8'), context);
  await new Promise(setImmediate);
  assert.equal(window.location.href, ''); assert.equal(profileReads, 1);
  api.me = async () => { throw new Error('redundant profile read'); };
  context.verifiedUser = { id: 8, grade: 1, class_number: 2, can_complete_assignments: true };
  await vm.runInContext('finalizeGoogleLogin(verifiedUser)', context);
  assert.equal(window.location.replaced, '/assignment/calendar.html');
});

test('login network recovery reads only the owner manifest and reloads once without sending tokens to a new API', async () => {
  const calls = [];
  const manifest = { apiBaseUrl: 'https://replacement.trycloudflare.com', authMode: 'bearer', authRealm: persistentRealm, runtimeConfigVersion: 'a'.repeat(12) };
  const { api, window } = createAPI({ config: persistentConfig, pathname: '/assignment/login.html', fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/js/runtime-config.json')) return response(manifest);
    throw new TypeError('old relay unavailable');
  } });
  window.ASSIGNMENT_CONFIG_VERSION = 'b'.repeat(12);
  api.setToken(token, expiresAt());
  const result = await api.me();
  assert.equal(result.code, 'CONNECTION_REFRESH');
  assert.equal(window.location.replaced, '/assignment/login.html?__connection=' + 'a'.repeat(12));
  const probe = calls.find(call => call.url.includes('runtime-config.json'));
  assert.equal(new URL(probe.url).origin, 'https://school.example');
  assert.equal(probe.options.credentials, 'omit'); assert.equal(probe.options.redirect, 'error'); assert.equal(probe.options.cache, 'no-store');
  assert.equal(probe.options.headers, undefined);
  assert.ok(!calls.some(call => call.url.startsWith(manifest.apiBaseUrl)));
  assert.equal(api.getToken(), token);
  window.location.replaced = undefined;
  assert.equal(await api.recoverRuntimeConfig(), false);
  assert.equal(window.location.replaced, undefined);
});
test('runtime recovery rejects foreign realms and unsafe origins, and never reloads an editing page', async () => {
  for (const unsafe of [{ authRealm: 'd'.repeat(64) }, { apiBaseUrl: 'http://unsafe.example' }, { apiBaseUrl: 'https://safe.example/path' }]) {
    const { api, window } = createAPI({ config: persistentConfig, pathname: '/assignment/login.html', fetch: async () => response({ apiBaseUrl: 'https://new.example', authMode: 'bearer', authRealm: persistentRealm, runtimeConfigVersion: 'a'.repeat(12), ...unsafe }) });
    window.ASSIGNMENT_CONFIG_VERSION = 'b'.repeat(12);
    assert.equal(await api.recoverRuntimeConfig(), false); assert.equal(window.location.href, '');
  }
  let calls = 0;
  const editor = createAPI({ config: persistentConfig, pathname: '/assignment/register.html', fetch: async () => { calls++; throw new Error('must not probe while editing'); } });
  editor.window.ASSIGNMENT_CONFIG_VERSION = 'b'.repeat(12);
  assert.equal(await editor.api.recoverRuntimeConfig(), false); assert.equal(calls, 0);
});
test('an old document CSP is replaced with the new owner-published document rather than weakened', async () => {
  const doc = { documentElement: { classList: { toggle() {} }, dataset: {} }, body: null,
    querySelector: () => ({ content: "default-src 'self'; connect-src 'self' https://old-relay.example" }) };
  const manifest = { ...persistentConfig, runtimeConfigVersion: 'a'.repeat(12) };
  const { api, window } = createAPI({ config: persistentConfig, pathname: '/assignment/login.html', document: doc, fetch: async () => response(manifest) });
  window.ASSIGNMENT_CONFIG_VERSION = manifest.runtimeConfigVersion;
  assert.equal(await api.recoverRuntimeConfig(), true);
  assert.match(window.location.replaced, /__connection=/);
});
test('a proxy 502 can recover a changed login connection before its HTML error body is parsed', async () => {
  const { api, window } = createAPI({ config: persistentConfig, pathname: '/assignment/login.html', fetch: async url => url.includes('runtime-config.json')
    ? response({ ...persistentConfig, apiBaseUrl: 'https://new.example', runtimeConfigVersion: 'c'.repeat(12) })
    : { status: 502, ok: false, json: async () => { throw new Error('proxy HTML'); } } });
  window.ASSIGNMENT_CONFIG_VERSION = 'b'.repeat(12);
  assert.equal((await api.publicConfig({ force: true })).code, 'CONNECTION_REFRESH');
  assert.match(window.location.replaced, /__connection=/);
});

test('a failed remembered-login refresh can recover its old connection without deleting the saved session', async () => {
  const f = persistentFixture(); await f.open().api.googleAuth('credential');
  const app = f.open({ pathname: '/assignment/login.html', fetch: async (url, options) => {
    if (url.includes('runtime-config.json')) return response({ ...persistentConfig, apiBaseUrl: 'https://new.example', runtimeConfigVersion: 'e'.repeat(12) });
    if (url.endsWith('/auth/refresh')) throw new TypeError('old relay disappeared');
    return f.fetcher(url, options);
  } });
  app.window.ASSIGNMENT_CONFIG_VERSION = 'b'.repeat(12);
  assert.equal((await app.api.refreshRememberedSession()).code, 'CONNECTION_REFRESH');
  assert.equal(f.indexedDB.records.size, 1);
  assert.match(app.window.location.replaced, /__connection=/);
});
