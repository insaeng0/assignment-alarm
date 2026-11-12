import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, stat, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./configure-mac.mjs', import.meta.url));
const clientId = '12345-test.apps.googleusercontent.com';
const parseEnv = text => Object.fromEntries(text.split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const pos = line.indexOf('='); return [line.slice(0, pos), line.slice(pos + 1)];
}));

test('Mac setup rejects unsafe origins and missing client ID before creating secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'assignment-config-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    await copyFile(script, path.join(root, 'scripts/configure-mac.mjs'));
    for (const api of ['http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com/path', 'https://api.example.com/?x=1']) {
      assert.throws(() => execFileSync(process.execPath, ['scripts/configure-mac.mjs', '--api-origin', api, '--google-client-id', clientId], { cwd: root, stdio: 'pipe' }));
    }
    assert.throws(() => execFileSync(process.execPath, ['scripts/configure-mac.mjs', '--api-origin', 'https://api.example.com'], { cwd: root, env: { ...process.env, GOOGLE_CLIENT_ID: '' }, stdio: 'pipe' }));
    for (const admin of ['', 'outsider@gmail.com', 'student@bssm.hs.kr,outsider@gmail.com']) {
      const args = ['scripts/configure-mac.mjs', '--api-origin', 'https://api.example.com', '--google-client-id', clientId];
      if (admin) args.push('--admin-email', admin);
      assert.throws(() => execFileSync(process.execPath, args, { cwd: root, env: { ...process.env, ADMIN_GOOGLE_EMAILS: '' }, stdio: 'pipe' }));
    }
    await assert.rejects(stat(path.join(root, '.env.mac')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Mac setup keeps secrets private and preserves DB passwords when API URL changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'assignment-config-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    await copyFile(script, path.join(root, 'scripts/configure-mac.mjs'));
    const run = api => execFileSync(process.execPath, ['scripts/configure-mac.mjs', '--api-origin', api, '--google-client-id', clientId, '--admin-email', 'operator@bssm.hs.kr', '--teacher-admins', 'true'], { cwd: root, encoding: 'utf8' });
    const firstOutput = run('https://first.example.com');
    const envPath = path.join(root, '.env.mac');
    const first = parseEnv(await readFile(envPath, 'utf8'));
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    assert.equal(first.PAGES_AUTH_MODE, 'bearer');
    assert.equal(first.ADMIN_GOOGLE_EMAILS, 'operator@bssm.hs.kr');
    assert.equal(first.ALLOW_TEACHER_NUMBER_ADMINS, 'true');
    assert.equal(first.HOST_PORT, '3100');
    assert.equal(first.ASSIGNMENT_CONTAINER_PREFIX, 'assignment-mac');
    assert.equal(first.FRONTEND_ORIGIN, 'https://kaneaigonan.github.io');
    assert.equal(first.COOKIE_SAMESITE, 'lax');
    assert.match(first.JWT_SECRET, /^[a-f0-9]{96}$/);
    assert.match(first.AUTH_REALM_ID, /^[a-f0-9]{64}$/);
    for (const key of ['JWT_SECRET', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD']) assert.ok(!firstOutput.includes(first[key]));
    run('https://second.example.com');
    const second = parseEnv(await readFile(envPath, 'utf8'));
    assert.equal(second.APP_ORIGIN, 'https://second.example.com');
    for (const key of ['JWT_SECRET', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'AUTH_REALM_ID']) assert.equal(first[key], second[key]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
