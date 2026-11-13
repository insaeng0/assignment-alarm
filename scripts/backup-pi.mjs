#!/usr/bin/env node
// Read-only Pi exports. Private bytes go only to a newly created local backup directory.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE = 'ubuntu@10.150.1.0';
const EXPORTS = [
  { name: 'database.sql', command: 'assignment-backup-database-v1', maxBytes: 64 * 1024 * 1024 },
  { name: 'images.tar.gz', command: 'assignment-backup-images-v1', archive: 'images', maxBytes: 600 * 1024 * 1024 },
  { name: 'restore-config.tar.gz', command: 'assignment-backup-config-v1', archive: 'config', maxBytes: 4 * 1024 * 1024 }
];
const CONFIG_FILES = new Set([
  '.env.pi', '.runtime/tunnel-token', 'docker-compose.yml',
  'deploy/assignment-alarm-tunnel.service',
  'etc/systemd/system/assignment-alarm-tunnel.service'
]);
const fail = message => new Error(message);

async function privateDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
    throw fail('Backup directory must be an owned regular directory.');
  await fs.chmod(directory, 0o700);
}

async function validateAuthentication() {
  const runtime = path.join(ROOT, '.runtime');
  const runtimeStat = await fs.lstat(runtime);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== process.getuid()
      || (runtimeStat.mode & 0o077)) throw fail('Private runtime directory must have mode 700.');
  for (const [name, secret] of [['pi-known-hosts', false], ['pi-backup-ed25519', true]]) {
    const stat = await fs.lstat(path.join(runtime, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & (secret ? 0o077 : 0o022)))
      throw fail('Pinned SSH host/key files have unsafe ownership or permissions.');
  }
  return [
    '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-i', path.join(runtime, 'pi-backup-ed25519'), '-o', 'IdentityAgent=none',
    // A password-authenticated master bypasses the key's forced command: never reuse it.
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + path.join(runtime, 'pi-known-hosts'),
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
    '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR'
  ];
}

async function download(sshArguments, artifact, destination, signal) {
  if (signal.aborted) throw fail('Backup interrupted.');
  const child = spawn('/usr/bin/ssh', [...sshArguments, REMOTE, artifact.command], {
    cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe']
  });
  // Never echo a remote program's diagnostics; they may contain private configuration.
  child.stderr.resume();
  let spawnFailed = false, timedOut = false;
  child.once('error', () => { spawnFailed = true; });
  const ended = new Promise(resolve => child.once('close', (code, childSignal) => resolve({ code, childSignal })));
  const stop = () => { child.kill('SIGTERM'); };
  signal.addEventListener('abort', stop, { once: true });
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30 * 60_000);
  const environmentStream = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  let receivedBytes = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    receivedBytes += chunk.length;
    callback(receivedBytes > artifact.maxBytes ? fail('Export exceeds its size limit.') : null, chunk);
  } });
  try {
    const [, result] = await Promise.all([pipeline(child.stdout, limit, environmentStream, { signal }), ended]);
    if (spawnFailed || result.code !== 0 || result.childSignal || timedOut || signal.aborted)
      throw fail('Remote export did not finish successfully.');
    const handle = await fs.open(destination, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    child.kill('SIGKILL');
    await ended;
    throw fail('Export failed: ' + artifact.name + '. Partial backup retained.');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', stop);
  }
}

// Validate archive framing/checksums without extracting or retaining file contents in RAM.
class TarCheck extends Writable {
  constructor(kind) {
    super(); this.kind = kind; this.block = Buffer.alloc(512); this.used = 0;
    this.bytes = 0; this.maxBytes = (kind === 'images' ? 768 : 4) * 1024 * 1024;
    this.remaining = 0; this.zeros = 0; this.entries = 0; this.found = new Set();
  }
  _write(chunk, encoding, callback) {
    try {
      this.bytes += chunk.length;
      if (this.bytes > this.maxBytes) throw fail('Expanded archive exceeds its size limit.');
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining) {
          const count = Math.min(this.remaining, chunk.length - offset);
          this.remaining -= count; offset += count; continue;
        }
        const count = Math.min(512 - this.used, chunk.length - offset);
        chunk.copy(this.block, this.used, offset); this.used += count; offset += count;
        if (this.used === 512) { this.header(); this.used = 0; }
      }
      callback();
    } catch (error) { callback(error); }
  }
  header() {
    const block = this.block;
    if (block.every(byte => byte === 0)) { this.zeros++; return; }
    if (this.zeros) throw fail('Archive contains bytes after its terminator.');
    const octal = (start, length) => {
      const text = block.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
      if (!/^[0-7]+$/.test(text)) throw fail('Invalid archive numeric header.');
      const value = parseInt(text, 8);
      if (!Number.isSafeInteger(value)) throw fail('Archive numeric header is too large.');
      return value;
    };
    const checksum = octal(148, 8);
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : block[i];
    if (actual !== checksum) throw fail('Archive header checksum failed.');
    const field = (start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const prefix = field(345, 155), filename = field(0, 100);
    const name = (prefix ? prefix + '/' : '') + filename;
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))
      throw fail('Unsafe archive path.');
    const type = block[156];
    if (![0, 48, 53].includes(type)) throw fail('Archive contains unsupported links or metadata.');
    if (this.kind === 'images' && name !== 'assignment-images' && !name.startsWith('assignment-images/'))
      throw fail('Unexpected image archive path.');
    if (this.kind === 'config' && !CONFIG_FILES.has(name)) throw fail('Unexpected restore configuration path.');
    const size = octal(124, 12);
    if (type === 53 && size !== 0) throw fail('Invalid archive directory size.');
    this.found.add(name); this.entries++;
    this.remaining = Math.ceil(size / 512) * 512;
  }
  _final(callback) {
    if (this.used || this.remaining || this.zeros < 2 || !this.entries)
      return callback(fail('Archive is incomplete.'));
    if (this.kind === 'config' && [...CONFIG_FILES].some(name => !this.found.has(name)))
      return callback(fail('Restore configuration archive is missing required files.'));
    callback();
  }
}

async function inspectArtifact(filename, archive, signal) {
  const digest = createHash('sha256');
  let bytes = 0;
  const hashing = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length; digest.update(chunk); callback(null, chunk);
  } });
  const checker = archive ? new TarCheck(archive) : new Writable({ write(chunk, encoding, callback) { callback(); } });
  const streams = [createReadStream(filename), hashing];
  if (archive) streams.push(createGunzip());
  streams.push(checker);
  await pipeline(...streams, { signal });
  if (!bytes) throw fail('Export file is empty.');
  return { bytes, sha256: digest.digest('hex'), ...(archive ? { archiveEntries: checker.entries } : {}) };
}

async function writePrivate(filename, value) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}

// link() fails if the final filename exists, unlike rename() which could overwrite it.
async function finalize(partial, final) { await fs.link(partial, final); await fs.unlink(partial); }

export async function backupPi() {
  process.umask(0o077);
  const sshArguments = await validateAuthentication();
  const parent = path.join(ROOT, 'backups');
  await privateDirectory(parent);
  const backupRoot = path.join(parent, 'pi');
  await privateDirectory(backupRoot);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const directory = path.join(backupRoot, timestamp + '-' + randomBytes(8).toString('hex'));
  await fs.mkdir(directory, { mode: 0o700 });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let completed = false;
  try {
    const files = [];
    for (const artifact of EXPORTS) {
      const partial = path.join(directory, artifact.name + '.part');
      await download(sshArguments, artifact, partial, abort.signal);
      const details = await inspectArtifact(partial, artifact.archive, abort.signal);
      files.push({ name: artifact.name, ...details });
    }
    const manifest = {
      version: 1, createdAt: new Date().toISOString(), source: REMOTE,
      sourceDirectory: '/home/ubuntu/seongmin/assignment-alarm',
      consistency: 'Sequential live exports; database and images are not an atomic snapshot.', files
    };
    await writePrivate(path.join(directory, 'manifest.json.part'), JSON.stringify(manifest, null, 2) + '\n');
    if (abort.signal.aborted) throw fail('Backup interrupted.');
    // All streamed files have passed validation before any receives its final name.
    for (const name of [...files.map(file => file.name), 'manifest.json'])
      await finalize(path.join(directory, name + '.part'), path.join(directory, name));
    await writePrivate(path.join(directory, 'COMPLETE'), '');
    completed = true;
    console.log('백업 경로: ' + directory);
    console.log('백업 파일: ' + files.length + '개, ' + files.reduce((sum, file) => sum + file.bytes, 0) + '바이트');
    return directory;
  } catch (error) {
    // Preserve everything for diagnosis; never delete or overwrite another backup.
    console.error('백업 실패: ' + directory + ' (완료 표시 없음; 원격 데이터 출력 생략)');
    throw error;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (!completed) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  backupPi().catch(() => {
    console.error('Pi 백업을 완료하지 못했습니다. SSH 전용키·호스트 고정 및 .part 파일을 확인하세요.');
    process.exitCode = 1;
  });
}
