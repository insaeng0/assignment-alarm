import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adoptionFingerprint, acceptedTunnelOrigin, cloudflareTunnelOrigin, cloudflareArguments, nextProvider, providerOrigin, validatePrivateEnv, replaceAppOrigin, updateAppOrigin, sshArguments, githubCommands, verifyBackend, FRONTEND_ORIGIN } from './run-mac-tunnel.mjs';

const origin = 'https://abcd1234.lhr.life';
const client = '12345-test.apps.googleusercontent.com';
const realm = 'a' .repeat(64);
const env = `# private\nNODE_ENV=production\nPAGES_AUTH_MODE=bearer\nFRONTEND_ORIGIN=${FRONTEND_ORIGIN}\nHOST_PORT=3100\nGOOGLE_CLIENT_ID=${client}\nAUTH_REALM_ID=${realm}\nAPP_ORIGIN=https://old.example.com\nJWT_SECRET=do-not-print\nMYSQL_PASSWORD=preserve-exactly\n`;
const event = extra => JSON.stringify({ specversion: '1.0', type: 'v1.tcpip_forward.register.accepted', source: 'ssh://localhost.run/', id: 'localhost/abcd1234.lhr.life', data: 'ignored QR and other output', ...extra });

test('only the exact accepted provider event yields a strictly bounded HTTPS origin', () => {
  assert.equal(acceptedTunnelOrigin(event()), origin);
  assert.equal(acceptedTunnelOrigin(event({ id: undefined, data: 'connected https://test.localhost.run\r\nsecret QR payload' })), 'https://test.localhost.run');
  for (const line of ['plain https://abcd1234.lhr.life', event({ type: 'v1.other' }), event({ source: 'ssh://evil.example/' }), event({ id: 'localhost/evil.example' }), event({ id: undefined, data: 'https://evil.example https://abcd1234.lhr.life' }), '{broken']) assert.equal(acceptedTunnelOrigin(line), null);
  for (const value of ['http://abcd.lhr.life', 'https://lhr.life', 'https://localhost.run', 'https://abcd.lhr.life:443', 'https://abcd.lhr.life/path', 'https://user:pass@abcd.lhr.life', 'https://abcd.lhr.life?x=1', 'https://abcd.lhr.life.evil.example', 'https://-bad.lhr.life', 'https://a_b.lhr.life']) assert.throws(() => providerOrigin(value));
});

test('private environment validation fails closed and changing origin preserves every other byte', () => {
  assert.equal(validatePrivateEnv(env).hostPort, 3100);
  for (const text of [env.replace('PAGES_AUTH_MODE=bearer', 'PAGES_AUTH_MODE=cookie'), env.replace(FRONTEND_ORIGIN, 'https://evil.example'), env.replace('HOST_PORT=3100', 'HOST_PORT=70000'), env + 'FRONTEND_ORIGIN=https://evil.example\n']) assert.throws(() => validatePrivateEnv(text));
  const updated = replaceAppOrigin(env, origin);
  assert.equal(updated.replace('APP_ORIGIN=' + origin, 'APP_ORIGIN=https://old.example.com'), env);
});

test('private origin update is atomic, private, secret-preserving and refuses symlink targets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assignment-tunnel-'));
  try {
    const file = path.join(dir, '.env.mac');
    await fs.writeFile(file, env, { mode: 0o600 });
    await updateAppOrigin(file, origin);
    assert.equal(await fs.readFile(file, 'utf8'), replaceAppOrigin(env, origin));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const link = path.join(dir, '.env.link');
    await fs.symlink(file, link);
    await assert.rejects(updateAppOrigin(link, origin));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('SSH uses no agent, private key, password, user configuration, or shell; GitHub commands contain only public configuration', () => {
  const args = sshArguments(3100, '/private/task/.runtime/known-hosts');
  for (const option of ['BatchMode=yes', 'IdentityAgent=none', 'IdentityFile=none', 'PubkeyAuthentication=no', 'ForwardAgent=no', 'StrictHostKeyChecking=accept-new', 'ServerAliveInterval=15']) assert.ok(args.includes(option));
  assert.ok(args.includes('/dev/null'));
  assert.ok(args.includes('80:127.0.0.1:3100'));
  assert.deepEqual(args.slice(-4), ['nokey@localhost.run', '--', '--output', 'json']);
  const commands = githubCommands(origin);
  assert.ok(commands[0].includes(origin));
  assert.ok(commands[1].includes('api_base_url=' + origin));
  assert.ok(!JSON.stringify(commands).includes(client));
});

test('public validation requires health, exact Pages CORS, bearer mode and the configured client ID', async () => {
  const config = validatePrivateEnv(env);
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return { ok: true, headers: { get: () => FRONTEND_ORIGIN }, json: async () => url.endsWith('/health') ? { status: 'ok' } : { authMode: 'bearer', googleClientId: client, authRealm: realm } }; };
  assert.equal(await verifyBackend(origin, config, { fetcher }), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.redirect === 'error' && call.options.headers.Origin === FRONTEND_ORIGIN));
  for (const invalidConfig of [{ authMode: 'cookie', googleClientId: client, authRealm: realm }, { authMode: 'bearer', googleClientId: 'wrong-client', authRealm: realm }, { authMode: 'bearer', googleClientId: client, authRealm: 'b'.repeat(64) }]) {
    await assert.rejects(verifyBackend(origin, config, { fetcher: async url => ({ ok: true, headers: { get: () => FRONTEND_ORIGIN }, json: async () => url.endsWith('/health') ? { status: 'ok' } : invalidConfig }) }));
  }
  await assert.rejects(verifyBackend(origin, config, { fetcher: async () => ({ ok: true, headers: { get: () => 'https://evil.example' }, json: async () => ({ status: 'ok' }) }) }));
});


test('Cloudflare recovery accepts only a bounded quick-tunnel origin and forwards only loopback', () => {
  const value = 'https://new-healthy-relay.trycloudflare.com';
  assert.equal(cloudflareTunnelOrigin(' | ' + value + ' | '), value);
  assert.equal(providerOrigin(value), value);
  for (const line of ['https://evil.example', value + '.evil.example', 'https://a.b.trycloudflare.com', 'https://trycloudflare.com', 'http://a.trycloudflare.com']) assert.equal(cloudflareTunnelOrigin(line), null);
  assert.equal(acceptedTunnelOrigin(event({ id: 'localhost/a.trycloudflare.com' })), null);
  assert.deepEqual(cloudflareArguments(3100), ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3100', '--protocol', 'http2', '--edge-ip-version', '4']);
  assert.throws(() => cloudflareArguments(0));
});
test('automatic recovery changes provider only after repeated connection failures; explicit settings remain pinned', () => {
  assert.equal(nextProvider('cloudflare', 'auto', 1), 'cloudflare');
  assert.equal(nextProvider('cloudflare', 'auto', 2), 'localhost.run');
  assert.equal(nextProvider('localhost.run', 'auto', 2), 'cloudflare');
  assert.equal(nextProvider('cloudflare', 'cloudflare', 9), 'cloudflare');
  assert.equal(validatePrivateEnv(env).provider, 'auto');
  assert.throws(() => validatePrivateEnv(env + 'TUNNEL_PROVIDER=untrusted\n'));
});

test('adopting a verified recovery process is bound to its owner, start identity and loopback target', () => {
  const identity = '501 Thu Nov 12 21:45:00 2026 /opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3100 --protocol http2';
  assert.equal(adoptionFingerprint(identity, 3100, 501), identity);
  for (const value of [identity.replace('501 ', '502 '), identity.replace(':3100 ', ':3200 '), identity.replace('cloudflared tunnel', 'other tunnel'), identity+' --token private']) assert.throws(() => adoptionFingerprint(value,3100,501));
});

test('current SSH provider events and in-process hostname rotations are recognized without accepting foreign sources', () => {
  const registered = extra => JSON.stringify({ specversion:'1.0', type:'run.localhost.tunnel.registered', source:'ssh://localhost.run/sessions/192.0.2.1:1234', subject:'fresh.lhr.life', data:{address:'fresh.lhr.life'}, ...extra });
  assert.equal(acceptedTunnelOrigin(registered()),'https://fresh.lhr.life');
  assert.equal(acceptedTunnelOrigin(registered({subject:'rotated.localhost.run',data:{address:'rotated.localhost.run'}})),'https://rotated.localhost.run');
  for (const value of [registered({source:'ssh://evil.example/sessions/1'}),registered({source:'ssh://localhost.run/sessions/'}),registered({subject:'different.lhr.life'}),registered({subject:'evil.example',data:{address:'evil.example'}}),registered({subject:'x.trycloudflare.com',data:{address:'x.trycloudflare.com'}})]) assert.equal(acceptedTunnelOrigin(value),null);
});
