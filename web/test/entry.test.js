const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function entry(overrides = {}) {
  const nodes = new Map(), routes = [], handlers = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '', addEventListener: (type, handler) => handlers.set(id+':'+type, handler) });
    return nodes.get(id);
  };
  let identityCalls = 0;
  const API = { appPageUrl: name => '/assignment/'+name, getAuthMode: () => 'bearer', getToken: () => null,
    readRememberedSession: async () => null, ensureUser: async () => { identityCalls++; return null; }, ...overrides };
  const context = vm.createContext({ API, document: { getElementById: get }, window: { location: { search: '?assignment=3', hash: '#task', replace: route => routes.push(route) } } });
  const ready = vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/index.js'), 'utf8'), context);
  return { ready, nodes, routes, handlers, identityCalls: () => identityCalls, API };
}
test('a signed-out visitor goes straight to login without opening calendar or calling the backend', async () => {
  const page = entry(); await page.ready;
  assert.deepEqual(page.routes, ['/assignment/login.html?assignment=3#task']);
  assert.equal(page.identityCalls(), 0);
});
test('a remembered login waits on the neutral page then opens the calendar directly', async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const page = entry({ readRememberedSession: async () => ({ refreshToken: 'remembered' }), ensureUser: () => pending });
  await new Promise(setImmediate); assert.equal(page.routes.length, 0);
  finish({ id: 1 }); await page.ready;
  assert.deepEqual(page.routes, ['/assignment/calendar.html?assignment=3#task']);
});
test('an invalid existing session routes to login and a temporary failure stays retryable without clearing it', async () => {
  const invalid = entry({ getToken: () => 'access', ensureUser: async () => null }); await invalid.ready;
  assert.deepEqual(invalid.routes, ['/assignment/login.html?assignment=3#task']);
  let online = false;
  const offline = entry({ getToken: () => 'access', ensureUser: async () => { if (!online) throw new Error('연결 실패'); return { id: 2 }; } });
  await offline.ready; assert.equal(offline.routes.length, 0); assert.equal(offline.nodes.get('entryRetry').hidden, false);
  online = true; await offline.handlers.get('entryRetry:click')();
  assert.deepEqual(offline.routes, ['/assignment/calendar.html?assignment=3#task']);
});
