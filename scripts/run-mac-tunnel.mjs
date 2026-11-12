#!/usr/bin/env node
// Manual tunnel supervisor. No Docker restarts, OS startup entries, or credential output.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FRONTEND_ORIGIN = 'https://insaeng0.github.io';
export const REPOSITORY = 'insaeng0/assignment-alarm';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const invalid = message => Object.assign(new Error(message), { code: 'CONFIG_INVALID' });

export function providerOrigin(value) {
  const raw = String(value || '').trim();
  if (!/^https:\/\/[a-z0-9.-]+\/?$/i.test(raw)) throw invalid('Tunnel origin must be a path-free HTTPS provider URL.');
  const url = new URL(raw);
  const suffix = ['.lhr.life', '.localhost.run', '.trycloudflare.com'].find(end => url.hostname.endsWith(end));
  const prefix = suffix && url.hostname.slice(0, -suffix.length);
  if (!prefix || url.hostname.length > 253 || !prefix.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))
    throw invalid('Unexpected tunnel provider hostname.');
  if (suffix === '.trycloudflare.com' && prefix.includes('.')) throw invalid('Unexpected Cloudflare quick-tunnel hostname.');
  return url.origin;
}

export function cloudflareTunnelOrigin(line) {
  if (typeof line !== 'string' || line.length > 256 * 1024) return null;
  const found = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|]|$)/i)?.[0];
  try { return found ? providerOrigin(found) : null; } catch { return null; }
}

export function cloudflareArguments(hostPort) {
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw invalid('Invalid tunnel port.');
  return ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${hostPort}`, '--protocol', 'http2', '--edge-ip-version', '4'];
}

export function nextProvider(provider, configured, failedAttempts) {
  if (configured !== 'auto' || failedAttempts < 2) return provider;
  return provider === 'cloudflare' ? 'localhost.run' : 'cloudflare';
}

export function acceptedTunnelOrigin(line) {
  if (typeof line !== 'string' || line.length > 256 * 1024) return null;
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (event?.specversion !== '1.0') return null;
  try {
    let raw;
    if (event.type === 'v1.tcpip_forward.register.accepted' && event.source === 'ssh://localhost.run/') {
      raw = typeof event.id === 'string' && /^localhost\/[a-z0-9.-]+$/i.test(event.id)
        ? 'https://' + event.id.slice('localhost/'.length)
        : typeof event.data === 'string' ? event.data.match(/https:\/\/[^\s<>"']+/i)?.[0] : null;
    } else if (event.type === 'run.localhost.tunnel.registered') {
      const source = new URL(event.source);
      if (source.protocol !== 'ssh:' || source.hostname !== 'localhost.run' || source.port || source.username || source.password || source.search || source.hash || !/^\/sessions\/[^/]+$/.test(source.pathname)) return null;
      if (typeof event.data?.address !== 'string' || event.subject !== event.data.address) return null;
      raw = 'https://' + event.data.address;
    } else return null;
    if (!raw) return null;
    const safe = providerOrigin(raw);
    return ['.lhr.life', '.localhost.run'].some(suffix => new URL(safe).hostname.endsWith(suffix)) ? safe : null;
  } catch { return null; }
}

export function validatePrivateEnv(text) {
  const values = Object.create(null);
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (Object.hasOwn(values, match[1])) throw invalid('Duplicate private configuration key: ' + match[1]);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  if (values.PAGES_AUTH_MODE !== 'bearer' || values.NODE_ENV !== 'production') throw invalid('Production bearer mode is required.');
  if (values.FRONTEND_ORIGIN !== FRONTEND_ORIGIN) throw invalid('FRONTEND_ORIGIN does not match the configured Pages origin.');
  if (!/^[1-9]\d{0,4}$/.test(values.HOST_PORT || '') || Number(values.HOST_PORT) > 65535) throw invalid('HOST_PORT must be an integer from 1 to 65535.');
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(values.GOOGLE_CLIENT_ID || '')) throw invalid('A configured Google web client ID is required.');
  if (!/^[a-f0-9]{64}$/.test(values.AUTH_REALM_ID || '')) throw invalid('A stable AUTH_REALM_ID is required.');
  const provider = values.TUNNEL_PROVIDER || 'auto';
  if (!['auto', 'cloudflare', 'localhost.run'].includes(provider)) throw invalid('Invalid tunnel provider.');
  if (!/^APP_ORIGIN=/m.test(text)) throw invalid('APP_ORIGIN is missing.');
  return { hostPort: Number(values.HOST_PORT), frontendOrigin: values.FRONTEND_ORIGIN, googleClientId: values.GOOGLE_CLIENT_ID, authRealm: values.AUTH_REALM_ID, provider };
}

export function replaceAppOrigin(text, origin) {
  validatePrivateEnv(text);
  const safe = providerOrigin(origin);
  return text.replace(/^APP_ORIGIN=[^\r\n]*/m, 'APP_ORIGIN=' + safe);
}

export async function updateAppOrigin(envPath, origin) {
  const stat = await fs.lstat(envPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalid('Private environment must be a regular file.');
  const original = await fs.readFile(envPath, 'utf8');
  const updated = replaceAppOrigin(original, origin);
  const temp = envPath + '.tunnel-' + process.pid + '-' + randomBytes(6).toString('hex');
  try {
    await fs.writeFile(temp, updated, { mode: 0o600, flag: 'wx' });
    const current = await fs.readFile(envPath, 'utf8');
    if (current !== original) throw invalid('Private configuration changed while updating the tunnel.');
    await fs.rename(temp, envPath);
    await fs.chmod(envPath, 0o600);
  } finally { await fs.rm(temp, { force: true }); }
}

export function sshArguments(hostPort, knownHosts) {
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw invalid('Invalid tunnel port.');
  return ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentityFile=none', '-o', 'IdentitiesOnly=yes',
    '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=none',
    '-o', 'ForwardAgent=no', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + knownHosts, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'LogLevel=ERROR', '-R', `80:127.0.0.1:${hostPort}`, 'nokey@localhost.run', '--', '--output', 'json'];
}

export function githubCommands(origin) {
  const safe = providerOrigin(origin);
  return [
    ['variable', 'set', 'ASSIGNMENT_API_BASE_URL', '--repo', REPOSITORY, '--body', safe],
    ['workflow', 'run', 'pages.yml', '--repo', REPOSITORY, '--ref', 'main', '-f', 'api_base_url=' + safe]
  ];
}

export async function verifyBackend(origin, config, { fetcher = fetch, signal } = {}) {
  const safe = providerOrigin(origin);
  for (const route of ['/api/health', '/api/public-config']) {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetcher(safe + route, { headers: { Origin: FRONTEND_ORIGIN }, redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error('Public backend is not healthy.');
    const body = await response.json();
    if (response.headers.get('access-control-allow-origin') !== FRONTEND_ORIGIN) throw invalid('Public backend CORS origin does not match Pages.');
    if (route === '/api/health' && body?.status !== 'ok') throw new Error('Public backend health is not ready.');
    if (route === '/api/public-config' && (body?.authMode !== 'bearer' || body.googleClientId !== config.googleClientId || body.authRealm !== config.authRealm)) throw invalid('Public backend authentication configuration does not match private settings.');
  }
  return true;
}

export function adoptionFingerprint(output, hostPort, uid) {
  const value = String(output || '').trim();
  if (!value.startsWith(String(uid) + ' ') || !/\bcloudflared tunnel\b/.test(value)
    || !value.includes('--url http://127.0.0.1:' + hostPort + ' ')
    || /--(?:token|credentials-file)\b/.test(value)) throw invalid('Existing recovery process does not match this app.');
  return value;
}

export async function runSupervisor({ repositoryRoot = root, existingCloudflare = null } = {}) {
  const envPath = path.join(repositoryRoot, '.env.mac');
  const config = validatePrivateEnv(await fs.readFile(envPath, 'utf8'));
  const runtime = path.join(repositoryRoot, '.runtime');
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(runtime)).isSymbolicLink()) throw invalid('Runtime directory must not be a symbolic link.');
  await fs.chmod(runtime, 0o700);
  const knownHosts = path.join(runtime, 'localhost-run-known-hosts');
  try { await fs.writeFile(knownHosts, '', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if ((await fs.lstat(knownHosts)).isSymbolicLink()) throw invalid('Known-hosts file must not be a symbolic link.');
  await fs.chmod(knownHosts, 0o600);
  const aborter = new AbortController();
  let child = null, stopped = false, candidate = null, lastDispatchedOrigin = null, failures = 0, busy = false;
  let provider = config.provider === 'auto' ? 'cloudflare' : config.provider;
  let failedAttempts = 0;
  let retryTimer, handshakeTimer, heartbeat, adoptedMonitor, candidateSince = 0;
  const state = async status => {
    const payload = { provider, status, origin: candidate, lastDispatchedOrigin, supervisorPid: process.pid, tunnelPid: child?.pid || null, sshPid: provider === 'localhost.run' ? child?.pid || null : null, updatedAt: new Date().toISOString() };
    const temp = path.join(runtime, '.tunnel-state-' + randomBytes(6).toString('hex'));
    await fs.writeFile(temp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, path.join(runtime, 'tunnel-state.json'));
  };
  const log = message => console.log('[tunnel] ' + message);
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const killOwnedChild = () => {
    clearInterval(adoptedMonitor);
    const owned = child; child = null;
    if (!owned) return;
    owned.kill('SIGTERM');
    const force = setTimeout(() => { if (owned.exitCode === null && !owned.signalCode) owned.kill('SIGKILL'); }, 2000);
    force.unref();
  };
  const stop = async reason => {
    if (stopped) return;
    stopped = true; clearTimeout(retryTimer); clearTimeout(handshakeTimer); clearInterval(heartbeat);
    aborter.abort(); killOwnedChild();
    await state(reason).catch(() => {});
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    finish();
  };
  const onSignal = () => { void stop('stopped'); };
  const reconnect = () => {
    if (stopped) return;
    clearTimeout(handshakeTimer); killOwnedChild(); candidate = null; failures = 0;
    failedAttempts++;
    const next = nextProvider(provider, config.provider, failedAttempts);
    if (next !== provider) { provider = next; failedAttempts = 0; log('Switching HTTPS tunnel provider.'); }
    void state('retrying').catch(() => {});
    if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 5000);
  };
  const adopt = async () => {
    if (busy || stopped || !candidate || !child) return;
    busy = true;
    const origin = candidate, owned = child;
    try {
      const latest = validatePrivateEnv(await fs.readFile(envPath, 'utf8'));
      if (latest.hostPort !== config.hostPort || latest.googleClientId !== config.googleClientId || latest.authRealm !== config.authRealm || latest.provider !== config.provider) throw invalid('Private settings changed; restart the manual supervisor.');
      await verifyBackend(origin, latest, { signal: aborter.signal });
      if (stopped || candidate !== origin || child !== owned) return;
      failures = 0; failedAttempts = 0;
      if (lastDispatchedOrigin !== origin) {
        await state('publishing');
        await updateAppOrigin(envPath, origin);
        for (const args of githubCommands(origin)) {
          if (stopped || candidate !== origin || child !== owned) return;
          await execute('gh', args, { cwd: repositoryRoot, shell: false, timeout: 30_000, maxBuffer: 32 * 1024, signal: aborter.signal });
        }
        if (stopped || candidate !== origin || child !== owned) return;
        lastDispatchedOrigin = origin;
        log('API verified; Pages publication requested: ' + origin);
      }
      await state('publish_requested');
    } catch (error) {
      if (stopped || candidate !== origin || child !== owned) return;
      if (error?.code === 'CONFIG_INVALID') { log('Configuration mismatch; tunnel stopped.'); await stop('configuration_error'); return; }
      failures++;
      await state('verification_or_publish_retry').catch(() => {});
      log('Verification/publication failed; will retry.');
      if (failures >= 3 && (lastDispatchedOrigin === origin || Date.now() - candidateSince >= 120_000)) reconnect();
    } finally { busy = false; }
  };
  const connect = () => {
    if (stopped) return;
    const environment = { ...process.env }; delete environment.SSH_AUTH_SOCK; delete environment.SSH_AGENT_PID;
    const selectedProvider = provider;
    const command = selectedProvider === 'cloudflare' ? process.env.CLOUDFLARED_BIN || 'cloudflared' : '/usr/bin/ssh';
    const args = selectedProvider === 'cloudflare' ? cloudflareArguments(config.hostPort) : sshArguments(config.hostPort, knownHosts);
    child = spawn(command, args, { cwd: repositoryRoot, shell: false, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const owned = child;
    const consume = stream => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 256 * 1024) { buffer = ''; return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          const origin = selectedProvider === 'cloudflare' ? cloudflareTunnelOrigin(line) : acceptedTunnelOrigin(line);
          if (!origin || stopped || child !== owned || origin === candidate) continue;
          candidate = origin; candidateSince = Date.now(); failures = 0; clearTimeout(handshakeTimer);
          log('Tunnel candidate: ' + origin);
          void adopt();
        }
      });
    };
    consume(owned.stdout); consume(owned.stderr);
    const ended = () => { if (!stopped && child === owned) { log('Tunnel process disconnected; reconnecting.'); reconnect(); } };
    owned.on('error', ended); owned.on('exit', ended);
    handshakeTimer = setTimeout(() => { if (!candidate && child === owned) reconnect(); }, selectedProvider === 'cloudflare' ? 75_000 : 45_000);
    void state('connecting').catch(() => {});
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  heartbeat = setInterval(() => { void adopt(); }, 20_000);
  log('Manual supervisor starting.');
  if (existingCloudflare) {
    try {
    if (!['auto', 'cloudflare'].includes(config.provider) || !Number.isSafeInteger(existingCloudflare.pid) || existingCloudflare.pid < 2) throw invalid('Invalid recovery process.');
    const origin = providerOrigin(existingCloudflare.origin);
    if (!new URL(origin).hostname.endsWith('.trycloudflare.com')) throw invalid('Invalid recovery provider.');
    const identity = async () => adoptionFingerprint((await execute('/bin/ps', ['-p', String(existingCloudflare.pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='], { timeout: 2000 })).stdout, config.hostPort, process.getuid());
    const fingerprint = await identity();
    const owned = { pid: existingCloudflare.pid, exitCode: null, signalCode: null, kill(signal) {
      void identity().then(current => { if (current === fingerprint) process.kill(existingCloudflare.pid, signal); }).catch(() => {});
    } };
    provider = 'cloudflare'; child = owned; candidate = origin; candidateSince = Date.now();
    adoptedMonitor = setInterval(() => {
      if (stopped || child !== owned) return;
      void identity().then(current => { if (current !== fingerprint) throw new Error('process changed'); })
        .catch(() => { if (!stopped && child === owned) { owned.exitCode = 0; reconnect(); } });
    }, 10000);
    await adopt();
    } catch (error) { await stop('configuration_error'); throw error; }
  } else connect();
  await done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const pid = process.env.ASSIGNMENT_ADOPT_CLOUDFLARE_PID;
  const origin = process.env.ASSIGNMENT_ADOPT_CLOUDFLARE_ORIGIN;
  runSupervisor({ existingCloudflare: pid || origin ? { pid: Number(pid), origin } : null }).catch(() => { console.error('[tunnel] Startup failed; check private settings, SSH and gh access.'); process.exitCode = 1; });
}
