#!/usr/bin/env node
// Creates private Mac settings; never writes secrets into the frontend or Git.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--api-origin', '--google-client-id', '--frontend-origin', '--admin-email', '--teacher-admins', '--host-port'].includes(args[i]) || !args[i + 1]) {
    console.error('사용법: node scripts/configure-mac.mjs --api-origin https://API주소 --google-client-id Google웹클라이언트ID --admin-email 운영자학교이메일 [--frontend-origin https://kaneaigonan.github.io]');
    process.exit(1);
  }
  options[args[i]] = args[i + 1];
}

function httpsOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label}에 올바른 HTTPS origin을 입력하세요.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label}은 경로·비밀번호 없이 https://호스트 형식이어야 합니다.`);
  }
  return url.origin;
}

try {
  const apiOrigin = httpsOrigin(options['--api-origin'], 'API 주소');
  const frontendOrigin = httpsOrigin(options['--frontend-origin'] || 'https://kaneaigonan.github.io', '화면 주소');
  const hostPort = options['--host-port'] || '3100';
  if (!/^[0-9]+$/.test(hostPort) || Number(hostPort) < 1 || Number(hostPort) > 65535) throw new Error('호스트 포트는 1~65535 정수여야 합니다.');
  const envPath = path.join(root, '.env.mac');
  let existingText = '';
  try { existingText = await readFile(envPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const existing = Object.fromEntries(existingText.split(/\r?\n/).filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line)).map(line => {
    const pos = line.indexOf('='); return [line.slice(0, pos), line.slice(pos + 1)];
  }));
  const clientId = options['--google-client-id'] || existing.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId || '')) {
    throw new Error('실제 Google 웹 클라이언트 ID가 필요합니다. 기존 .env 또는 Google Cloud Console에서 확인하세요.');
  }
  const admins = String(options['--admin-email'] || existing.ADMIN_GOOGLE_EMAILS || process.env.ADMIN_GOOGLE_EMAILS || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!admins.length || admins.some(email => !/^[a-z0-9._%+-]+@bssm\.hs\.kr$/.test(email))) {
    throw new Error('반 소속을 승인할 운영자 학교 이메일이 필요합니다. --admin-email 이름@bssm.hs.kr 을 지정하세요. 최초 가입자를 자동으로 관리자로 지정하지 않습니다.');
  }
  const teacherAdmins = options['--teacher-admins'] || existing.ALLOW_TEACHER_NUMBER_ADMINS || 'false';
  if (!['true', 'false'].includes(teacherAdmins)) throw new Error('--teacher-admins에는 true 또는 false만 지정하세요.');
  // Preserve generated secrets across runs so changing the tunnel URL never resets the DB.
  const secret = (key, bytes = 32) => existing[key] || randomBytes(bytes).toString('hex');
  const values = {
    ...existing,
    MYSQL_ROOT_PASSWORD: secret('MYSQL_ROOT_PASSWORD'),
    MYSQL_DATABASE: existing.MYSQL_DATABASE || 'assignment_alarm',
    MYSQL_USER: existing.MYSQL_USER || 'assignment_user',
    MYSQL_PASSWORD: secret('MYSQL_PASSWORD'),
    JWT_SECRET: secret('JWT_SECRET', 48),
    NODE_ENV: 'production', TRUST_PROXY: '1', PORT: '3000', HOST_PORT: hostPort,
    COMPOSE_PROJECT_NAME: 'assignment-alarm-mac', ASSIGNMENT_CONTAINER_PREFIX: 'assignment-mac',
    APP_ORIGIN: apiOrigin, FRONTEND_ORIGIN: frontendOrigin,
    PAGES_AUTH_MODE: 'bearer', COOKIE_SAMESITE: 'lax',
    GOOGLE_CLIENT_ID: clientId,
    ADMIN_GOOGLE_EMAILS: [...new Set(admins)].join(','),
    ALLOW_TEACHER_NUMBER_ADMINS: teacherAdmins,
    ENABLE_ASSIGNMENT_IMAGE_UPLOADS: 'true',
    ASSIGNMENT_IMAGE_MAX_STORAGE_MB: existing.ASSIGNMENT_IMAGE_MAX_STORAGE_MB || '512'
  };
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${key}에는 줄바꿈을 넣을 수 없습니다.`);
  }
  const serialized = '# Mac backend settings. PRIVATE: never commit or publish this file.\n' + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  await writeFile(envPath, serialized, { mode: 0o600 });
  await chmod(envPath, 0o600);
  console.log('맥북 설정을 .env.mac에 저장했습니다. 비밀번호와 JWT 서명키는 출력하지 않습니다.');
  console.log('1. Docker Desktop을 실행하세요.');
  console.log('2. docker compose --env-file .env.mac up -d --build');
  console.log('3. Google 승인된 JavaScript 원본에 추가: ' + frontendOrigin);
  console.log('4. GitHub 저장소 변수 ASSIGNMENT_API_BASE_URL에 설정: ' + apiOrigin);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
