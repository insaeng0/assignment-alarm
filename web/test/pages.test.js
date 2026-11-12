const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const builder = () => import(pathToFileURL(path.resolve(__dirname, '../../scripts/build-pages.mjs')).href);

test('Pages rejects invalid origins and CSP/script injection in public configuration', async () => {
  const { validateApiOrigin, contentSecurityPolicy } = await builder();
  assert.equal(validateApiOrigin('https://api.example.com/'), 'https://api.example.com');
  for (const value of ['', 'http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com/api', 'https://api.example.com?x=1', 'https://api.example.com#x', "https://api'.example", 'https://api.example.com/\"><script>alert(1)</script>', 'https://*.example.com']) {
    assert.throws(() => validateApiOrigin(value));
    assert.throws(() => contentSecurityPolicy(value));
  }
  const csp = contentSecurityPolicy('https://api.example.com');
  assert.match(csp, /connect-src 'self' https:\/\/api\.example\.com https:\/\/accounts\.google\.com\/gsi\//);
  assert.match(csp, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client;/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /style-src[^;]*https:\/\/accounts\.google\.com\/gsi\/style/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp));
  assert.ok(!csp.includes('unsafe-eval'));
});

test('Pages artifact contains only live frontend files with public bearer config and enforced CSP', async () => {
  const { buildPages, frontendFiles } = await builder();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'assignment-pages-'));
  const output = path.join(temp, 'site');
  try {
    const result = await buildPages({ apiBaseUrl: 'https://api.example.com', outputDir: output });
    assert.equal(result.authMode, 'bearer');
    const names = await fs.readdir(output, { recursive: true });
    const actual = [];
    for (const name of names) if ((await fs.stat(path.join(output, name))).isFile()) actual.push(name.replace(/\\/g, '/'));
    assert.deepEqual(actual.sort(), [...frontendFiles, 'js/runtime-config.js'].sort());
    for (const name of actual) assert.ok(!/(^|\/)(\.env|server\.js|uploads|node_modules|mysql|chatbot)/.test(name), name);
    const runtime = await fs.readFile(path.join(output, 'js/runtime-config.js'), 'utf8');
    const context = vm.createContext({ window: {} });
    vm.runInContext(runtime, context);
    assert.equal(context.window.ASSIGNMENT_CONFIG.apiBaseUrl, 'https://api.example.com');
    assert.equal(context.window.ASSIGNMENT_CONFIG.authMode, 'bearer');
    for (const name of actual.filter(name => name.endsWith('.html'))) {
      const html = await fs.readFile(path.join(output, name), 'utf8');
      assert.ok(html.includes('http-equiv="Content-Security-Policy"'), name);
      assert.ok(html.includes('name="referrer" content="strict-origin-when-cross-origin"'), name);
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html), 'no inline script: ' + name);
      if (html.includes('js/api.js')) {
        assert.ok(html.indexOf('js/runtime-config.js') < html.indexOf('js/api.js'), name);
        assert.ok(html.includes(`js/runtime-config.js?v=${result.runtimeConfigVersion}`), name);
      }
    }
    const index = await fs.readFile(path.join(output, 'index.html'), 'utf8');
    assert.ok(index.includes('url=calendar.html'));
    assert.ok(index.includes('src="js/index.js'));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('Pages rebuild replaces only empty or builder-owned output and preserves unrelated files', async () => {
  const { buildPages } = await builder();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'assignment-pages-ownership-'));
  const owned = path.join(temp, 'owned');
  const unrelated = path.join(temp, 'personal');
  const linked = path.join(temp, 'linked');
  try {
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(unrelated, 'important.txt'), 'keep this file');
    await fs.writeFile(path.join(unrelated, '.nojekyll'), '');
    await assert.rejects(buildPages({ apiBaseUrl: 'https://api.example.com', outputDir: unrelated }), /nonempty directory/);
    assert.equal(await fs.readFile(path.join(unrelated, 'important.txt'), 'utf8'), 'keep this file');
    await fs.symlink(unrelated, linked);
    await assert.rejects(buildPages({ apiBaseUrl: 'https://api.example.com', outputDir: linked }), /symbolic link/);
    assert.equal(await fs.readFile(path.join(unrelated, 'important.txt'), 'utf8'), 'keep this file');
    await assert.rejects(buildPages({ apiBaseUrl: 'https://api.example.com', outputDir: path.parse(temp).root }), /separate/);
    await fs.mkdir(owned);
    const first = await buildPages({ apiBaseUrl: 'https://api.example.com', outputDir: owned });
    await fs.writeFile(path.join(owned, 'stale-build.txt'), 'old artifact');
    const second = await buildPages({ apiBaseUrl: 'https://next-api.example.com', outputDir: owned });
    assert.notEqual(first.runtimeConfigVersion, second.runtimeConfigVersion);
    const page = await fs.readFile(path.join(owned, 'login.html'), 'utf8');
    assert.ok(page.includes(`js/runtime-config.js?v=${second.runtimeConfigVersion}`));
    assert.ok(!page.includes(`js/runtime-config.js?v=${first.runtimeConfigVersion}`));
    await assert.rejects(fs.access(path.join(owned, 'stale-build.txt')));
    assert.match(await fs.readFile(path.join(owned, 'js/runtime-config.js'), 'utf8'), /next-api\.example\.com/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('Pages pins a stable public realm and invalidates runtime cache when it changes', async () => {
  const { buildPages } = await builder();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'assignment-pages-realm-'));
  try {
    const options = { apiBaseUrl: 'https://api.example.com', outputDir: path.join(temp, 'site') };
    const first = await buildPages({ ...options, authRealm: 'a'.repeat(64) });
    assert.match(await fs.readFile(path.join(options.outputDir, 'js/runtime-config.js'), 'utf8'), new RegExp('a'.repeat(64)));
    const second = await buildPages({ ...options, authRealm: 'b'.repeat(64) });
    assert.notEqual(first.runtimeConfigVersion, second.runtimeConfigVersion);
    for (const authRealm of ['short', '<script>evil</script>', 'a'.repeat(63) + '\n']) await assert.rejects(buildPages({ ...options, authRealm }));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
