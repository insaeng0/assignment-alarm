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
  const context = vm.createContext({ window, document, URL: options.URL || URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
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

test('private upload markup uses an authenticated loader and normal external images remain ordinary images', () => {
  const { api } = createAPI({ origin: 'https://student.github.io', pathname: '/assignment/calendar.html', config: bearerConfig });
  const protectedMarkup = api.renderTextWithLinks('![자료](/uploads/example.png)');
  assert.ok(protectedMarkup.includes('data-protected-image-src="https://api.school.example/uploads/example.png"'));
  assert.ok(!/\ssrc=/.test(protectedMarkup), 'private uploads must not issue an unauthenticated image request');
  const externalMarkup = api.renderTextWithLinks('![사진](https://images.example/photo.png)');
  assert.ok(externalMarkup.includes(' src="https://images.example/photo.png"'));
  assert.ok(!externalMarkup.includes('data-protected-image-src'));
  assert.equal(api.isSafeContentImageUrl('https://api.school.example/api/auth/me'), false);
  assert.equal(api.isSafeContentImageUrl('javascript:alert(1)'), false);
  assert.equal(api.resolveContentUrl('uploads/example.png').href, 'https://api.school.example/uploads/example.png');
  const attributes = new Map();
  const image = { setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k) };
  api.setImageSource(image, '/uploads/profile.png');
  assert.equal(image.src, undefined);
  assert.equal(attributes.get('data-protected-image-src'), 'https://api.school.example/uploads/profile.png');
  assert.equal(api.normalizeUser({ id: 1, profile_image_url: '/uploads/profile.png' }).profile_image_url, 'https://api.school.example/uploads/profile.png');
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
  api.setCachedPublicConfig({ googleClientId: 'id' });
  assert.equal(api.getCachedPublicConfig().googleClientId, 'id');
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

test('class approval fails closed for missing/zero flags and administrators bypass only by an explicit admin flag', () => {
  const { api } = createAPI();
  for (const is_class_approved of [undefined, false, 0, '0']) {
    const user = api.normalizeUser({ id: 1, is_admin: '0', is_class_approved });
    assert.equal(api.hasClassAccess(user), false);
    assert.equal(api.landingPage(user), '/pending.html');
  }
  assert.equal(api.hasClassAccess(api.normalizeUser({ id: 1, class_approved: 1 })), true);
  assert.equal(api.hasClassAccess(api.normalizeUser({ id: 2, is_admin: true, is_class_approved: false })), true);
});

test('pending users are routed away from class pages while their tab session remains usable for status checks', async () => {
  let requests = 0;
  const { api, window } = createAPI({ config: bearerConfig, pathname: '/assignment/calendar.html', fetch: async () => { requests++; return response({}); } });
  api.setToken(token, expiresAt());
  api.setUser({ id: 1, grade: 1, class_number: 2, is_class_approved: false });
  api.requireAuth();
  assert.equal(window.location.href, '/assignment/pending.html');
  assert.equal(await api.ensureUser(), null);
  assert.equal(requests, 0, 'cached pending identity must not initialize a class page');
  window.location.href = '';
  const user = await api.ensureUser({ allowPending: true });
  assert.equal(user.is_class_approved, false);
  assert.equal(window.location.href, '');
  assert.equal(api.getToken(), token);
});

test('me and explicit pending refresh do not loop and receive the latest approval state', async () => {
  let approved = false;
  const seen = [];
  const { api, window } = createAPI({ pathname: '/assignment/pending.html', fetch: async url => { seen.push(url); return response({ user_id: 1, name: '학생', grade: 1, class_number: 2, is_class_approved: approved, is_admin: false }); } });
  assert.equal((await api.me()).is_class_approved, false);
  assert.equal(window.location.href, '');
  assert.equal((await api.ensureUser({ force: true, allowPending: true })).is_class_approved, false);
  assert.equal(window.location.href, '');
  approved = true;
  const refreshed = await api.ensureUser({ force: true, allowPending: true });
  assert.equal(api.landingPage(refreshed), '/assignment/calendar.html');
  assert.ok(seen.every(url => url.endsWith('/api/auth/me')));
});

test('concurrent status and class-page callers independently enforce approval around a shared me request', async () => {
  let resolve;
  let calls = 0;
  const { api, window } = createAPI({ pathname: '/assignment/calendar.html', fetch: async () => { calls++; return await new Promise(done => { resolve = done; }); } });
  const status = api.ensureUser({ force: true, allowPending: true });
  const protectedPage = api.ensureUser({ force: true });
  resolve(response({ user_id: 1, grade: 1, class_number: 2, is_class_approved: false }));
  assert.equal((await status).is_class_approved, false);
  assert.equal(await protectedPage, null);
  assert.equal(calls, 1);
  assert.equal(window.location.href, '/assignment/pending.html');
});

test('class approval 403 redirects API and private images without deleting the pending login session', async () => {
  const denial = { code: 'CLASS_APPROVAL_REQUIRED', error: '반 확인 대기 중' };
  const { api, window } = createAPI({ config: bearerConfig, pathname: '/assignment/calendar.html', fetch: async () => response(denial, 403) });
  api.setToken(token, expiresAt());
  api.setUser({ id: 1, grade: 1, class_number: 2, is_class_approved: true });
  const denied = await api.getAssignments();
  assert.equal(denied.code, 'CLASS_APPROVAL_REQUIRED');
  assert.equal(window.location.href, '/assignment/pending.html');
  assert.equal(api.getUser().is_class_approved, false);
  assert.equal(api.getToken(), token);
  window.location.href = '';
  await assert.rejects(api.requestImage('/uploads/example.png'));
  assert.equal(window.location.href, '/assignment/pending.html');
  assert.equal(api.getToken(), token);
  const pending = createAPI({ pathname: '/assignment/pending.html', fetch: async () => response(denial, 403) });
  await pending.api.getAssignments();
  assert.equal(pending.window.location.href, '', 'pending screen must not redirect to itself');
  assert.equal(pending.api.safeInternalLink('/pending.html'), '/assignment/pending.html');
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

test('Google login finalization forwards verified approval flags and chooses the pending or calendar route', async () => {
  const ui = flowDocument();
  let me = null;
  const { api, window, context } = createAPI({ pathname: '/assignment/login.html', document: ui.document, fetch: async url => url.endsWith('/api/auth/me') ? response(me || { error: 'not logged in' }, me ? 200 : 401) : response({ authMode: 'cookie', googleClientId: null, error: 'test configuration' }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/login.js'), 'utf8'), context);
  await new Promise(setImmediate);
  me = { user_id: 1, name: '학생', grade: 1, class_number: 2, is_class_approved: false, is_admin: false };
  context.testUser = me;
  await vm.runInContext('finalizeGoogleLogin(testUser)', context);
  assert.equal(window.location.replaced, '/assignment/pending.html');
  assert.equal(api.getUser().is_class_approved, false);
  me = { ...me, is_class_approved: true };
  context.testUser = me;
  await vm.runInContext('finalizeGoogleLogin(testUser)', context);
  assert.equal(window.location.replaced, '/assignment/calendar.html');
  assert.equal(api.getUser().is_class_approved, true);
});

test('pending page refresh displays the chosen class then enters the calendar only after server approval', async () => {
  const ui = flowDocument();
  let approved = false;
  const { window, context } = createAPI({ pathname: '/assignment/pending.html', document: ui.document, fetch: async () => response({ user_id: 1, name: '이학생', grade: 2, class_number: 3, is_class_approved: approved }) });
  context.API = context.window.API;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/pending.js'), 'utf8'), context);
  await new Promise(setImmediate);
  assert.equal(ui.nodes.get('pendingName').textContent, '이학생');
  assert.equal(ui.nodes.get('pendingClass').textContent, '2학년 3반');
  assert.match(ui.nodes.get('pendingStatus').textContent, /확인 대기/);
  assert.equal(window.location.href, '');
  approved = true;
  await ui.listeners.get('refreshApproval:click')();
  assert.equal(window.location.replaced, '/assignment/calendar.html');
});

test('administrator UI resets approval on a class change and saves only after identity/scope confirmation', async () => {
  const ui = flowDocument();
  const { api, context } = createAPI({ document: ui.document, windowEvents: new Map() });
  let admin = true;
  api.getUser = () => ({ id: 9, is_admin: admin });
  api.ensureUser = async () => null;
  const updates = [];
  const student = { user_id: 7, name: '김학생', google_email: 'student@bssm.hs.kr', grade: 1, class_number: 2, is_admin: false, is_class_approved: true, created_at: '2026-11-12T00:00:00.000Z' };
  api.updateAdminUser = async (id, payload) => { updates.push({ id, payload }); return { success: true }; };
  api.getAdminUsers = async () => ({ items: [student], total: 1, page: 1 });
  const confirmations = [];
  let accept = false;
  context.confirm = message => { confirmations.push(message); return accept; };
  context.API = api;
  context.AppUI = { toast() {} };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/settings.js'), 'utf8'), context);
  context.testStudent = student;
  vm.runInContext('adminSettingsState.users = [testStudent]; renderAdminUsers();', context);
  assert.ok(ui.nodes.get('adminUserList').innerHTML.includes('student@bssm.hs.kr'));
  const grade = { value: '1' };
  const classNumber = { value: '3', classList: { contains: name => name === 'admin-class-select' } };
  const approval = { checked: true };
  const note = { textContent: '' };
  const fields = { '.admin-grade-select': grade, '.admin-class-select': classNumber, '.admin-class-approval': approval, '.approval-note': note };
  const item = { dataset: { id: '7' }, querySelector: selector => fields[selector] };
  classNumber.closest = () => item;
  ui.listeners.get('adminUserList:change')({ target: classNumber });
  assert.equal(approval.checked, false);
  assert.match(note.textContent, /다시 승인/);
  approval.checked = true;
  const button = { disabled: false, closest: () => item, classList: { contains: name => name === 'save-admin-user' } };
  await ui.listeners.get('adminUserList:click')({ target: button });
  assert.equal(updates.length, 0, 'cancelled approval must not save');
  assert.match(confirmations[0], /김학생/);
  assert.match(confirmations[0], /student@bssm.hs.kr/);
  assert.match(confirmations[0], /1학년 3반/);
  accept = true;
  await ui.listeners.get('adminUserList:click')({ target: button });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 7);
  assert.equal(updates[0].payload.grade, 1);
  assert.equal(updates[0].payload.class_number, 3);
  assert.equal(updates[0].payload.class_approved, true);
  admin = false;
  await ui.listeners.get('adminUserList:click')({ target: button });
  assert.equal(updates.length, 1, 'non-admin state must not issue an admin approval request');
});
