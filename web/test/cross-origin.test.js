const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { gzipSync } = require('node:zlib');

const secret = 'cross-origin-tests-have-a-fixed-session-signing-secret';
const imageRoot = path.join(os.tmpdir(), `assignment-split-origin-${process.pid}`);
const frontend = 'https://student.github.io';
const users = new Map([[1, { user_id: 1, name: '학생', grade: 1, class_number: 1, class_approved: 1, is_admin: 0, is_alarm_enabled: 1, google_sub: 'student-sub' }]]);
let existing = true;
const fakePool = {
  async execute(sql, params = []) {
    if (sql.includes('FROM users WHERE google_sub')) {
      const id = /^student-(\d+)-sub$/.exec(params[0])?.[1];
      return [existing ? [users.get(Number(id) || 1)] : []];
    }
    if (sql.includes('FROM users WHERE user_id')) return [users.has(params[0]) ? [users.get(params[0])] : []];
    if (sql.startsWith('INSERT INTO users')) { users.set(2, { ...users.get(1), user_id: 2, class_approved: 0 }); return [{ insertId: 2 }]; }
    return [{ affectedRows: 1 }];
  },
  async end() {}
};
class FakeGoogleClient {
  async verifyIdToken({ audience, idToken }) {
    assert.equal(audience, 'test-client');
    const id = /^user-(\d+)$/.exec(idToken)?.[1];
    const email = idToken.startsWith('email:') ? idToken.slice(6) : `student${id || ''}@bssm.hs.kr`;
    return { getPayload: () => ({ sub: id ? `student-${id}-sub` : 'student-sub', email, email_verified: true, hd: idToken === 'wrong-domain' ? 'evil.example' : 'bssm.hs.kr', name: '학생' }) };
  }
}
function loadApp(overrides = {}) {
  const settings = {
    NODE_ENV: 'production', JWT_SECRET: secret, DB_USER: 'test', DB_PASSWORD: 'test',
    GOOGLE_CLIENT_ID: 'test-client', APP_ORIGIN: 'https://legacy.example', FRONTEND_ORIGIN: frontend,
    ALLOW_TEACHER_NUMBER_ADMINS: 'false', ADMIN_GOOGLE_EMAILS: '', ADMIN_EXCLUDED_GOOGLE_EMAILS: '',
    COOKIE_SAMESITE: 'lax', PAGES_AUTH_MODE: 'cookie', PAGES_ACCESS_MAX_SESSIONS: '5000', TRUST_PROXY: 'loopback', ASSIGNMENT_IMAGE_DIR: imageRoot, ...overrides
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  const originalLoad = Module._load;
  Object.assign(process.env, settings);
  Module._load = function(name) {
    if (name === 'mysql2/promise') return { createPool: () => fakePool };
    if (name === 'google-auth-library') return { OAuth2Client: FakeGoogleClient };
    return originalLoad.apply(this, arguments);
  };
  try { delete require.cache[require.resolve('../server')]; return require('../server').app; }
  finally {
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
async function serve(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise(resolve => server.close(resolve)); }
}
function options({ method = 'GET', origin = frontend, site = 'cross-site', token, body } = {}) {
  return { method, headers: { ...(origin ? { Origin: origin } : {}), 'Sec-Fetch-Site': site,
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {})
  }, ...(body ? { body: JSON.stringify(body) } : {}) };
}
async function login(base, credential = 'school-token') {
  const response = await fetch(`${base}/api/auth/google`, options({ method: 'POST', body: { credential } }));
  assert.equal(response.status, 200);
  return { response, data: await response.json() };
}
const sessionToken = () => jwt.sign({ type: 'session', id: 1 }, secret, { algorithm: 'HS256', issuer: 'assignment-alarm', audience: 'session', expiresIn: '1h' });
const imageName = `1-1234-${'a'.repeat(32)}.png`;

test.before(async () => { await fs.mkdir(imageRoot, { recursive: true }); await fs.writeFile(path.join(imageRoot, imageName), Buffer.from([137, 80, 78, 71])); });
test.after(async () => { await fs.rm(imageRoot, { recursive: true, force: true }); });

test('configured frontend gets credentialed CORS and strict preflight including Authorization', async () => {
  await serve(loadApp(), async base => {
    const response = await fetch(`${base}/api/auth/google`, { method: 'OPTIONS', headers: { Origin: frontend,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), frontend);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(response.headers.get('vary'), /Origin/);
    assert.match(response.headers.get('vary'), /Access-Control-Request-Headers/);
    const config = await fetch(`${base}/api/public-config`, options());
    assert.equal(config.status, 200);
    assert.equal(config.headers.get('access-control-allow-origin'), frontend);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.equal((await config.json()).authMode, 'cookie');
    for (const [method, header] of [['PATCH', 'content-type'], ['POST', 'x-unapproved-header']]) {
      const invalid = await fetch(`${base}/api/auth/google`, { method: 'OPTIONS', headers: { Origin: frontend,
        'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': header } });
      assert.equal(invalid.status, 403);
      assert.equal(invalid.headers.get('access-control-allow-methods'), null);
    }
  });
});

test('optional teacher-number administrators match only exact verified school addresses and exclusions win', async () => {
  await serve(loadApp({ ALLOW_TEACHER_NUMBER_ADMINS: 'true', ADMIN_GOOGLE_EMAILS: 'owner@bssm.hs.kr', ADMIN_EXCLUDED_GOOGLE_EMAILS: 'teacher99@bssm.hs.kr' }), async base => {
    for (const [email, expected] of [['teacher1@bssm.hs.kr', 1], ['teacher001@bssm.hs.kr', 1], ['owner@bssm.hs.kr', 1], ['teacher99@bssm.hs.kr', 0], ['studentteacher1@bssm.hs.kr', 0], ['teacher@bssm.hs.kr', 0], ['teacher1extra@bssm.hs.kr', 0]]) {
      assert.equal((await login(base, 'email:' + email)).data.user.is_admin, expected, email);
    }
    const foreign = await fetch(base + '/api/auth/google', options({ method: 'POST', body: { credential: 'email:teacher1@evil.example' } }));
    assert.equal(foreign.status, 401);
  });
  await serve(loadApp(), async base => {
    assert.equal((await login(base, 'email:teacher1@bssm.hs.kr')).data.user.is_admin, 0);
  });
});

test('untrusted and opaque origins cannot read responses or log in; originless foreign writes stay blocked', async () => {
  await serve(loadApp(), async base => {
    for (const origin of ['https://evil.example', 'https://student.github.io.evil.example', 'null', 'https://legacy.example']) {
      for (const route of ['/api/public-config', '/api/auth/google']) {
        const response = await fetch(`${base}${route}`, options({ origin, ...(route.endsWith('google') ? { method: 'POST', body: { credential: 'school-token' } } : {}) }));
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
        assert.equal((await response.json()).accessToken, undefined);
      }
    }
    for (const site of ['same-site', 'cross-site']) {
      assert.equal((await fetch(`${base}/api/auth/logout`, options({ method: 'POST', site }))).status, 200);
      assert.equal((await fetch(`${base}/api/auth/logout`, options({ method: 'POST', site, origin: '' }))).status, 403);
    }
  });
});

test('default cookie mode keeps HttpOnly Lax Secure cookies and emits no browser access token', async () => {
  await serve(loadApp(), async base => {
    const { response, data } = await login(base);
    assert.equal(data.accessToken, undefined);
    assert.equal(data.expiresAt, undefined);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    assert.match(response.headers.get('set-cookie'), /; Secure/);
    const me = await fetch(`${base}/api/auth/me`, { headers: { Origin: frontend, Cookie: response.headers.get('set-cookie').split(';')[0] } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user_id, 1);
  });
});

test('APP_ORIGIN remains fallback and a same-origin local deployment still works unchanged', async () => {
  await serve(loadApp({ FRONTEND_ORIGIN: '' }), async base => {
    assert.equal((await fetch(`${base}/api/auth/logout`, options({ method: 'POST', origin: 'https://legacy.example' }))).status, 200);
  });
  await serve(loadApp({ NODE_ENV: 'test', FRONTEND_ORIGIN: '', APP_ORIGIN: '', TRUST_PROXY: 'false' }), async base => {
    const response = await fetch(`${base}/api/auth/logout`, options({ method: 'POST', origin: base, site: 'same-origin' }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure/);
  });
});

test('Pages bearer login works without cookies, retains school verification and revokes on logout', async () => {
  await serve(loadApp({ PAGES_AUTH_MODE: 'bearer' }), async base => {
    assert.equal((await fetch(`${base}/api/auth/google`, options({ method: 'POST', origin: '', site: 'none', body: { credential: 'school-token' } }))).status, 403);
    assert.equal((await fetch(`${base}/api/auth/google`, options({ method: 'POST', body: { credential: 'wrong-domain' } }))).status, 401);
    const { response, data } = await login(base);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.ok(data.accessToken);
    const payload = jwt.verify(data.accessToken, secret, { algorithms: ['HS256'], issuer: 'assignment-alarm', audience: 'pages-access' });
    assert.equal(payload.type, 'pages-access');
    assert.equal(payload.exp - payload.iat, 3600);
    assert.equal(data.expiresAt, new Date(payload.exp * 1000).toISOString());
    assert.equal((await fetch(`${base}/api/auth/me`, options({ token: data.accessToken }))).status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`, options())).status, 401);
    assert.equal((await fetch(`${base}/api/auth/me`, options({ token: sessionToken() }))).status, 401);
    assert.equal((await fetch(`${base}/uploads/assignment-images/${imageName}`, options())).status, 401);
    const image = await fetch(`${base}/uploads/assignment-images/${imageName}`, options({ token: data.accessToken }));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('access-control-allow-origin'), frontend);
    assert.equal(image.headers.get('cache-control'), 'private, no-store');
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal((await fetch(`${base}/api/auth/logout`, options({ method: 'POST', token: data.accessToken }))).status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`, options({ token: data.accessToken }))).status, 401);
  });
});

test('Pages registration returns a session and issued credentials are invalid after server restart', async () => {
  let token;
  existing = false;
  try {
    await serve(loadApp({ PAGES_AUTH_MODE: 'bearer' }), async base => {
      const initial = await login(base);
      assert.equal(initial.data.requiresProfile, true);
      assert.equal(initial.data.accessToken, undefined);
      const response = await fetch(`${base}/api/auth/google/register`, options({ method: 'POST', body: {
        setupToken: initial.data.setupToken, grade: 1, class_number: 1
      } }));
      assert.equal(response.status, 200);
      const data = await response.json();
      token = data.accessToken;
      assert.ok(token);
      assert.equal(data.user.is_class_approved, false);
      assert.equal((await fetch(`${base}/api/auth/me`, options({ token }))).status, 200);
      const protectedResponse = await fetch(`${base}/api/assignments`, options({ token }));
      assert.equal(protectedResponse.status, 403);
      assert.equal((await protectedResponse.json()).code, 'CLASS_APPROVAL_REQUIRED');
    });
  } finally { existing = true; }
  await serve(loadApp({ PAGES_AUTH_MODE: 'bearer' }), async base => {
    assert.equal((await fetch(`${base}/api/auth/me`, options({ token }))).status, 401);
    const forged = jwt.sign({ type: 'pages-access', id: 1, jti: 'not-issued' }, secret, { algorithm: 'HS256', issuer: 'assignment-alarm', audience: 'pages-access', expiresIn: '1h' });
    assert.equal((await fetch(`${base}/api/auth/me`, options({ token: forged }))).status, 401);
  });
});

test('cross-site cookies require explicit None+Secure opt-in and private images keep authorization', async () => {
  await serve(loadApp({ COOKIE_SAMESITE: 'none' }), async base => {
    const { response } = await login(base);
    assert.match(response.headers.get('set-cookie'), /SameSite=None/);
    assert.match(response.headers.get('set-cookie'), /; Secure/);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/uploads/assignment-images/${imageName}`)).status, 401);
    const image = await fetch(`${base}/uploads/assignment-images/${imageName}`, { headers: { Cookie: cookie } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(image.headers.get('cache-control'), 'private, no-store');
  });
});

test('repeated own login never evicts other users and full capacity returns 503 without revoking them', async () => {
  for (const id of [3, 4, 5]) users.set(id, { ...users.get(1), user_id: id, google_sub: `student-${id}-sub` });
  await serve(loadApp({ PAGES_AUTH_MODE: 'bearer', PAGES_ACCESS_MAX_SESSIONS: '10' }), async base => {
    const other = (await login(base, 'user-3')).data.accessToken;
    for (let index = 0; index < 8; index += 1) await login(base);
    assert.equal((await fetch(`${base}/api/auth/me`, options({ token: other }))).status, 200);
    for (let index = 0; index < 4; index += 1) await login(base, 'user-4');
    const overflow = await fetch(`${base}/api/auth/google`, options({ method: 'POST', body: { credential: 'user-5' } }));
    assert.equal(overflow.status, 503);
    assert.equal(overflow.headers.get('retry-after'), '60');
    assert.equal((await overflow.json()).accessToken, undefined);
    assert.equal((await fetch(`${base}/api/auth/me`, options({ token: other }))).status, 200);
  });
});

test('a compressed JSON frame followed by junk cannot terminate the server', async () => {
  await serve(loadApp(), async base => {
    const compressed = Buffer.concat([gzipSync('{}'), Buffer.from('invalid-trailing-data')]);
    const response = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: {
      Origin: frontend, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip'
    }, body: compressed });
    assert.ok([200, 400].includes(response.status));
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });
});

test('unsafe deployment configuration fails early with actionable errors', () => {
  for (const origin of ['https://app.example.com/path', 'https://user:secret@app.example.com', 'https://*.example.com', 'https://app.example.com?x=1']) {
    assert.throws(() => loadApp({ FRONTEND_ORIGIN: origin }), /FRONTEND_ORIGIN/);
  }
  assert.throws(() => loadApp({ COOKIE_SAMESITE: 'invalid' }), /COOKIE_SAMESITE/);
  assert.throws(() => loadApp({ NODE_ENV: 'development', COOKIE_SAMESITE: 'none' }), /COOKIE_SAMESITE=none/);
  assert.throws(() => loadApp({ FRONTEND_ORIGIN: '', APP_ORIGIN: '', COOKIE_SAMESITE: 'none' }), /explicit HTTPS/);
  assert.throws(() => loadApp({ FRONTEND_ORIGIN: 'http://app.example.com' }), /HTTPS/);
  assert.throws(() => loadApp({ PAGES_AUTH_MODE: 'invalid' }), /PAGES_AUTH_MODE/);
  assert.throws(() => loadApp({ NODE_ENV: 'test', PAGES_AUTH_MODE: 'bearer' }), /PAGES_AUTH_MODE=bearer/);
  assert.throws(() => loadApp({ FRONTEND_ORIGIN: '', PAGES_AUTH_MODE: 'bearer' }), /explicit HTTPS FRONTEND_ORIGIN/);
  assert.throws(() => loadApp({ PAGES_ACCESS_MAX_SESSIONS: '1000000' }), /PAGES_ACCESS_MAX_SESSIONS/);
});
