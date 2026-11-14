const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
// AI 챗봇 보관: 현재 SDK를 로드하거나 외부 AI API를 호출하지 않습니다.
// const OpenAI = require('openai');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { RefreshSessions, refreshSchema } = require('./lib/refresh-sessions');
const { validateImageDimensions } = require('./lib/image-dimensions');
const { databaseTimeOptions, installUtcDatabaseSessions } = require('./lib/database-time');
const { rosterSchema, rosterError, normalizeRosterName, studentRosterScope, lookupRoster, publicRosterCandidates } = require('./lib/student-roster');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TRUST_PROXY = parseTrustProxySetting(process.env.TRUST_PROXY);
const APP_ORIGIN = readConfiguredOrigin('APP_ORIGIN');
const CONFIGURED_FRONTEND_ORIGIN = readConfiguredOrigin('FRONTEND_ORIGIN');
const FRONTEND_ORIGIN = CONFIGURED_FRONTEND_ORIGIN || APP_ORIGIN;
const COOKIE_SAMESITE = String(process.env.COOKIE_SAMESITE || 'lax').trim().toLowerCase();
const AUTH_REALM_ID = String(process.env.AUTH_REALM_ID || '').trim();
const PAGES_AUTH_MODE = String(process.env.PAGES_AUTH_MODE || 'cookie').trim().toLowerCase();
const JWT_SECRET = process.env.JWT_SECRET || (!IS_PRODUCTION ? crypto.randomBytes(32).toString('hex') : null);
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || null;
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || null;
const TURNSTILE_ENABLED = Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
// AI 챗봇 보관: 현재 실행하지 않습니다. 재활성화 전 인증/비용/개인정보를 다시 검토하세요.
// const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
// const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash';
// const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const GOOGLE_ALLOWED_DOMAIN = 'bssm.hs.kr';
const ADMIN_MODE_OWNER_EMAIL = String(process.env.ADMIN_MODE_OWNER_EMAIL || '').trim().toLowerCase();
const ALLOW_TEACHER_NUMBER_ADMINS = process.env.ALLOW_TEACHER_NUMBER_ADMINS === 'true';
const ADMIN_GOOGLE_EMAILS = Array.from(new Set(
  String(
    process.env.ADMIN_GOOGLE_EMAILS
    || process.env.ADMIN_GOOGLE_EMAIL
    || process.env.ADMIN_EMAIL
    || ''
  )
    .split(/[,\n]/)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
));
const ADMIN_EXCLUDED_GOOGLE_EMAILS = Array.from(new Set(
  String(
    process.env.ADMIN_EXCLUDED_GOOGLE_EMAILS
    || process.env.ADMIN_EXCLUDED_EMAILS
    || ''
  )
    .split(/[,\n]/)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
));
const ADMIN_NAME = process.env.ADMIN_NAME ? String(process.env.ADMIN_NAME).trim() : null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const ADMIN_GRADE = Number.parseInt(process.env.ADMIN_GRADE || '1', 10);
const ADMIN_CLASS = Number.parseInt(process.env.ADMIN_CLASS || '1', 10);
const MAX_GRADE = 3;
const MAX_CLASS = 4;
const MAX_ASSIGNMENT_CONTENT_LENGTH = 12000;
const MAX_ASSIGNMENT_IMAGE_BYTES = 4 * 1024 * 1024;
const STATIC_ASSET_CACHE_SECONDS = 300;
const ADMIN_PAGE_SIZE_DEFAULT = 12;
const ADMIN_PAGE_SIZE_MAX = 50;
const AUTH_COOKIE_NAME = 'assignment_alarm_session';
const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAGES_ACCESS_TTL_SECONDS = 60 * 60;
const PAGES_ACCESS_MAX_SESSIONS = Number(process.env.PAGES_ACCESS_MAX_SESSIONS || 5000);
const PAGES_ACCESS_MAX_PER_USER = 5;
const pagesAccessSessions = new Map();
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT = 20;
const AUTH_RATE_MAX_TRACKED_CLIENTS = Math.max(Number.parseInt(process.env.AUTH_RATE_MAX_TRACKED_CLIENTS || '5000', 10) || 5000, 1000);
// AI 챗봇 보관: 현재 실행하지 않습니다. 재활성화 전 인증/비용/개인정보를 다시 검토하세요.
// const CHATBOT_RATE_WINDOW_MS = Math.max(Number.parseInt(process.env.CHATBOT_RATE_WINDOW_MS || '300000', 10) || 300000, 60000);
// const CHATBOT_RATE_LIMIT = Math.max(Number.parseInt(process.env.CHATBOT_RATE_LIMIT || '20', 10) || 20, 1);
const ASSIGNMENT_IMAGE_RATE_WINDOW_MS = Math.max(Number.parseInt(process.env.ASSIGNMENT_IMAGE_RATE_WINDOW_MS || '600000', 10) || 600000, 60000);
const ASSIGNMENT_IMAGE_RATE_LIMIT = Math.max(Number.parseInt(process.env.ASSIGNMENT_IMAGE_RATE_LIMIT || '10', 10) || 10, 1);
const ASSIGNMENT_WRITE_RATE_WINDOW_MS = Math.max(Number.parseInt(process.env.ASSIGNMENT_WRITE_RATE_WINDOW_MS || '600000', 10) || 600000, 60000);
const ASSIGNMENT_WRITE_RATE_LIMIT = Math.max(Number.parseInt(process.env.ASSIGNMENT_WRITE_RATE_LIMIT || '20', 10) || 20, 1);
// AI 챗봇 보관: 현재 실행하지 않습니다. 재활성화 전 인증/비용/개인정보를 다시 검토하세요.
// const CHATBOT_MAX_MESSAGE_LENGTH = 2000;
// const CHATBOT_MAX_HISTORY_ITEMS = 10;
// const CHATBOT_CONTEXT_ASSIGNMENT_LIMIT = 8;
// const CHATBOT_CONTEXT_CONTENT_LENGTH = 120;
// const CHATBOT_CONTEXT_TITLE_LENGTH = 60;
// const CHATBOT_RETRY_COUNT = Math.max(Number.parseInt(process.env.CHATBOT_RETRY_COUNT || '2', 10) || 2, 0);
// const CHATBOT_RETRY_DELAY_MS = Math.max(Number.parseInt(process.env.CHATBOT_RETRY_DELAY_MS || '1500', 10) || 1500, 0);
// const CHATBOT_RESPONSE_CACHE_TTL_MS = Math.max(Number.parseInt(process.env.CHATBOT_RESPONSE_CACHE_TTL_MS || '45000', 10) || 45000, 5000);
const authAttempts = new Map();
const refreshAttempts = new Map();
// const chatbotAttempts = new Map();
// const chatbotResponseCache = new Map();
const assignmentImageAttempts = new Map();
const assignmentWriteAttempts = new Map();
const adminUserCache = new Map();
const adminAssignmentCache = new Map();
const adminMessageCache = new Map();
const notificationCache = new Map();
const RESPONSE_CACHE_TTL_MS = 15 * 1000;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
// AI 챗봇 보관: 현재 실행하지 않습니다. 재활성화 전 인증/비용/개인정보를 다시 검토하세요.
// const gemini = GEMINI_API_KEY
//   ? new OpenAI({ apiKey: GEMINI_API_KEY, baseURL: GEMINI_BASE_URL })
//   : null;
const ASSIGNMENT_IMAGE_DIR = process.env.ASSIGNMENT_IMAGE_DIR
  ? path.resolve(process.env.ASSIGNMENT_IMAGE_DIR)
  : path.join(__dirname, 'src', 'uploads', 'assignment-images');
const ASSIGNMENT_IMAGES_ENABLED = process.env.ENABLE_ASSIGNMENT_IMAGE_UPLOADS !== 'false';
const ASSIGNMENT_IMAGE_MAX_STORAGE_BYTES = Math.max(Number(process.env.ASSIGNMENT_IMAGE_MAX_STORAGE_MB) || 512, 1) * 1024 * 1024;
let pendingImageWrite = Promise.resolve();
const ASSIGNMENT_IMAGE_PUBLIC_PATH = '/uploads/assignment-images';
const ASSIGNMENT_IMAGE_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif']
]);

const dbConfig = {
  host: process.env.MYSQLHOST || process.env.DB_HOST || 'mysql',
  port: Number(process.env.MYSQLPORT || process.env.DB_PORT) || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'assignment_alarm',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  ...databaseTimeOptions,
  ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true, ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n') } : {}) } } : {})
};

if (!JWT_SECRET || (IS_PRODUCTION && Buffer.byteLength(JWT_SECRET) < 32)) {
  throw new Error('JWT_SECRET must contain at least 32 bytes in production.');
}

if (!dbConfig.user || !dbConfig.password) {
  throw new Error('Database credentials are missing. Set MYSQLUSER/MYSQLPASSWORD or DB_USER/DB_PASSWORD.');
}

const pool = mysql.createPool(dbConfig);
installUtcDatabaseSessions(pool, { onError: () => console.error('Database UTC session initialization failed.') });
const refreshSessions = new RefreshSessions({ pool, secret: JWT_SECRET, authRealm: AUTH_REALM_ID,
  maxFamilies: PAGES_ACCESS_MAX_SESSIONS, onRevoke: revokeFamilyAccess });
if (AUTH_REALM_ID && !/^[a-f0-9]{64}$/.test(AUTH_REALM_ID)) throw new Error('AUTH_REALM_ID must be 64 lowercase hex characters.');
if (ADMIN_MODE_OWNER_EMAIL && !/^[a-z0-9._%+-]+@bssm\.hs\.kr$/.test(ADMIN_MODE_OWNER_EMAIL)) {
  throw new Error('ADMIN_MODE_OWNER_EMAIL must be one exact bssm.hs.kr school Google email, or empty.');
}
function revokeFamilyAccess(familyId) {
  for (const [jti, session] of pagesAccessSessions) if (session.familyId === familyId) pagesAccessSessions.delete(jti);
}

function parseTrustProxySetting(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'false' || normalized === '0') return false;
  if (normalized === 'true') throw new Error('Set TRUST_PROXY to a known proxy hop count or trusted subnet instead of true.');
  const numeric = Number.parseInt(normalized, 10);
  if (Number.isInteger(numeric) && String(numeric) === normalized) return numeric;
  return normalized;
}

function readConfiguredOrigin(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) return null;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) origin, for example https://app.example.com.`); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || value.includes('*')) {
    throw new Error(`${name} must contain only an exact HTTP(S) origin, without a path, credentials, query, fragment, or wildcard.`);
  }
  return parsed.origin;
}

if (!['lax', 'none'].includes(COOKIE_SAMESITE)) {
  throw new Error('COOKIE_SAMESITE must be lax or none. Use lax for same-site frontend/API domains.');
}
if (IS_PRODUCTION && FRONTEND_ORIGIN && !FRONTEND_ORIGIN.startsWith('https://')) {
  throw new Error('The configured frontend origin must use HTTPS in production.');
}
if (COOKIE_SAMESITE === 'none' && (!IS_PRODUCTION || !FRONTEND_ORIGIN || !FRONTEND_ORIGIN.startsWith('https://'))) {
  throw new Error('COOKIE_SAMESITE=none requires NODE_ENV=production and an explicit HTTPS FRONTEND_ORIGIN or APP_ORIGIN.');
}
if (!['cookie', 'bearer'].includes(PAGES_AUTH_MODE)) {
  throw new Error('PAGES_AUTH_MODE must be cookie or bearer.');
}
if (PAGES_AUTH_MODE === 'bearer' && (!IS_PRODUCTION || !CONFIGURED_FRONTEND_ORIGIN || !CONFIGURED_FRONTEND_ORIGIN.startsWith('https://'))) {
  throw new Error('PAGES_AUTH_MODE=bearer requires NODE_ENV=production and an explicit HTTPS FRONTEND_ORIGIN.');
}
if (!Number.isSafeInteger(PAGES_ACCESS_MAX_SESSIONS) || PAGES_ACCESS_MAX_SESSIONS < 5 || PAGES_ACCESS_MAX_SESSIONS > 5000) {
  throw new Error('PAGES_ACCESS_MAX_SESSIONS must be an integer from 5 to 5000.');
}

function getRequestOrigin(req) {
  try { return new URL(`${req.protocol}://${req.get('host')}`).origin; } catch { return null; }
}

function getAllowedFrontendOrigin(req) {
  return FRONTEND_ORIGIN || getRequestOrigin(req);
}

function buildContentSecurityPolicy() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://challenges.cloudflare.com",
    "font-src 'self' data: https:",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
    "frame-src 'self' https://accounts.google.com https://challenges.cloudflare.com",
    "img-src 'self' data: blob: https:",
    "object-src 'none'",
    "script-src 'self' https://accounts.google.com https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style"
  ].join('; ');
}

const bootstrapSchema = [
  `CREATE TABLE IF NOT EXISTS users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    google_sub VARCHAR(255) DEFAULT NULL,
    google_email VARCHAR(255) DEFAULT NULL,
    grade INT NOT NULL,
    class_number INT NOT NULL,
    class_approved TINYINT(1) NOT NULL DEFAULT 0,
    profile_image_url VARCHAR(500) DEFAULT NULL,
    is_alarm_enabled TINYINT(1) DEFAULT 1,
    is_admin TINYINT(1) DEFAULT 0,
    admin_mode_enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY users_grade_class_idx (grade, class_number)
  )`,
  `CREATE TABLE IF NOT EXISTS assignments (
    assignment_id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content TEXT,
    due_date DATE NOT NULL,
    target_grade INT NOT NULL,
    target_class INT DEFAULT NULL,
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE CASCADE,
    KEY assignments_scope_due_created_idx (target_grade, target_class, due_date, created_at),
    KEY assignments_created_at_idx (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    message_id INT AUTO_INCREMENT PRIMARY KEY,
    sender_id INT NOT NULL,
    content TEXT NOT NULL,
    type ENUM('grade', 'class') NOT NULL,
    target_grade INT NOT NULL,
    target_class INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(user_id) ON DELETE CASCADE,
    KEY messages_scope_type_created_idx (target_grade, type, target_class, created_at),
    KEY messages_created_at_idx (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS user_assignments (
    user_id INT NOT NULL,
    assignment_id INT NOT NULL,
    is_completed TINYINT(1) DEFAULT 0,
    PRIMARY KEY (user_id, assignment_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (assignment_id) REFERENCES assignments(assignment_id) ON DELETE CASCADE,
    KEY user_assignments_assignment_user_idx (assignment_id, user_id, is_completed)
  )`
];

app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Content-Security-Policy', buildContentSecurityPolicy());
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  if (IS_PRODUCTION && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});
// Disabled AI routes are handled before parsers/static files, including direct URLs.
app.all('/api/chatbot', (_req, res) => {
  res.status(410).json({ success: false, error: 'AI 챗봇은 현재 비활성화되어 있습니다.' });
});
app.use((req, res, next) => {
  let requestPath;
  try { requestPath = path.posix.normalize(decodeURIComponent(req.path)).toLowerCase(); } catch { return res.status(400).end(); }
  if (requestPath === '/chatbot.html' || requestPath === '/js/chatbot.js') {
    return res.status(410).type('text/plain').send('AI 챗봇은 현재 비활성화되어 있습니다.');
  }
  // Encoded/traversal aliases must not bypass upload authorization via static files.
  if (requestPath.startsWith('/uploads/') && requestPath !== req.path.toLowerCase()) return res.status(404).end();
  next();
});

// Only the explicitly configured frontend may read credentialed API responses.
// A frontend URL is public configuration; never reflect an arbitrary Origin.
app.use(['/api', '/uploads'], (req, res, next) => {
  res.vary('Origin');
  const origin = req.get('Origin');
  if (!origin) return next();
  const allowedOrigin = getAllowedFrontendOrigin(req);
  if (!allowedOrigin || origin !== allowedOrigin) {
    return res.status(403).json({ error: '허용되지 않은 사이트에서 보낸 요청입니다.' });
  }
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method !== 'OPTIONS') return next();

  res.vary('Access-Control-Request-Method');
  res.vary('Access-Control-Request-Headers');
  const requestedMethod = String(req.get('Access-Control-Request-Method') || '').toUpperCase();
  const allowedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'];
  const allowedHeaders = ['content-type', 'authorization'];
  const requestedHeaders = String(req.get('Access-Control-Request-Headers') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!allowedMethods.includes(requestedMethod) || requestedHeaders.some(header => !allowedHeaders.includes(header))) {
    return res.status(403).json({ error: '허용되지 않은 요청 방식 또는 헤더입니다.' });
  }
  res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  return res.status(204).end();
});

// Cookie writes, including login/logout, still require a trusted browser Origin.
// Split frontends may be same-site or cross-site only when that Origin matches.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const fetchSite = req.get('Sec-Fetch-Site');
  const origin = req.get('Origin');
  if (origin) {
    if (origin !== getAllowedFrontendOrigin(req)) {
      return res.status(403).json({ error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' });
    }
  } else if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return res.status(403).json({ error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' });
  }
  next();
});
// A Pages access credential must only be issued to the configured browser app.
// Originless CLI requests cannot obtain either an access token or signup token.
app.use(['/api/auth/google', '/api/auth/google/register', '/api/auth/refresh', '/api/auth/logout'], (req, res, next) => {
  if (PAGES_AUTH_MODE === 'bearer' && req.method === 'POST' && req.get('Origin') !== CONFIGURED_FRONTEND_ORIGIN) {
    return res.status(403).json({ error: '설정된 프런트엔드에서 로그인해주세요.' });
  }
  next();
});
app.use('/api/uploads/assignment-image', express.json({ limit: '6mb' }));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use('/api', (req, res, next) => {
  if (req.body !== undefined && (req.body === null || Array.isArray(req.body) || typeof req.body !== 'object')) {
    return res.status(400).json({ error: '요청 형식이 올바르지 않습니다.' });
  }
  next();
});
for (const name of ['id', 'userId']) {
  app.param(name, (req, res, next, value) => {
    const id = parseInteger(value);
    if (!id || id < 1 || id > 2147483647) return res.status(400).json({ error: '요청 정보가 올바르지 않습니다.' });
    next();
  });
}

// Assignment attachments are private and require visibility of the referenced assignment.
app.get(`${ASSIGNMENT_IMAGE_PUBLIC_PATH}/:filename`, authMiddleware, async (req, res, next) => {
  try {
    const filename = req.params.filename;
    if (!/^\d+(?:-\d+)?-[a-f0-9]{16,32}\.(png|jpg|webp|gif)$/.test(filename)) return res.status(404).end();
    const user = req.currentUser;
    const ownedByUser = filename.startsWith(`${user.user_id}-`) && /^\d+-\d+-/.test(filename);
    if (!ownedByUser && !isAdminUser(user)) {
      const [rows] = await pool.execute(
        'SELECT assignment_id FROM assignments WHERE INSTR(BINARY content, BINARY ?) > 0 AND target_grade = ? AND (target_class = ? OR target_class IS NULL) LIMIT 1',
        [`${ASSIGNMENT_IMAGE_PUBLIC_PATH}/${filename}`, user.grade, user.class_number]
      );
      if (!rows.length) return res.status(403).json({ error: '첨부 이미지를 볼 권한이 없습니다.' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    // Images retain session and assignment authorization. The scoped resource
    // policy lets the configured split frontend embed them without opening API
    // responses or the rest of the application to cross-origin embedding.
    if (PAGES_AUTH_MODE === 'cookie' && FRONTEND_ORIGIN && FRONTEND_ORIGIN !== getRequestOrigin(req)) {
      res.setHeader('Cross-Origin-Resource-Policy', COOKIE_SAMESITE === 'none' ? 'cross-origin' : 'same-site');
    }
    res.sendFile(filename, { root: ASSIGNMENT_IMAGE_DIR, cacheControl: false }, (error) => {
      if (error) next(error);
    });
  } catch (error) { next(error); }
});
// Prevent an unmatched upload path from falling through to express.static.
app.use('/uploads', (_req, res) => res.status(404).end());

app.use(express.static(path.join(__dirname, 'src'), {
  etag: true,
  lastModified: true,
  maxAge: IS_PRODUCTION ? `${STATIC_ASSET_CACHE_SECONDS}s` : 0,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      res.setHeader('Cache-Control', 'no-store');
      return;
    }
    if (!IS_PRODUCTION) {
      res.setHeader('Cache-Control', 'no-cache');
      return;
    }
    if (['.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
      res.setHeader('Cache-Control', `public, max-age=${STATIC_ASSET_CACHE_SECONDS}, must-revalidate`);
    }
  }
}));

function parseCookies(req) {
  const cookies = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    try {
      cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // A malformed unrelated cookie must not crash an authenticated request.
    }
  }
  return cookies;
}

function getRequestToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.split(' ')[1];
  return parseCookies(req)[AUTH_COOKIE_NAME] || null;
}

function buildAuthCookie(token, maxAge = AUTH_TTL_MS) {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${COOKIE_SAMESITE === 'none' ? 'None' : 'Lax'}`,
    `Max-Age=${Math.floor(maxAge / 1000)}`
  ];
  if (IS_PRODUCTION) parts.push('Secure');
  return parts.join('; ');
}

function clearAuthCookie() {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${COOKIE_SAMESITE === 'none' ? 'None' : 'Lax'}`,
    'Max-Age=0'
  ];
  if (IS_PRODUCTION) parts.push('Secure');
  return parts.join('; ');
}

function createToken(user) {
  return jwt.sign(
    { type: 'session', id: user.id || user.user_id },
    JWT_SECRET,
    { expiresIn: '7d', algorithm: 'HS256', issuer: 'assignment-alarm', audience: 'session' }
  );
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', buildAuthCookie(token));
}

function prunePagesAccessSessions() {
  const now = Date.now();
  for (const [jti, session] of pagesAccessSessions) {
    if (session.expiresAt <= now) pagesAccessSessions.delete(jti);
  }
}

function reservePagesAccess(id = 0) {
  prunePagesAccessSessions();
  if (id) {
    const own = [...pagesAccessSessions].filter(([, session]) => session.userId === id);
    while (own.length >= PAGES_ACCESS_MAX_PER_USER) pagesAccessSessions.delete(own.shift()[0]);
  }
  if (pagesAccessSessions.size >= PAGES_ACCESS_MAX_SESSIONS) {
    throw Object.assign(new Error('pages-session-capacity'), { code: 'PAGES_SESSION_CAPACITY', status: 503 });
  }
  const jti = crypto.randomBytes(32).toString('hex');
  pagesAccessSessions.set(jti, { userId: id, expiresAt: Date.now() + 5 * 60 * 1000, reserved: true });
  return jti;
}
function issuePagesAccess(jti, id, familyId) {
  const own = [...pagesAccessSessions].filter(([key, session]) => key !== jti && session.userId === id);
  while (own.length >= PAGES_ACCESS_MAX_PER_USER) pagesAccessSessions.delete(own.shift()[0]);
  const exp = Math.floor(Date.now() / 1000) + PAGES_ACCESS_TTL_SECONDS;
  const accessToken = jwt.sign({ type: 'pages-access', id, jti, exp }, JWT_SECRET, {
    algorithm: 'HS256', issuer: 'assignment-alarm', audience: 'pages-access'
  });
  pagesAccessSessions.set(jti, { userId: id, expiresAt: exp * 1000, familyId });
  return { accessToken, expiresAt: new Date(exp * 1000).toISOString() };
}
async function createLoginSession(res, user, rememberMe = false) {
  if (PAGES_AUTH_MODE === 'cookie') { setAuthCookie(res, createToken(user)); return {}; }
  const id = user.id || user.user_id;
  const jti = reservePagesAccess(id);
  try {
    const remembered = rememberMe === true ? await refreshSessions.create(id) : null;
    return { ...issuePagesAccess(jti, id, remembered?.familyId), ...(remembered ? {
      refreshToken: remembered.refreshToken, refreshExpiresAt: remembered.refreshExpiresAt, authRealm: AUTH_REALM_ID
    } : {}) };
  } catch (error) { pagesAccessSessions.delete(jti); throw error; }
}

function verifyPagesAccessToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'assignment-alarm', audience: 'pages-access' });
  prunePagesAccessSessions();
  const session = typeof decoded.jti === 'string' ? pagesAccessSessions.get(decoded.jti) : null;
  if (decoded.type !== 'pages-access' || !Number.isSafeInteger(decoded.id) || decoded.id < 1 || !session || session.reserved || session.userId !== decoded.id) {
    throw new Error('invalid-pages-access');
  }
  return decoded;
}

function createGoogleSetupToken(profile, roster) {
  return jwt.sign(
    { type: 'google-setup', profile, roster },
    JWT_SECRET,
    { expiresIn: '10m', algorithm: 'HS256', issuer: 'assignment-alarm', audience: 'google-setup' }
  );
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeGoogleName(value) {
  let name = normalizeName(value);
  if (!name) name = 'Google 사용자';
  if (name.length > 30) name = name.slice(0, 30).trim();
  if (name.length < 2) name = 'Google 사용자';
  return name;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateText(value, limit) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(limit - 3, 1)).trim()}...`;
}

function parseInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^-?\d+$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePagination(query = {}) {
  const rawPage = parseInteger(query.page);
  const rawPageSize = parseInteger(query.pageSize);
  const page = rawPage && rawPage > 0 ? Math.min(rawPage, 1000000) : 1;
  const pageSize = rawPageSize && rawPageSize > 0
    ? Math.min(rawPageSize, ADMIN_PAGE_SIZE_MAX)
    : ADMIN_PAGE_SIZE_DEFAULT;
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize
  };
}

function getCachedResponse(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > RESPONSE_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedResponse(cache, key, value) {
  for (const [entryKey, entry] of cache) {
    if (Date.now() - entry.cachedAt > RESPONSE_CACHE_TTL_MS) cache.delete(entryKey);
  }
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(key, {
    value,
    cachedAt: Date.now()
  });
  return value;
}

function clearResponseCaches({ users = false, assignments = false, messages = false, notifications = false } = {}) {
  if (users) {
    adminUserCache.clear();
  }
  if (assignments) {
    adminAssignmentCache.clear();
  }
  if (messages) {
    adminMessageCache.clear();
  }
  if (notifications) {
    notificationCache.clear();
  }
}

function logApiError(label, error, metadata = null) {
  // Provider/SQL error objects can include credentials, tokens, or submitted content.
  console.error(`[API] ${label}`, { code: String(error?.code || error?.name || 'Error'), ...(metadata || {}) });
}

function getAdminAssignmentCacheKey({ page, pageSize, grade, classNumber }) {
  return JSON.stringify({
    page,
    pageSize,
    grade: grade ?? 'all',
    classNumber: classNumber ?? 'all'
  });
}

function getAdminMessageCacheKey({ page, pageSize, type, grade, classNumber }) {
  return JSON.stringify({
    page,
    pageSize,
    type: type ?? 'all',
    grade: grade ?? 'all',
    classNumber: classNumber ?? 'all'
  });
}

function getNotificationCacheKey(user) {
  return JSON.stringify({
    userId: user.user_id,
    isAdmin: isAdminUser(user),
    grade: user.grade ?? null,
    classNumber: user.class_number ?? null
  });
}

function toSqlLimit(value, fallback) {
  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isInteger(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
}

// AI 챗봇 보관: 현재 실행하지 않습니다. 재활성화 전 인증/비용/개인정보를 다시 검토하세요.
// function wait(ms) {
//   return new Promise((resolve) => setTimeout(resolve, ms));
// }
//
// function getChatbotResponseCacheKey(userId, rawMessage, history) {
//   return JSON.stringify({
//     userId,
//     rawMessage: String(rawMessage || '').trim(),
//     history: Array.isArray(history)
//       ? history.map((item) => ({
//         role: item?.role,
//         content: String(item?.content || '').trim()
//       }))
//       : []
//   });
// }
//
// function getCachedChatbotResponse(cacheKey) {
//   const entry = chatbotResponseCache.get(cacheKey);
//   if (!entry) return null;
//   if (Date.now() - entry.cachedAt > CHATBOT_RESPONSE_CACHE_TTL_MS) {
//     chatbotResponseCache.delete(cacheKey);
//     return null;
//   }
//   return entry.reply;
// }
//
// function setCachedChatbotResponse(cacheKey, reply) {
//   chatbotResponseCache.set(cacheKey, {
//     reply,
//     cachedAt: Date.now()
//   });
// }
//
// function isChatbotTransientError(error) {
//   const status = Number(error?.status || error?.code || 0);
//   const code = String(error?.code || '').toUpperCase();
//   const message = String(error?.message || '').toLowerCase();
//
//   if ([408, 409, 425, 429].includes(status) || status >= 500) {
//     return true;
//   }
//
//   return [
//     'ETIMEDOUT',
//     'ECONNRESET',
//     'ECONNREFUSED',
//     'ECONNABORTED',
//     'EAI_AGAIN',
//     'ENOTFOUND'
//   ].includes(code) || message.includes('timeout') || message.includes('timed out');
// }
//
// async function requestChatbotCompletion(messages) {
//   let lastError = null;
//
//   for (let attempt = 0; attempt <= CHATBOT_RETRY_COUNT; attempt += 1) {
//     try {
//       return await gemini.chat.completions.create({
//         model: GEMINI_CHAT_MODEL,
//         messages
//       });
//     } catch (error) {
//       lastError = error;
//       if (!isChatbotTransientError(error) || attempt >= CHATBOT_RETRY_COUNT) {
//         throw error;
//       }
//       await wait(CHATBOT_RETRY_DELAY_MS * (attempt + 1));
//     }
//   }
//
//   throw lastError || new Error('chatbot-request-failed');
// }
//
function normalizeBooleanFlag(value) {
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

function isAdminEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (ADMIN_EXCLUDED_GOOGLE_EMAILS.includes(normalized)) return false;
  return ADMIN_GOOGLE_EMAILS.includes(normalized)
    || (ALLOW_TEACHER_NUMBER_ADMINS && /^teacher[0-9]+@bssm\.hs\.kr$/.test(normalized));
}

function isAdminUser(user) {
  return normalizeBooleanFlag(user?.is_admin) === 1
    && (!canSwitchAdminMode(user) || normalizeBooleanFlag(user.admin_mode_enabled ?? 1) === 1);
}

function canSwitchAdminMode(user) {
  // Only a stored, verified Google identity with underlying admin eligibility
  // may restore its own privileges. A mode flag alone never grants a role.
  return Boolean(ADMIN_MODE_OWNER_EMAIL && user?.google_sub)
    && normalizeBooleanFlag(user?.is_admin) === 1
    && String(user?.google_email || '').trim().toLowerCase() === ADMIN_MODE_OWNER_EMAIL;
}

function canCompleteAssignments(user) {
  const email = String(user?.google_email || '').trim().toLowerCase();
  if (/^teacher[0-9]+@bssm\.hs\.kr$/.test(email)) return false;
  if (!isAdminUser(user)) return true;
  // Administrative access alone is not evidence that the person is a student.
  return Boolean(user?.google_sub) && /^[0-9]{2}_[0-9]+@bssm\.hs\.kr$/.test(email);
}

function withClassApproval(user) {
  const { google_sub, ...publicUser } = user || {};
  // Compatibility for older clients. Class approval no longer gates access;
  // keep the stored legacy column untouched rather than deleting user data.
  return { ...publicUser, is_admin: isAdminUser(user) ? 1 : 0,
    can_switch_admin_mode: canSwitchAdminMode(user), admin_mode_enabled: isAdminUser(user),
    is_class_approved: true, can_complete_assignments: canCompleteAssignments(user) };
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function decodeAssignmentImageDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/]+={0,2})$/i.exec(String(dataUrl || ''));
  if (!match || match[2].length % 4 !== 0) throw new Error('assignment-image-invalid');
  const mimeType = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.toString('base64') !== match[2]) throw new Error('assignment-image-invalid');
  if (buffer.length > MAX_ASSIGNMENT_IMAGE_BYTES) throw new Error('assignment-image-too-large');
  const isValidSignature = (
    (mimeType === 'image/png' && buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') ||
    (mimeType === 'image/jpeg' && buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 && buffer[buffer.length - 2] === 255 && buffer[buffer.length - 1] === 217) ||
    (mimeType === 'image/gif' && buffer.length >= 13 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) ||
    (mimeType === 'image/webp' && buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length)
  );
  if (!isValidSignature) throw new Error('assignment-image-invalid');
  validateImageDimensions(buffer, mimeType);
  return { buffer, extension: ASSIGNMENT_IMAGE_EXTENSIONS.get(mimeType) };
}

// Serialize writes so parallel uploads cannot bypass the local storage cap.
async function storeAssignmentImage(filename, buffer) {
  const operation = pendingImageWrite.catch(() => {}).then(async () => {
    await fs.mkdir(ASSIGNMENT_IMAGE_DIR, { recursive: true });
    const entries = await fs.readdir(ASSIGNMENT_IMAGE_DIR, { withFileTypes: true });
    let usedBytes = 0;
    for (const entry of entries) {
      if (entry.isFile()) usedBytes += (await fs.stat(path.join(ASSIGNMENT_IMAGE_DIR, entry.name))).size;
    }
    if (usedBytes + buffer.length > ASSIGNMENT_IMAGE_MAX_STORAGE_BYTES) throw new Error('assignment-image-storage-full');
    await fs.writeFile(path.join(ASSIGNMENT_IMAGE_DIR, filename), buffer, { flag: 'wx' });
  });
  pendingImageWrite = operation;
  await operation;
}

// A visible assignment must never become a way to claim a private attachment URL.
async function validateAssignmentImageReferences(content, user) {
  if (!content || isAdminUser(user)) return true;
  const references = new Set(Array.from(String(content).matchAll(
    /\/uploads\/assignment-images\/(\d+(?:-\d+)?-[a-f0-9]{16,32}\.(?:png|jpg|webp|gif))/gi
  ), (match) => match[0]));
  for (const imageUrl of references) {
    const filename = imageUrl.slice(imageUrl.lastIndexOf('/') + 1);
    if (filename.startsWith(`${user.user_id}-`) && /^\d+-\d+-/.test(filename)) continue;
    const [rows] = await pool.execute(
      'SELECT assignment_id FROM assignments WHERE INSTR(BINARY content, BINARY ?) > 0 AND target_grade = ? AND (target_class = ? OR target_class IS NULL) LIMIT 1',
      [imageUrl, user.grade, user.class_number]
    );
    if (!rows.length) return false;
  }
  return true;
}

async function withTransaction(operation) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function getAssignmentContentErrorMessage() {
  return `과제 내용은 ${MAX_ASSIGNMENT_CONTENT_LENGTH}자 이하로 입력해주세요.`;
}

// AI 챗봇 보관: 현재 실행하지 않습니다. 재활성화 전 인증/비용/개인정보를 다시 검토하세요.
// function truncateText(value, maxLength = CHATBOT_MAX_MESSAGE_LENGTH) {
//   const normalized = String(value || '').trim().replace(/\s+/g, ' ');
//   if (!normalized) return '';
//   if (normalized.length <= maxLength) return normalized;
//   return normalized.slice(0, maxLength);
// }
//
// function normalizeChatHistory(rawHistory) {
//   if (!Array.isArray(rawHistory)) return [];
//   return rawHistory
//     .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
//     .map((item) => ({
//       role: item.role,
//       content: truncateText(item.content)
//     }))
//     .filter((item) => item.content)
//     .slice(-CHATBOT_MAX_HISTORY_ITEMS);
// }
//
// function summarizeChatbotContextText(value, maxLength) {
//   const normalized = String(value || '').trim().replace(/\s+/g, ' ');
//   if (!normalized) return '';
//   if (normalized.length <= maxLength) return normalized;
//   return `${normalized.slice(0, maxLength - 1).trim()}...`;
// }
//
// async function buildChatbotContext(user) {
//   const [rows] = await pool.execute(
//     `SELECT a.assignment_id, a.title, a.content, a.due_date, COALESCE(ua.is_completed, 0) AS is_completed
//        FROM assignments a
//        LEFT JOIN user_assignments ua
//          ON ua.assignment_id = a.assignment_id
//         AND ua.user_id = ?
//       WHERE a.target_grade = ?
//         AND (a.target_class = ? OR a.target_class IS NULL)
//       ORDER BY a.due_date ASC, a.created_at DESC
//       LIMIT ${CHATBOT_CONTEXT_ASSIGNMENT_LIMIT}`,
//     [user.user_id, user.grade, user.class_number]
//   );
//
//   const assignmentLines = rows.map((assignment) => {
//     const title = summarizeChatbotContextText(assignment.title, CHATBOT_CONTEXT_TITLE_LENGTH) || '제목 없음';
//     const contentSummary = summarizeChatbotContextText(assignment.content, CHATBOT_CONTEXT_CONTENT_LENGTH);
//     const statusLabel = normalizeBooleanFlag(assignment.is_completed) ? '완료' : '미완료';
//     const parts = [
//       `- ${title}`,
//       `마감 ${assignment.due_date || '미정'}`,
//       statusLabel
//     ];
//
//     if (contentSummary) {
//       parts.push(`내용 요약: ${contentSummary}`);
//     }
//
//     return parts.join(' / ');
//   });
//
//   return [
//     '[사용자 기본 정보]',
//     `- 소속: ${user.grade}학년 ${user.class_number}반`,
//     '',
//     '[현재 과제 요약]',
//     assignmentLines.length > 0 ? assignmentLines.join('\n') : '- 현재 확인된 과제가 없습니다.'
//   ].join('\n');
// }
//
async function verifyGoogleCredential(credential) {
  if (!googleClient || !GOOGLE_CLIENT_ID) {
    throw new Error('google-not-configured');
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new Error('google-invalid-token');
  }
  const email = String(payload.email || '').trim().toLowerCase();
  if (payload.email_verified !== true || payload.hd !== GOOGLE_ALLOWED_DOMAIN || !email.endsWith(`@${GOOGLE_ALLOWED_DOMAIN}`)) {
    throw new Error('google-domain-not-allowed');
  }

  return {
    google_sub: payload.sub,
    google_email: email,
    name: normalizeGoogleName(payload.name || payload.email || 'Google 사용자'),
    roster_name: normalizeRosterName(payload.name),
    profile_image_url: payload.picture || null
  };
}

async function findUserByGoogleSub(googleSub, connection = pool) {
  const [rows] = await connection.execute(
    'SELECT user_id, name, grade, class_number, class_approved, profile_image_url, is_alarm_enabled, is_admin, admin_mode_enabled, google_sub, google_email FROM users WHERE google_sub = ? LIMIT 1',
    [googleSub]
  );
  return rows[0] || null;
}

function cleanupExpiredAttempts(store, now = Date.now()) {
  for (const [key, value] of store.entries()) {
    if (!value || value.expiresAt <= now) {
      store.delete(key);
    }
  }
}

function consumeRateLimitAttempt(store, key, { windowMs, limit, maxTrackedClients }, now = Date.now()) {
  cleanupExpiredAttempts(store, now);
  const entry = store.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (store.size >= maxTrackedClients) {
      const oldestKey = store.keys().next().value;
      if (oldestKey !== undefined) {
        store.delete(oldestKey);
      }
    }
    store.set(key, { count: 1, expiresAt: now + windowMs });
    return { allowed: true };
  }
  if (entry.count >= limit) {
    return { allowed: false, retryAfterMs: Math.max(entry.expiresAt - now, 1000) };
  }
  entry.count += 1;
  return { allowed: true };
}

function authRateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const result = consumeRateLimitAttempt(
    authAttempts,
    key,
    {
      windowMs: AUTH_RATE_WINDOW_MS,
      limit: AUTH_RATE_LIMIT,
      maxTrackedClients: AUTH_RATE_MAX_TRACKED_CLIENTS
    },
    now
  );
  if (!result.allowed) {
    return res.status(429).json({ error: '잠시 후 다시 시도해주세요.' });
  }
  next();
}

function clearAuthRateLimit(req) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  authAttempts.delete(key);
}

// AI 챗봇 보관: 현재 실행하지 않습니다. 재활성화 전 인증/비용/개인정보를 다시 검토하세요.
// function chatbotRateLimit(req, res, next) {
//   const key = req.user?.id ? `user:${req.user.id}` : (req.ip || req.socket.remoteAddress || 'unknown');
//   const result = consumeRateLimitAttempt(
//     chatbotAttempts,
//     key,
//     {
//       windowMs: CHATBOT_RATE_WINDOW_MS,
//       limit: CHATBOT_RATE_LIMIT,
//       maxTrackedClients: AUTH_RATE_MAX_TRACKED_CLIENTS
//     }
//   );
//
//   if (!result.allowed) {
//     res.setHeader('Retry-After', String(Math.ceil((result.retryAfterMs || CHATBOT_RATE_WINDOW_MS) / 1000)));
//     return res.status(429).json({ error: '챗봇 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
//   }
//
//   next();
// }
//
function assignmentImageRateLimit(req, res, next) {
  const key = req.user?.id ? `user:${req.user.id}` : (req.ip || req.socket.remoteAddress || 'unknown');
  const result = consumeRateLimitAttempt(
    assignmentImageAttempts,
    key,
    {
      windowMs: ASSIGNMENT_IMAGE_RATE_WINDOW_MS,
      limit: ASSIGNMENT_IMAGE_RATE_LIMIT,
      maxTrackedClients: AUTH_RATE_MAX_TRACKED_CLIENTS
    }
  );

  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((result.retryAfterMs || ASSIGNMENT_IMAGE_RATE_WINDOW_MS) / 1000)));
    return res.status(429).json({ error: '이미지 업로드 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
  }

  next();
}

function assignmentWriteRateLimit(req, res, next) {
  const key = req.user?.id ? `user:${req.user.id}` : (req.ip || req.socket.remoteAddress || 'unknown');
  const result = consumeRateLimitAttempt(
    assignmentWriteAttempts,
    key,
    {
      windowMs: ASSIGNMENT_WRITE_RATE_WINDOW_MS,
      limit: ASSIGNMENT_WRITE_RATE_LIMIT,
      maxTrackedClients: AUTH_RATE_MAX_TRACKED_CLIENTS
    }
  );

  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((result.retryAfterMs || ASSIGNMENT_WRITE_RATE_WINDOW_MS) / 1000)));
    return res.status(429).json({ error: '과제 변경 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
  }

  next();
}

async function authMiddleware(req, res, next) {
  const token = getRequestToken(req);
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });
  let decoded;
  try {
    if (PAGES_AUTH_MODE === 'bearer') {
      if (!String(req.get('Authorization') || '').startsWith('Bearer ')) throw new Error('missing-pages-access');
      decoded = verifyPagesAccessToken(token);
    } else {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'assignment-alarm', audience: 'session' });
      if (decoded?.type !== 'session' || !Number.isSafeInteger(decoded.id) || decoded.id < 1) throw new Error('invalid-session');
    }
  } catch {
    res.setHeader('Set-Cookie', clearAuthCookie());
    return res.status(401).json({ error: '로그인이 만료되었습니다. 다시 로그인해주세요.' });
  }
  try {
    const familyId = PAGES_AUTH_MODE === 'bearer' ? pagesAccessSessions.get(decoded.jti)?.familyId : null;
    if (familyId) {
      // A rotation can finish while another request logs out. Recheck durable
      // revocation before authorizing even a just-issued access token.
      const [families] = await pool.execute('SELECT family_id FROM auth_refresh_families WHERE family_id = ? AND user_id = ? AND auth_realm_id = ? AND revoked = 0 AND expires_at_ms > ?', [familyId, decoded.id, AUTH_REALM_ID, Date.now()]);
      if (!families.length) { pagesAccessSessions.delete(decoded.jti); return res.status(401).json({ error: '로그인이 해제되었습니다.' }); }
    }
    req.currentUser = await getCurrentUser(decoded.id);
    if (!req.currentUser) {
      res.setHeader('Set-Cookie', clearAuthCookie());
      return res.status(401).json({ error: '로그인이 만료되었습니다. 다시 로그인해주세요.' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    logApiError('Session lookup failed', error);
    res.status(503).json({ error: '서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.' });
  }
}

async function getCurrentUser(userId) {
  const [rows] = await pool.execute('SELECT user_id, name, grade, class_number, class_approved, google_sub, google_email, profile_image_url, is_alarm_enabled, is_admin, admin_mode_enabled FROM users WHERE user_id = ?', [userId]);
  if (!rows[0]) return null;
  return { ...rows[0], is_class_approved: true, can_complete_assignments: canCompleteAssignments(rows[0]) };
}

async function getAdminCalendarAssignments(user) {
  // Admins may view every class. Only their own class can contribute their
  // personal completion state; another student's rows are never joined.
  const [rows] = await pool.execute(
    `SELECT a.*, COALESCE(u.name, '삭제된 사용자') AS creator_name, COALESCE(ua.is_completed, 0) AS is_completed
     FROM assignments a
     LEFT JOIN users u ON a.created_by = u.user_id
     LEFT JOIN user_assignments ua ON ua.assignment_id = a.assignment_id AND ua.user_id = ?
       AND a.target_grade = ? AND (a.target_class = ? OR a.target_class IS NULL)
     ORDER BY a.due_date ASC, a.target_grade ASC, a.target_class ASC, a.created_at DESC`,
    [user.user_id, user.grade, user.class_number]
  );
  return rows;
}

async function ensureAdminAccess(req, res) {
  const currentUser = await getCurrentUser(req.user.id);
  if (!currentUser) {
    res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    return null;
  }
  if (!isAdminUser(currentUser)) {
    res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    return null;
  }
  return currentUser;
}

async function verifyTurnstileToken(token, remoteIp) {
  if (!TURNSTILE_ENABLED) return { success: true };
  if (!token) return { success: false, error: 'missing-input-response' };

  const params = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
    response: String(token)
  });

  if (remoteIp) {
    params.set('remoteip', remoteIp);
  }

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params,
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Turnstile verification failed with status ${response.status}`);
  }

  return response.json();
}

async function ensureIndex(conn, tableName, indexName, definitionSql) {
  const [rows] = await conn.execute(
    `SELECT INDEX_NAME
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?
     LIMIT 1`,
    [tableName, indexName]
  );

  if (rows.length === 0) {
    await conn.execute(`ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` ${definitionSql}`);
  }
}

async function migrateSchema(conn) {
  for (const statement of rosterSchema) await conn.execute(statement);
  // 기존 email 값은 복구에 필요하므로 보존하고 새 Google 가입은 NULL을 허용합니다.
  const [legacyEmailColumns] = await conn.execute(
    `SELECT COLUMN_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'`
  );
  const legacyEmail = legacyEmailColumns[0];
  if (legacyEmail?.IS_NULLABLE === 'NO') {
    if (!/^(?:(?:var)?char\(\d+\)|(?:tiny|medium|long)?text)$/i.test(legacyEmail.COLUMN_TYPE)) throw new Error('unsupported-legacy-email-column');
    await conn.execute(`ALTER TABLE users MODIFY COLUMN email ${legacyEmail.COLUMN_TYPE} NULL DEFAULT NULL`);
  }
  const [googleSubColumns] = await conn.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'google_sub'`
  );

  if (googleSubColumns.length === 0) {
    await conn.execute('ALTER TABLE users ADD COLUMN google_sub VARCHAR(255) DEFAULT NULL AFTER name');
  }

  const [googleEmailColumns] = await conn.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'google_email'`
  );

  if (googleEmailColumns.length === 0) {
    await conn.execute('ALTER TABLE users ADD COLUMN google_email VARCHAR(255) DEFAULT NULL AFTER google_sub');
  }

  const [nameUniqueIndexes] = await conn.execute(
    `SELECT INDEX_NAME
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'name'
       AND NON_UNIQUE = 0
       AND INDEX_NAME <> 'PRIMARY'`
  );

  // 동명이인은 정상입니다. 표시 이름을 계정 식별자나 연결 근거로 사용하지 않습니다.
  for (const index of nameUniqueIndexes) {
    await conn.execute(`ALTER TABLE users DROP INDEX \`${index.INDEX_NAME.replace(/`/g, '``')}\``);
  }

  const [googleSubUniqueIndexes] = await conn.execute(
    `SELECT INDEX_NAME
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'google_sub'
       AND NON_UNIQUE = 0
       AND INDEX_NAME <> 'PRIMARY'`
  );

  if (googleSubUniqueIndexes.length === 0) {
    await conn.execute('ALTER TABLE users ADD UNIQUE INDEX users_google_sub_unique (google_sub)');
  }

  const [adminColumns] = await conn.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'is_admin'`
  );

  if (adminColumns.length === 0) {
    await conn.execute('ALTER TABLE users ADD COLUMN is_admin TINYINT(1) DEFAULT 0 AFTER is_alarm_enabled');
  }

  const [adminModeColumns] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'admin_mode_enabled'`
  );
  if (adminModeColumns.length === 0) {
    await conn.execute('ALTER TABLE users ADD COLUMN admin_mode_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER is_admin');
  }

  const [classApprovalColumns] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'class_approved'`
  );
  if (classApprovalColumns.length === 0) {
    // Preserve the legacy column for schema compatibility. It is no longer
    // consulted for authentication, class access, or profile changes.
    await conn.execute('ALTER TABLE users ADD COLUMN class_approved TINYINT(1) NOT NULL DEFAULT 0 AFTER class_number');
  }

  const [userCreatedAtColumns] = await conn.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'created_at'`
  );

  if (userCreatedAtColumns.length === 0) {
    await conn.execute('ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER is_admin');
  }

  // 기존 attachment_url 컬럼도 과거 첨부 데이터 보존을 위해 남겨둡니다.

  await ensureIndex(conn, 'users', 'users_grade_class_idx', '(grade, class_number)');
  await ensureIndex(conn, 'assignments', 'assignments_scope_due_created_idx', '(target_grade, target_class, due_date, created_at)');
  await ensureIndex(conn, 'assignments', 'assignments_created_at_idx', '(created_at)');
  await ensureIndex(conn, 'messages', 'messages_scope_type_created_idx', '(target_grade, type, target_class, created_at)');
  await ensureIndex(conn, 'messages', 'messages_created_at_idx', '(created_at)');
  await ensureIndex(conn, 'user_assignments', 'user_assignments_assignment_user_idx', '(assignment_id, user_id, is_completed)');
}

async function cleanupOrphanedRecords(conn) {
  const [[orphanUserAssignmentsByUser]] = await conn.execute(
    `SELECT COUNT(*) AS total
       FROM user_assignments ua
       LEFT JOIN users u ON ua.user_id = u.user_id
      WHERE u.user_id IS NULL`
  );
  if (Number(orphanUserAssignmentsByUser.total) > 0) {
    await conn.execute(
      `DELETE ua
         FROM user_assignments ua
         LEFT JOIN users u ON ua.user_id = u.user_id
        WHERE u.user_id IS NULL`
    );
  }

  const [[orphanUserAssignmentsByAssignment]] = await conn.execute(
    `SELECT COUNT(*) AS total
       FROM user_assignments ua
       LEFT JOIN assignments a ON ua.assignment_id = a.assignment_id
      WHERE a.assignment_id IS NULL`
  );
  if (Number(orphanUserAssignmentsByAssignment.total) > 0) {
    await conn.execute(
      `DELETE ua
         FROM user_assignments ua
         LEFT JOIN assignments a ON ua.assignment_id = a.assignment_id
        WHERE a.assignment_id IS NULL`
    );
  }

  const [[orphanAssignments]] = await conn.execute(
    `SELECT COUNT(*) AS total
       FROM assignments a
       LEFT JOIN users u ON a.created_by = u.user_id
      WHERE u.user_id IS NULL`
  );
  if (Number(orphanAssignments.total) > 0) {
    await conn.execute(
      `DELETE a
         FROM assignments a
         LEFT JOIN users u ON a.created_by = u.user_id
        WHERE u.user_id IS NULL`
    );
  }

  const [[orphanMessages]] = await conn.execute(
    `SELECT COUNT(*) AS total
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.user_id
      WHERE u.user_id IS NULL`
  );
  if (Number(orphanMessages.total) > 0) {
    await conn.execute(
      `DELETE m
         FROM messages m
         LEFT JOIN users u ON m.sender_id = u.user_id
        WHERE u.user_id IS NULL`
    );
  }

  const summary = [
    Number(orphanUserAssignmentsByUser.total) || 0,
    Number(orphanUserAssignmentsByAssignment.total) || 0,
    Number(orphanAssignments.total) || 0,
    Number(orphanMessages.total) || 0
  ];
  if (summary.some((count) => count > 0)) {
    console.log(`Cleaned orphaned records: user_assignments(user)=${summary[0]}, user_assignments(assignment)=${summary[1]}, assignments=${summary[2]}, messages=${summary[3]}`);
  }
}

async function seedAdminAccount(conn) {
  if (ADMIN_EXCLUDED_GOOGLE_EMAILS.length > 0) {
    const excludedPlaceholders = ADMIN_EXCLUDED_GOOGLE_EMAILS.map(() => '?').join(', ');
    await conn.execute(
      `UPDATE users SET is_admin = 0 WHERE google_email IN (${excludedPlaceholders})`,
      ADMIN_EXCLUDED_GOOGLE_EMAILS
    );
  }

  // Only previously verified Google identities participate in this policy.
  // Explicit exclusions take precedence over both the list and the optional rule.
  const [googleRows] = await conn.execute('SELECT user_id, google_email FROM users WHERE google_sub IS NOT NULL');
  for (const row of googleRows) {
    await conn.execute('UPDATE users SET is_admin = ? WHERE user_id = ?', [isAdminEmail(row.google_email) ? 1 : 0, row.user_id]);
  }

  if (!ADMIN_NAME || !ADMIN_PASSWORD) return;
  if (ADMIN_PASSWORD.length < 8) {
    console.warn('Skipping admin bootstrap: ADMIN_PASSWORD must be at least 8 characters.');
    return;
  }

  const adminGrade = Number.isInteger(ADMIN_GRADE) && ADMIN_GRADE >= 1 && ADMIN_GRADE <= MAX_GRADE ? ADMIN_GRADE : 1;
  const adminClass = Number.isInteger(ADMIN_CLASS) && ADMIN_CLASS >= 1 && ADMIN_CLASS <= MAX_CLASS ? ADMIN_CLASS : 1;
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const [rows] = await conn.execute('SELECT user_id FROM users WHERE name = ? AND google_sub IS NULL AND is_admin = 1 LIMIT 1', [ADMIN_NAME]);

  if (rows.length === 0) {
    await conn.execute(
      'INSERT INTO users (password, name, grade, class_number, is_admin) VALUES (?, ?, ?, ?, 1)',
      [passwordHash, ADMIN_NAME, adminGrade, adminClass]
    );
    console.log(`Admin account created: ${ADMIN_NAME}`);
    return;
  }

  await conn.execute(
    'UPDATE users SET password = ?, grade = ?, class_number = ?, is_admin = 1 WHERE user_id = ?',
    [passwordHash, adminGrade, adminClass, rows[0].user_id]
  );
  console.log(`Admin account synced: ${ADMIN_NAME}`);
}

// Auth
app.get('/api/health', async (_req, res) => {
  try {
    await pool.execute('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.get('/api/public-config', (_req, res) => {
  res.json({
    turnstileSiteKey: TURNSTILE_ENABLED ? TURNSTILE_SITE_KEY : null,
    googleClientId: GOOGLE_CLIENT_ID || null,
    chatbotEnabled: false,
    imagesEnabled: ASSIGNMENT_IMAGES_ENABLED,
    authMode: PAGES_AUTH_MODE,
    authRealm: AUTH_REALM_ID || null
  });
});

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  return res.status(403).json({ error: '구글 로그인으로만 가입할 수 있습니다.' });
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  return res.status(403).json({ error: '구글 로그인만 사용할 수 있습니다.' });
});

app.post('/api/auth/google', authRateLimit, async (req, res) => {
  try {
    const credential = String(req.body.credential || '').trim();
    if (!credential) return res.status(400).json({ error: '구글 인증 정보가 없습니다.' });
    if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: '구글 로그인이 아직 설정되지 않았습니다.' });

    const profile = await verifyGoogleCredential(credential);
    const existingUser = await findUserByGoogleSub(profile.google_sub);

    if (existingUser) {
      const shouldGrantAdmin = isAdminEmail(profile.google_email);
      await pool.execute('UPDATE users SET is_admin = ? WHERE user_id = ?', [shouldGrantAdmin ? 1 : 0, existingUser.user_id]);

      await pool.execute(
        'UPDATE users SET google_email = ?, profile_image_url = COALESCE(?, profile_image_url) WHERE user_id = ?',
        [profile.google_email, profile.profile_image_url, existingUser.user_id]
      );

      const user = {
        id: existingUser.user_id,
        name: existingUser.name,
        grade: existingUser.grade,
        class_number: existingUser.class_number,
        is_admin: shouldGrantAdmin ? 1 : 0
      };
      const session = await createLoginSession(res, user, req.body.rememberMe);
      clearAuthRateLimit(req);
      return res.json({
        ...session,
        user: withClassApproval({
          ...existingUser,
          id: existingUser.user_id,
          name: existingUser.name,
          grade: existingUser.grade,
          class_number: existingUser.class_number,
          is_class_approved: true,
          can_complete_assignments: canCompleteAssignments({ ...existingUser, is_admin: shouldGrantAdmin ? 1 : 0, google_sub: profile.google_sub, google_email: profile.google_email }),
          profile_image_url: profile.profile_image_url || existingUser.profile_image_url,
          is_alarm_enabled: existingUser.is_alarm_enabled,
          is_admin: shouldGrantAdmin ? 1 : 0,
          google_sub: profile.google_sub,
          google_email: profile.google_email
        })
      });
    }


    const rosterScope = studentRosterScope(profile, { isAdmin: isAdminEmail(profile.google_email) });
    let rosterRows;
    try { rosterRows = await lookupRoster(pool, profile, rosterScope); }
    catch { throw rosterError('ROSTER_UNAVAILABLE', 503); }
    const rosterRequired = rosterRows.length > 0;
    return res.json({
      requiresProfile: true,
      setupToken: createGoogleSetupToken(profile, { academic_year: rosterScope?.academic_year ?? null, grade: rosterScope?.grade ?? null, required: rosterRequired }),
      rosterCandidates: publicRosterCandidates(rosterRows),
      rosterRequired,
      rosterAmbiguous: rosterRows.length > 1,
      profile: {
        name: profile.name,
        email: profile.google_email,
        profile_image_url: profile.profile_image_url
      }
    });
  } catch (error) {
    if (error?.code === 'ROSTER_UNAVAILABLE') return res.status(503).json({ code: error.code, error: '가입 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.' });
    if (error?.code === 'PAGES_SESSION_CAPACITY') {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: '현재 로그인 사용자가 많습니다. 잠시 후 다시 시도해주세요.' });
    }
    const message = error?.message === 'google-not-configured'
      ? '구글 로그인이 아직 설정되지 않았습니다.'
      : error?.message === 'google-domain-not-allowed'
        ? 'bssm.hs.kr 학교 계정으로만 로그인할 수 있습니다.'
      : '구글 로그인 확인에 실패했습니다.';
    return res.status(401).json({ error: message });
  }
});

app.post('/api/auth/google/register', authRateLimit, async (req, res) => {
  try {
    const setupToken = String(req.body.setupToken || '').trim();
    if (!setupToken) return res.status(400).json({ error: '구글 가입 정보가 없습니다.' });

    let decoded;
    try {
      decoded = jwt.verify(setupToken, JWT_SECRET, { algorithms: ['HS256'], issuer: 'assignment-alarm', audience: 'google-setup' });
    } catch {
      return res.status(401).json({ error: '구글 가입 정보가 만료되었습니다. 다시 로그인해주세요.' });
    }

    if (decoded?.type !== 'google-setup' || !decoded?.profile?.google_sub) {
      return res.status(401).json({ error: '구글 가입 정보가 올바르지 않습니다.' });
    }

    const existingUser = await findUserByGoogleSub(decoded.profile.google_sub);
    if (existingUser) {
      const shouldGrantAdmin = isAdminEmail(decoded.profile.google_email);
      await pool.execute('UPDATE users SET is_admin = ? WHERE user_id = ?', [shouldGrantAdmin ? 1 : 0, existingUser.user_id]);
      const user = {
        id: existingUser.user_id,
        name: existingUser.name,
        grade: existingUser.grade,
        class_number: existingUser.class_number,
        is_admin: shouldGrantAdmin ? 1 : 0
      };
      const session = await createLoginSession(res, user, req.body.rememberMe);
      clearAuthRateLimit(req);
      return res.json({
        ...session,
        user: withClassApproval({
          ...existingUser,
          id: existingUser.user_id,
          name: existingUser.name,
          grade: existingUser.grade,
          class_number: existingUser.class_number,
          is_class_approved: true,
          can_complete_assignments: canCompleteAssignments({ ...existingUser, is_admin: shouldGrantAdmin ? 1 : 0, google_sub: decoded.profile.google_sub, google_email: decoded.profile.google_email }),
          profile_image_url: existingUser.profile_image_url,
          is_alarm_enabled: existingUser.is_alarm_enabled,
          is_admin: shouldGrantAdmin ? 1 : 0,
          google_sub: decoded.profile.google_sub,
          google_email: decoded.profile.google_email
        })
      });
    }


    const uniqueName = normalizeGoogleName(decoded.profile.name);
    const isAdmin = isAdminEmail(decoded.profile.google_email) ? 1 : 0;
    const passwordHash = await bcrypt.hash(`google:${decoded.profile.google_sub}:${crypto.randomBytes(8).toString('hex')}`, 10);
    const scope = studentRosterScope(decoded.profile, { isAdmin: Boolean(isAdmin) });
    if (decoded.roster?.academic_year !== null && decoded.roster?.academic_year !== undefined
        && (decoded.roster.academic_year !== scope?.academic_year || decoded.roster.grade !== scope?.grade)) throw rosterError('ROSTER_CHANGED', 409);
    const registration = await withTransaction(async connection => {
      const rows = await lookupRoster(connection, decoded.profile, scope, { lock: true });
      const linked = await findUserByGoogleSub(decoded.profile.google_sub, connection);
      if (linked) return { linked };
      const rosterId = req.body.roster_id;
      const hasRosterId = rosterId !== undefined && rosterId !== null && rosterId !== '';
      if ((decoded.roster?.required === true || rows.length > 0) && !hasRosterId) throw rosterError('ROSTER_SELECTION_REQUIRED');
      let grade = parseInteger(req.body.grade), class_number = parseInteger(req.body.class_number), selected;
      if (hasRosterId) {
        if (typeof rosterId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(rosterId)) throw rosterError('ROSTER_SELECTION_INVALID');
        selected = rows.find(row => row.roster_id === rosterId);
        if (!selected) throw rosterError('ROSTER_SELECTION_INVALID');
        if (selected.claimed_user_id !== null && selected.claimed_user_id !== undefined) throw rosterError('ROSTER_ALREADY_CLAIMED', 409);
        if ((req.body.grade !== undefined && grade !== Number(selected.grade))
            || (req.body.class_number !== undefined && class_number !== Number(selected.class_number))) throw rosterError('ROSTER_SELECTION_INVALID');
        grade = Number(selected.grade); class_number = Number(selected.class_number);
      }
      if (!grade || grade < 1 || grade > MAX_GRADE || !class_number || class_number < 1 || class_number > MAX_CLASS) throw rosterError('PROFILE_CLASS_INVALID');
      const [result] = await connection.execute(
        'INSERT INTO users (password, name, google_sub, google_email, grade, class_number, profile_image_url, is_admin, class_approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        [passwordHash, uniqueName, decoded.profile.google_sub, decoded.profile.google_email, grade, class_number, decoded.profile.profile_image_url, isAdmin]
      );
      if (selected) {
        const [claim] = await connection.execute('UPDATE student_roster_entries SET claimed_user_id = ? WHERE roster_id = ? AND claimed_user_id IS NULL AND is_active = 1', [result.insertId, selected.roster_id]);
        if (claim.affectedRows !== 1) throw rosterError('ROSTER_ALREADY_CLAIMED', 409);
      }
      return { id: result.insertId, grade, class_number };
    });
    if (registration.linked) {
      const linked = registration.linked;
      const session = await createLoginSession(res, linked, req.body.rememberMe);
      clearAuthRateLimit(req);
      return res.json({ ...session, user: withClassApproval({ ...linked, id: linked.user_id }) });
    }
    const { id, grade, class_number } = registration;
    const user = { id, name: uniqueName, grade, class_number, is_admin: isAdmin };
    const session = await createLoginSession(res, user, req.body.rememberMe);
    clearAuthRateLimit(req);
    return res.json({
      ...session,
      user: withClassApproval({
        id,
        name: uniqueName,
        grade,
        class_number,
        is_class_approved: true,
        can_complete_assignments: canCompleteAssignments({ ...user, google_sub: decoded.profile.google_sub, google_email: decoded.profile.google_email }),
        profile_image_url: decoded.profile.profile_image_url,
        is_alarm_enabled: 1,
        is_admin: isAdmin,
        admin_mode_enabled: 1,
        google_sub: decoded.profile.google_sub,
        google_email: decoded.profile.google_email
      })
    });
  } catch (e) {
    if (['ROSTER_SELECTION_REQUIRED', 'ROSTER_SELECTION_INVALID', 'ROSTER_ALREADY_CLAIMED', 'ROSTER_CHANGED', 'PROFILE_CLASS_INVALID'].includes(e?.code)) {
      const message = e.code === 'ROSTER_SELECTION_REQUIRED' ? '본인 이름에 해당하는 반을 선택해주세요.'
        : e.code === 'ROSTER_ALREADY_CLAIMED' ? '이미 연결된 명단입니다. 다른 계정 사용 여부를 확인해주세요.'
        : e.code === 'PROFILE_CLASS_INVALID' ? '학년과 반을 확인해주세요.' : '가입 정보가 변경되었거나 올바르지 않습니다. 다시 로그인해주세요.';
      return res.status(e.status).json({ code: e.code, error: message });
    }
    if (e?.code === 'PAGES_SESSION_CAPACITY') {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: '현재 로그인 사용자가 많습니다. 잠시 후 다시 시도해주세요.' });
    }
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '이미 연결된 구글 계정입니다.' });
    }
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

function refreshRequestRateLimit(req, res, next) {
  const limit = consumeRateLimitAttempt(refreshAttempts, req.ip || req.socket.remoteAddress || 'unknown', {
    windowMs: 60_000, limit: 1000, maxTrackedClients: AUTH_RATE_MAX_TRACKED_CLIENTS
  });
  if (!limit.allowed) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: '잠시 후 다시 시도해주세요.', code: 'REFRESH_RATE_LIMITED' }); }
  next();
}
app.post('/api/auth/refresh', refreshRequestRateLimit, async (req, res) => {
  if (PAGES_AUTH_MODE !== 'bearer') return res.status(404).json({ error: '사용할 수 없는 인증 방식입니다.' });
  let jti;
  try {
    jti = reservePagesAccess();
    const session = await refreshSessions.rotate(req.body.refreshToken, req.body.requestId);
    const user = await getCurrentUser(session.userId);
    if (!user) { await refreshSessions.revoke(session.refreshToken); throw Object.assign(new Error('invalid-user'), { status: 401 }); }
    const access = issuePagesAccess(jti, session.userId, session.familyId);
    return res.json({ ...access, refreshToken: session.refreshToken, refreshExpiresAt: session.refreshExpiresAt, authRealm: AUTH_REALM_ID, user: withClassApproval(user) });
  } catch (error) {
    if (jti) pagesAccessSessions.delete(jti);
    const status = [400, 401, 409, 429, 503].includes(error.status) ? error.status : 503;
    if (status === 429 || status === 503) res.setHeader('Retry-After', '60');
    return res.status(status).json({ error: status === 401 ? '로그인이 만료되었습니다.' : status === 409 ? '다른 탭에서 로그인 상태를 갱신하고 있습니다.' : '로그인 상태를 갱신하지 못했습니다. 잠시 후 다시 시도해주세요.', code: error.code || 'REFRESH_UNAVAILABLE' });
  }
});
app.post('/api/auth/logout', refreshRequestRateLimit, async (req, res) => {
  try {
    if (PAGES_AUTH_MODE === 'bearer') {
      const authorization = String(req.get('Authorization') || '');
      if (typeof req.body?.refreshToken === 'string') {
        try { await refreshSessions.revoke(req.body.refreshToken); } catch (error) { if (error.status !== 401) throw error; }
      }
      if (authorization.startsWith('Bearer ')) {
        try {
          const decoded = verifyPagesAccessToken(authorization.slice(7));
          const session = pagesAccessSessions.get(decoded.jti);
          if (session?.familyId) {
            await pool.execute('UPDATE auth_refresh_families SET revoked = 1 WHERE family_id = ? AND auth_realm_id = ?', [session.familyId, AUTH_REALM_ID]);
            revokeFamilyAccess(session.familyId);
          } else pagesAccessSessions.delete(decoded.jti);
        } catch (error) { if (!['TokenExpiredError', 'JsonWebTokenError'].includes(error.name) && error.message !== 'invalid-pages-access') throw error; }
      }
    }
    res.setHeader('Set-Cookie', clearAuthCookie());
    res.json({ success: true });
  } catch { res.status(503).json({ error: '서버의 로그아웃 처리에 실패했습니다. 다시 시도해주세요.' }); }
});

app.post('/api/uploads/assignment-image', authMiddleware, assignmentImageRateLimit, async (req, res) => {
  if (!ASSIGNMENT_IMAGES_ENABLED) return res.status(503).json({ error: '현재 배포 환경에서는 이미지 업로드를 사용할 수 없습니다. 과제 내용을 텍스트로 입력해주세요.' });
  try {
    const imageDataUrl = String(req.body.image_data_url || '');
    if (!imageDataUrl) {
      return res.status(400).json({ error: '이미지 데이터가 필요합니다.' });
    }

    const user = await getCurrentUser(req.user.id);
    if (!user) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }

    let decoded;
    try {
      decoded = decodeAssignmentImageDataUrl(imageDataUrl);
    } catch (error) {
      const message = error?.message === 'assignment-image-too-large'
        ? '이미지는 4MB 이하만 업로드할 수 있습니다.'
        : error?.message === 'assignment-image-dimensions-too-large'
          ? '이미지는 가로·세로 8192픽셀 이하, 전체 1600만 픽셀 이하만 업로드할 수 있습니다.'
        : error?.message === 'assignment-image-animation-not-supported'
          ? '움직이는 이미지는 첨부할 수 없습니다. PNG/JPG 또는 정적인 GIF/WebP를 사용해주세요.'
        : error?.message === 'assignment-image-type'
          ? 'PNG, JPG, WEBP, GIF 이미지만 업로드할 수 있습니다.'
          : '이미지 형식이 올바르지 않습니다.';
      return res.status(400).json({ error: message });
    }

    const filename = `${user.user_id}-${Date.now()}-${crypto.randomBytes(16).toString('hex')}${decoded.extension}`;
    await storeAssignmentImage(filename, decoded.buffer);

    res.json({
      success: true,
      url: `${ASSIGNMENT_IMAGE_PUBLIC_PATH}/${filename}`,
      markdown: `![첨부 이미지](${ASSIGNMENT_IMAGE_PUBLIC_PATH}/${filename})`
    });
  } catch (error) {
    if (error?.message === 'assignment-image-storage-full') return res.status(507).json({ error: '이미지 저장 공간이 부족합니다. 관리자에게 문의하거나 과제를 텍스트로 입력해주세요.' });
    res.status(500).json({ error: '이미지 업로드에 실패했습니다.' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT user_id, name, grade, class_number, class_approved, google_sub, google_email, profile_image_url, is_alarm_enabled, is_admin, admin_mode_enabled FROM users WHERE user_id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    res.json(withClassApproval(rows[0]));
  } catch {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// Users
app.put('/api/users/me/admin-mode', authMiddleware, async (req, res) => {
  if (req.get('Origin') !== getAllowedFrontendOrigin(req)) return res.status(403).json({ error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' });
  if (typeof req.body.enabled !== 'boolean' || Object.keys(req.body).some(key => key !== 'enabled')) {
    return res.status(400).json({ error: '관리자 모드를 켜거나 끄는 값만 입력해주세요.' });
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT user_id, name, grade, class_number, class_approved, google_sub, google_email, profile_image_url, is_alarm_enabled, is_admin, admin_mode_enabled FROM users WHERE user_id = ? FOR UPDATE',
      [req.user.id]
    );
    const owner = rows[0];
    if (!canSwitchAdminMode(owner)) {
      await connection.rollback();
      return res.status(403).json({ error: '이 계정에서는 관리자 모드를 전환할 수 없습니다.' });
    }
    await connection.execute('UPDATE users SET admin_mode_enabled = ? WHERE user_id = ?', [req.body.enabled ? 1 : 0, req.user.id]);
    await connection.commit();
    clearResponseCaches({ users: true, assignments: true, messages: true, notifications: true });
    return res.json({ success: true, user: withClassApproval({ ...owner, admin_mode_enabled: req.body.enabled ? 1 : 0 }) });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch {} }
    logApiError('PUT /api/users/me/admin-mode failed', error, { userId: req.user?.id });
    return res.status(500).json({ error: '모드를 변경하지 못했습니다. 다시 시도해주세요.' });
  } finally {
    connection?.release();
  }
});

app.get('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    const currentUser = await getCurrentUser(req.user.id);
    if (!currentUser) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    const requestedUserId = parseInteger(req.params.id);
    if (requestedUserId !== req.user.id && !isAdminUser(currentUser)) return res.status(403).json({ error: '권한이 없습니다.' });
    const [rows] = await pool.execute('SELECT user_id, name, grade, class_number, class_approved, google_sub, google_email, profile_image_url, is_alarm_enabled, is_admin, admin_mode_enabled FROM users WHERE user_id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    res.json(withClassApproval(rows[0]));
  } catch {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/api/admin/users', authMiddleware, async (req, res) => {
  try {
    const adminUser = await ensureAdminAccess(req, res);
    if (!adminUser) return;
    const { page, pageSize, offset } = parsePagination(req.query);
    const safePageSize = toSqlLimit(pageSize, ADMIN_PAGE_SIZE_DEFAULT);
    const safeOffset = toSqlLimit(offset, 0);
    const cacheKey = JSON.stringify({ page, pageSize, scope: 'admin-users' });
    const cached = getCachedResponse(adminUserCache, cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const [[countRow]] = await pool.execute('SELECT COUNT(*) AS total FROM users');
    const [rows] = await pool.execute(
      `SELECT user_id, name, google_sub, google_email, grade, class_number, class_approved, is_alarm_enabled, is_admin, admin_mode_enabled, created_at
         FROM users
        ORDER BY is_admin DESC, grade ASC, class_number ASC, name ASC
        LIMIT ${safePageSize} OFFSET ${safeOffset}`
    );
    const payload = {
      items: rows.map(withClassApproval),
      total: Number(countRow.total) || 0,
      page,
      pageSize
    };
    res.json(setCachedResponse(adminUserCache, cacheKey, payload));
  } catch (error) {
    logApiError('GET /api/admin/users failed', error, { userId: req.user?.id });
    res.status(503).json({ error: '목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.get('/api/admin/assignments', authMiddleware, async (req, res) => {
  try {
    const adminUser = await ensureAdminAccess(req, res);
    if (!adminUser) return;

    const { page, pageSize, offset } = parsePagination(req.query);
    const safePageSize = toSqlLimit(pageSize, ADMIN_PAGE_SIZE_DEFAULT);
    const safeOffset = toSqlLimit(offset, 0);
    const grade = req.query.grade && req.query.grade !== 'all' ? parseInteger(req.query.grade) : null;
    const classNumber = req.query.class_number && req.query.class_number !== 'all' ? parseInteger(req.query.class_number) : null;

    if (grade !== null && (grade < 1 || grade > MAX_GRADE)) {
      return res.status(400).json({ error: '학년 값이 올바르지 않습니다.' });
    }
    if (classNumber !== null && (classNumber < 1 || classNumber > MAX_CLASS)) {
      return res.status(400).json({ error: '반 값이 올바르지 않습니다.' });
    }

    const cacheKey = getAdminAssignmentCacheKey({ page, pageSize, grade, classNumber });
    const cached = getCachedResponse(adminAssignmentCache, cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const conditions = [];
    const params = [];
    if (grade !== null) {
      conditions.push('a.target_grade = ?');
      params.push(grade);
    }
    if (classNumber !== null) {
      conditions.push('a.target_class = ?');
      params.push(classNumber);
    }
    const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const [[countRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM assignments a${whereSql}`,
      params
    );
    const [rows] = await pool.execute(
        `SELECT a.*, COALESCE(u.name, '삭제된 사용자') AS creator_name
           FROM assignments a
           LEFT JOIN users u ON a.created_by = u.user_id${whereSql}
          ORDER BY a.due_date ASC, a.target_grade ASC, a.target_class ASC, a.created_at DESC
          LIMIT ${safePageSize} OFFSET ${safeOffset}`,
        params
      );

    const payload = {
      items: rows,
      total: Number(countRow.total) || 0,
      page,
      pageSize
    };
    res.json(setCachedResponse(adminAssignmentCache, cacheKey, payload));
  } catch (error) {
    logApiError('GET /api/admin/assignments failed', error, { userId: req.user?.id });
    res.status(503).json({ error: '목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.get('/api/admin/messages', authMiddleware, async (req, res) => {
  try {
    const adminUser = await ensureAdminAccess(req, res);
    if (!adminUser) return;

    const { page, pageSize, offset } = parsePagination(req.query);
    const safePageSize = toSqlLimit(pageSize, ADMIN_PAGE_SIZE_DEFAULT);
    const safeOffset = toSqlLimit(offset, 0);
    const type = req.query.type ? String(req.query.type) : null;
    const grade = req.query.grade && req.query.grade !== 'all' ? parseInteger(req.query.grade) : null;
    const classNumber = req.query.class_number && req.query.class_number !== 'all' ? parseInteger(req.query.class_number) : null;

    if (type && !['grade', 'class'].includes(type)) {
      return res.status(400).json({ error: '메세지 유형이 올바르지 않습니다.' });
    }
    if (grade !== null && (grade < 1 || grade > MAX_GRADE)) {
      return res.status(400).json({ error: '학년 값이 올바르지 않습니다.' });
    }
    if (classNumber !== null && (classNumber < 1 || classNumber > MAX_CLASS)) {
      return res.status(400).json({ error: '반 값이 올바르지 않습니다.' });
    }

    const cacheKey = getAdminMessageCacheKey({ page, pageSize, type, grade, classNumber });
    const cached = getCachedResponse(adminMessageCache, cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const conditions = [];
    const params = [];
    if (type) {
      conditions.push('m.type = ?');
      params.push(type);
    }
    if (grade !== null) {
      conditions.push('m.target_grade = ?');
      params.push(grade);
    }
    if (type === 'class' && classNumber !== null) {
      conditions.push('m.target_class = ?');
      params.push(classNumber);
    }
    const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const [[countRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM messages m${whereSql}`,
      params
    );
    const [rows] = await pool.execute(
        `SELECT m.*, COALESCE(u.name, '삭제된 사용자') AS sender_name
           FROM messages m
           LEFT JOIN users u ON m.sender_id = u.user_id${whereSql}
          ORDER BY m.created_at DESC
          LIMIT ${safePageSize} OFFSET ${safeOffset}`,
        params
      );

    const payload = {
      items: rows,
      total: Number(countRow.total) || 0,
      page,
      pageSize
    };
    res.json(setCachedResponse(adminMessageCache, cacheKey, payload));
  } catch (error) {
    logApiError('GET /api/admin/messages failed', error, { userId: req.user?.id });
    res.status(503).json({ error: '목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.put('/api/admin/users/:id', authMiddleware, async (req, res) => {
  let connection;
  try {
    const adminUser = await ensureAdminAccess(req, res);
    if (!adminUser) return;
    const targetUserId = parseInteger(req.params.id);
    if (!targetUserId) return res.status(400).json({ error: '사용자 정보가 올바르지 않습니다.' });
    if (req.body.name !== undefined) return res.status(400).json({ error: '이름은 변경할 수 없습니다.' });

    const changes = {};
    for (const [field, maximum] of [['grade', MAX_GRADE], ['class_number', MAX_CLASS]]) {
      if (req.body[field] === undefined) continue;
      const value = parseInteger(req.body[field]);
      if (!value || value < 1 || value > maximum) return res.status(400).json({ error: '학년 또는 반 값이 올바르지 않습니다.' });
      changes[field] = value;
    }
    for (const field of ['is_alarm_enabled']) {
      if (req.body[field] === undefined) continue;
      if (![true, false, 0, 1, '0', '1'].includes(req.body[field])) return res.status(400).json({ error: '알림 값이 올바르지 않습니다.' });
      changes[field] = normalizeBooleanFlag(req.body[field]);
    }
    if (!Object.keys(changes).length) return res.status(400).json({ error: '수정할 내용이 없습니다.' });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [targetRows] = await connection.execute(
      'SELECT user_id, grade, class_number, google_sub, google_email, is_admin FROM users WHERE user_id = ? FOR UPDATE', [targetUserId]
    );
    if (!targetRows.length) {
      await connection.rollback();
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }
    const target = targetRows[0];
    const fields = Object.keys(changes);
    await connection.execute(`UPDATE users SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE user_id = ?`, [...fields.map(field => changes[field]), targetUserId]);
    await connection.commit();
    clearResponseCaches({ users: true, notifications: true });
    return res.json({ success: true, is_class_approved: true, can_complete_assignments: canCompleteAssignments(target) });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch {} }
    logApiError('PUT /api/admin/users/:id failed', error, { targetUserId: req.params.id, actorUserId: req.user?.id });
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  } finally {
    connection?.release();
  }
});

  app.delete('/api/admin/users/:id', authMiddleware, async (req, res) => {
    try {
      const adminUser = await ensureAdminAccess(req, res);
      if (!adminUser) return;
      const targetUserId = parseInteger(req.params.id);
    if (!targetUserId) return res.status(400).json({ error: '사용자 정보가 올바르지 않습니다.' });
    if (targetUserId === req.user.id) return res.status(400).json({ error: '본인 계정은 삭제할 수 없습니다.' });

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute('SELECT is_admin FROM users WHERE user_id = ? FOR UPDATE', [targetUserId]);
        if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' }); }
        if (normalizeBooleanFlag(rows[0].is_admin)) { await connection.rollback(); return res.status(400).json({ error: '관리자 계정은 삭제할 수 없습니다.' }); }

        await connection.execute('DELETE FROM user_assignments WHERE user_id = ?', [targetUserId]);
        await connection.execute('DELETE FROM user_assignments WHERE assignment_id IN (SELECT assignment_id FROM assignments WHERE created_by = ?)', [targetUserId]);
        await connection.execute('DELETE FROM assignments WHERE created_by = ?', [targetUserId]);
        await connection.execute('DELETE FROM messages WHERE sender_id = ?', [targetUserId]);
        await connection.execute('DELETE FROM users WHERE user_id = ?', [targetUserId]);

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      clearResponseCaches({ users: true, assignments: true, messages: true, notifications: true });
      res.json({ success: true });
    } catch (error) {
      logApiError('DELETE /api/admin/users/:id failed', error, { targetUserId: req.params.id, actorUserId: req.user?.id });
      res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
  });

  app.put('/api/users/:id', authMiddleware, async (req, res) => {
    try {
      if (parseInteger(req.params.id) !== req.user.id) return res.status(403).json({ error: '권한이 없습니다.' });
      if (req.body.name !== undefined) {
        return res.status(400).json({ error: '이름은 변경할 수 없습니다.' });
      }
      if (['grade', 'class_number', 'is_admin', 'admin_mode_enabled', 'can_switch_admin_mode', 'can_complete_assignments', 'google_sub', 'google_email'].some(field => req.body[field] !== undefined)) {
        return res.status(403).json({ error: '소속과 계정 권한은 관리자만 변경할 수 있습니다.' });
      }
      if (req.body.is_alarm_enabled !== undefined) {
        if (![true, false, 0, 1, '0', '1'].includes(req.body.is_alarm_enabled)) return res.status(400).json({ error: '알림 설정이 올바르지 않습니다.' });
        req.body.is_alarm_enabled = normalizeBooleanFlag(req.body.is_alarm_enabled);
      }
      const allowed = ['is_alarm_enabled'];
    const updates = [];
    const values = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: '수정할 내용이 없습니다.' });
    values.push(req.params.id);
    await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`, values);
    clearResponseCaches({ users: true, notifications: true });
    res.json({ success: true, is_class_approved: true, can_complete_assignments: canCompleteAssignments(req.currentUser) });
  } catch {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// Assignments
app.get('/api/assignments', authMiddleware, async (req, res) => {
  try {
    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (isAdminUser(user)) {
        return res.json(await getAdminCalendarAssignments(user));
      }
      const [rows] = await pool.execute(
        'SELECT a.*, COALESCE(u.name, \'삭제된 사용자\') AS creator_name FROM assignments a LEFT JOIN users u ON a.created_by = u.user_id WHERE a.target_grade = ? AND (a.target_class = ? OR a.target_class IS NULL) ORDER BY a.due_date ASC',
        [user.grade, user.class_number]
      );
    res.json(rows);
  } catch {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.post('/api/assignments', authMiddleware, assignmentWriteRateLimit, async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const content = req.body.content === undefined || req.body.content === null ? null : String(req.body.content).trim();
    const due_date = String(req.body.due_date || '');
    if (!title || !due_date) return res.status(400).json({ error: '과제명과 마감일은 필수입니다.' });
    if (title.length > 120) return res.status(400).json({ error: '과제명은 120자 이하로 입력해주세요.' });
    if (content && content.length > MAX_ASSIGNMENT_CONTENT_LENGTH) return res.status(400).json({ error: getAssignmentContentErrorMessage() });
    if (!isValidDateOnly(due_date)) return res.status(400).json({ error: '마감일 형식이 올바르지 않습니다.' });
    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (!await validateAssignmentImageReferences(content, user)) return res.status(403).json({ error: '사용할 수 없는 첨부 이미지가 포함되어 있습니다.' });
    let target_grade = user.grade;
    let target_class = user.class_number;

    if (isAdminUser(user)) {
      target_grade = parseInteger(req.body.target_grade);
      target_class = parseInteger(req.body.target_class);
      if (!target_grade || target_grade < 1 || target_grade > MAX_GRADE) return res.status(400).json({ error: '대상 학년이 올바르지 않습니다.' });
      if (!target_class || target_class < 1 || target_class > MAX_CLASS) return res.status(400).json({ error: '대상 반이 올바르지 않습니다.' });
    }

    const assignmentId = await withTransaction(async (connection) => {
      const [result] = await connection.execute(
        'INSERT INTO assignments (title, content, due_date, target_grade, target_class, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        [title, content || null, due_date, target_grade, target_class || null, req.user.id]
      );
      await connection.execute(
        'INSERT IGNORE INTO user_assignments (user_id, assignment_id, is_completed) SELECT user_id, ?, 0 FROM users WHERE grade = ? AND (? IS NULL OR class_number = ?)',
        [result.insertId, target_grade, target_class, target_class]
      );
      return result.insertId;
    });

    clearResponseCaches({ assignments: true, notifications: true });
    res.json({ assignment_id: assignmentId, success: true });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.put('/api/assignments/:id', authMiddleware, assignmentWriteRateLimit, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT created_by, target_grade, target_class FROM assignments WHERE assignment_id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '과제를 찾을 수 없습니다.' });
    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (rows[0].created_by !== req.user.id && !isAdminUser(user)) return res.status(403).json({ error: '권한이 없습니다.' });
    if (!isAdminUser(user) && (Number(rows[0].target_grade) !== Number(user.grade) || Number(rows[0].target_class) !== Number(user.class_number))) return res.status(403).json({ error: '현재 소속 반의 과제만 변경할 수 있습니다.' });
    const { title, content, due_date } = req.body;
    const currentAssignment = rows[0];
    const updates = [];
    const values = [];
    let nextTargetGrade = currentAssignment.target_grade;
    let nextTargetClass = currentAssignment.target_class;

    if (title !== undefined) {
      const normalizedTitle = String(title).trim();
      if (!normalizedTitle || normalizedTitle.length > 120) return res.status(400).json({ error: '과제명은 1자 이상 120자 이하로 입력해주세요.' });
      updates.push('title = ?');
      values.push(normalizedTitle);
    }
    if (content !== undefined) {
      const normalizedContent = content === null ? null : String(content).trim();
      if (normalizedContent && normalizedContent.length > MAX_ASSIGNMENT_CONTENT_LENGTH) return res.status(400).json({ error: getAssignmentContentErrorMessage() });
      if (!await validateAssignmentImageReferences(normalizedContent, user)) return res.status(403).json({ error: '사용할 수 없는 첨부 이미지가 포함되어 있습니다.' });
      updates.push('content = ?');
      values.push(normalizedContent);
    }
    if (due_date !== undefined) {
      if (!isValidDateOnly(due_date)) return res.status(400).json({ error: '마감일 형식이 올바르지 않습니다.' });
      updates.push('due_date = ?');
      values.push(due_date);
    }
    if (isAdminUser(user)) {
      if (req.body.target_grade !== undefined) {
        nextTargetGrade = parseInteger(req.body.target_grade);
        if (!nextTargetGrade || nextTargetGrade < 1 || nextTargetGrade > MAX_GRADE) {
          return res.status(400).json({ error: '대상 학년이 올바르지 않습니다.' });
        }
        updates.push('target_grade = ?');
        values.push(nextTargetGrade);
      }
      if (req.body.target_class !== undefined) {
        nextTargetClass = parseInteger(req.body.target_class);
        if (!nextTargetClass || nextTargetClass < 1 || nextTargetClass > MAX_CLASS) {
          return res.status(400).json({ error: '대상 반이 올바르지 않습니다.' });
        }
        updates.push('target_class = ?');
        values.push(nextTargetClass);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: '수정할 내용이 없습니다.' });
    values.push(req.params.id);
    await withTransaction(async (connection) => {
      // Lock the current scope: another admin may have retargeted after the initial read.
      const [lockedRows] = await connection.execute(
        'SELECT target_grade, target_class FROM assignments WHERE assignment_id = ? FOR UPDATE',
        [req.params.id]
      );
      if (!lockedRows.length) throw Object.assign(new Error('assignment-not-found'), { status: 404 });
      const lockedAssignment = lockedRows[0];
      if (!isAdminUser(user) && (Number(lockedAssignment.target_grade) !== Number(user.grade) || Number(lockedAssignment.target_class) !== Number(user.class_number))) {
        throw Object.assign(new Error('assignment-scope-changed'), { status: 403 });
      }
      const effectiveGrade = isAdminUser(user) && req.body.target_grade !== undefined ? nextTargetGrade : lockedAssignment.target_grade;
      const effectiveClass = isAdminUser(user) && req.body.target_class !== undefined ? nextTargetClass : lockedAssignment.target_class;
      await connection.execute(`UPDATE assignments SET ${updates.join(', ')} WHERE assignment_id = ?`, values);
      if (effectiveGrade !== lockedAssignment.target_grade || effectiveClass !== lockedAssignment.target_class) {
        await connection.execute('DELETE FROM user_assignments WHERE assignment_id = ?', [req.params.id]);
        await connection.execute(
          'INSERT IGNORE INTO user_assignments (user_id, assignment_id, is_completed) SELECT user_id, ?, 0 FROM users WHERE grade = ? AND (? IS NULL OR class_number = ?)',
          [req.params.id, effectiveGrade, effectiveClass, effectiveClass]
        );
      }
    });

    clearResponseCaches({ assignments: true, notifications: true });
    res.json({ success: true });
  } catch (error) {
    if (error?.status === 404) return res.status(404).json({ error: '과제를 찾을 수 없습니다.' });
    if (error?.status === 403) return res.status(403).json({ error: '현재 소속 반의 과제만 변경할 수 있습니다.' });
    logApiError('PUT /api/assignments/:id failed', error, { assignmentId: req.params.id, actorUserId: req.user?.id });
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/api/assignments/:id/status', authMiddleware, async (req, res) => {
  try {
    const assignmentId = parseInteger(req.params.id);
    if (!assignmentId) return res.status(400).json({ error: '과제 정보가 올바르지 않습니다.' });

    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (!isAdminUser(user)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });

    const [assignmentRows] = await pool.execute(
      'SELECT assignment_id, title, target_grade, target_class FROM assignments WHERE assignment_id = ? LIMIT 1',
      [assignmentId]
    );
    if (assignmentRows.length === 0) return res.status(404).json({ error: '과제를 찾을 수 없습니다.' });

    const assignment = assignmentRows[0];
    const [classMembers] = await pool.execute(
      `SELECT u.user_id, u.name, u.grade, u.class_number, u.is_admin, u.google_sub, u.google_email, COALESCE(ua.is_completed, 0) AS is_completed
       FROM users u
       LEFT JOIN user_assignments ua
         ON ua.user_id = u.user_id AND ua.assignment_id = ?
       WHERE u.grade = ?
         AND (? IS NULL OR u.class_number = ?)
       ORDER BY u.class_number ASC, u.name ASC`,
      [assignmentId, assignment.target_grade, assignment.target_class, assignment.target_class]
    );
    const students = classMembers.filter(canCompleteAssignments).map(({ user_id, name, grade, class_number, is_completed }) => ({ user_id, name, grade, class_number, is_completed }));

    res.json({
      assignment,
      students
    });
  } catch {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.delete('/api/assignments/:id', authMiddleware, assignmentWriteRateLimit, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT created_by, target_grade, target_class FROM assignments WHERE assignment_id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '과제를 찾을 수 없습니다.' });
    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (rows[0].created_by !== req.user.id && !isAdminUser(user)) return res.status(403).json({ error: '권한이 없습니다.' });
    if (isAdminUser(user)) {
      await pool.execute('DELETE FROM assignments WHERE assignment_id = ?', [req.params.id]);
    } else {
      const [result] = await pool.execute('DELETE FROM assignments WHERE assignment_id = ? AND created_by = ? AND target_grade = ? AND target_class = ?', [req.params.id, req.user.id, user.grade, user.class_number]);
      if (!result.affectedRows) return res.status(403).json({ error: '현재 소속 반의 과제만 삭제할 수 있습니다.' });
    }
    clearResponseCaches({ assignments: true, notifications: true });
    res.json({ success: true });
  } catch (error) {
    logApiError('DELETE /api/assignments/:id failed', error, { assignmentId: req.params.id, actorUserId: req.user?.id });
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// User Assignments (completion status)
app.get('/api/user-assignments/:userId', authMiddleware, async (req, res) => {
  try {
    if (parseInteger(req.params.userId) !== req.user.id) return res.status(403).json({ error: '권한이 없습니다.' });
    const [rows] = await pool.execute('SELECT * FROM user_assignments WHERE user_id = ?', [req.params.userId]);
    const map = {};
    rows.forEach(r => { map[r.assignment_id] = r.is_completed; });
    res.json(map);
  } catch {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.put('/api/user-assignments', authMiddleware, async (req, res) => {
  try {
    const assignmentId = parseInteger(req.body.assignment_id);
    if (!assignmentId) return res.status(400).json({ error: '과제 정보가 올바르지 않습니다.' });
    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (!canCompleteAssignments(user)) return res.status(403).json({ error: '학생 계정만 본인 반 과제를 완료 처리할 수 있습니다.' });
    if (![true, false, 0, 1, '0', '1'].includes(req.body.is_completed)) {
      return res.status(400).json({ error: '완료 상태가 올바르지 않습니다.' });
    }
    const isCompleted = normalizeBooleanFlag(req.body.is_completed);
    // Check visibility within the write itself, so a concurrent retarget cannot bypass it.
    const [result] = await pool.execute(
      `INSERT INTO user_assignments (user_id, assignment_id, is_completed)
       SELECT ?, assignment_id, ? FROM assignments
       WHERE assignment_id = ? AND target_grade = ? AND (target_class = ? OR target_class IS NULL)
       ON DUPLICATE KEY UPDATE is_completed = ?`,
      [req.user.id, isCompleted, assignmentId, user.grade, user.class_number, isCompleted]
    );
    if (!result.affectedRows) {
      const [rows] = await pool.execute(
        'SELECT assignment_id FROM assignments WHERE assignment_id = ? AND target_grade = ? AND (target_class = ? OR target_class IS NULL) LIMIT 1',
        [assignmentId, user.grade, user.class_number]
      );
      if (!rows.length) return res.status(403).json({ error: '권한이 없습니다.' });
    }

    clearResponseCaches({ notifications: true });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/api/users/:userId/assignments', authMiddleware, async (req, res) => {
  try {
    const userId = parseInteger(req.params.userId);
    if (userId !== req.user.id) return res.status(403).json({ error: '권한이 없습니다.' });
    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (isAdminUser(user)) {
        return res.json(await getAdminCalendarAssignments(user));
      }
      const [rows] = await pool.execute(
        'SELECT a.*, COALESCE(u.name, \'삭제된 사용자\') AS creator_name, COALESCE(ua.is_completed, 0) AS is_completed FROM assignments a LEFT JOIN users u ON a.created_by = u.user_id LEFT JOIN user_assignments ua ON a.assignment_id = ua.assignment_id AND ua.user_id = ? WHERE a.target_grade = ? AND (a.target_class = ? OR a.target_class IS NULL) ORDER BY a.due_date ASC',
        [userId, user.grade, user.class_number]
      );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// Messages
app.get('/api/messages', authMiddleware, async (req, res) => {
  try {
    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    const type = req.query.type ? String(req.query.type) : null;
    if (type && !['grade', 'class'].includes(type)) return res.status(400).json({ error: '메세지 유형이 올바르지 않습니다.' });
    if (isAdminUser(user)) {
        let sql = 'SELECT m.*, COALESCE(u.name, \'삭제된 사용자\') AS sender_name FROM messages m LEFT JOIN users u ON m.sender_id = u.user_id';
      const params = [];
      if (type) {
        sql += ' WHERE m.type = ?';
        params.push(type);
      }
      sql += ' ORDER BY m.created_at DESC';
      const [rows] = await pool.execute(sql, params);
      return res.json(rows);
    }
      let sql = 'SELECT m.*, COALESCE(u.name, \'삭제된 사용자\') AS sender_name FROM messages m LEFT JOIN users u ON m.sender_id = u.user_id WHERE m.target_grade = ? AND ((m.type = ? AND m.target_class IS NULL) OR (m.type = ? AND m.target_class = ?))';
    const params = [user.grade, 'grade', 'class', user.class_number];
    if (type) {
      sql += ' AND m.type = ?';
      params.push(type);
    }
    sql += ' ORDER BY m.created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (error) {
    logApiError('GET /api/messages failed', error, { query: req.query, userId: req.user?.id });
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const limit = 12;
    const currentUser = await getCurrentUser(req.user.id);
    if (!currentUser) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }

    const cacheKey = getNotificationCacheKey(currentUser);
    const cached = getCachedResponse(notificationCache, cacheKey);
    if (cached) {
      return res.json(cached);
    }

    let assignmentSql = `
        SELECT a.assignment_id, a.title, a.due_date, a.created_at, a.target_grade, a.target_class, COALESCE(u.name, '삭제된 사용자') AS creator_name
        FROM assignments a
        LEFT JOIN users u ON a.created_by = u.user_id
      `;
    let assignmentParams = [];

    let messageSql = `
        SELECT m.message_id, m.content, m.created_at, m.type, m.target_grade, m.target_class, COALESCE(u.name, '삭제된 사용자') AS sender_name
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.user_id
      `;
    let messageParams = [];

    if (!isAdminUser(currentUser)) {
      assignmentSql += ' WHERE a.target_grade = ? AND (a.target_class = ? OR a.target_class IS NULL)';
      assignmentParams = [currentUser.grade, currentUser.class_number];

      messageSql += ' WHERE m.target_grade = ? AND ((m.type = ? AND m.target_class IS NULL) OR (m.type = ? AND m.target_class = ?))';
      messageParams = [currentUser.grade, 'grade', 'class', currentUser.class_number];
    }

    assignmentSql += ` ORDER BY a.created_at DESC LIMIT ${limit}`;

    messageSql += ` ORDER BY m.created_at DESC LIMIT ${limit}`;

    const [assignmentResult, messageResult] = await Promise.all([
      pool.execute(assignmentSql, assignmentParams),
      pool.execute(messageSql, messageParams)
    ]);
    const assignmentRows = Array.isArray(assignmentResult?.[0]) ? assignmentResult[0] : [];
    const messageRows = Array.isArray(messageResult?.[0]) ? messageResult[0] : [];

    const items = [
      ...assignmentRows.map((assignment) => ({
        id: `assignment-${assignment.assignment_id}`,
        created_at: assignment.created_at,
        title: '새 과제',
        body: assignment.title,
        meta: `${assignment.creator_name || '선생님'} · 마감 ${assignment.due_date}`,
        link: 'calendar.html',
        kind: 'assignment'
      })),
      ...messageRows.map((message) => ({
        id: `message-${message.message_id}`,
        created_at: message.created_at,
        title: message.type === 'grade' ? '학년 공지' : '반 공지',
        body: message.content,
        meta: `${message.sender_name} · ${message.type === 'grade' ? `${message.target_grade}학년` : `${message.target_grade}학년 ${message.target_class}반`}`,
        link: 'messages.html',
        kind: 'message'
      }))
    ]
      .filter((item) => item.created_at)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);

    res.json(setCachedResponse(notificationCache, cacheKey, items));
  } catch (error) {
    logApiError('GET /api/notifications failed', error, { userId: req.user?.id });
    res.status(503).json({ error: '알림을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

app.post('/api/messages', authMiddleware, assignmentWriteRateLimit, async (req, res) => {
  try {
    const content = String(req.body.content || '').trim();
    const type = String(req.body.type || '');
    if (!content || !type) return res.status(400).json({ error: '내용과 유형은 필수입니다.' });
    if (!['grade', 'class'].includes(type)) return res.status(400).json({ error: '메세지 유형이 올바르지 않습니다.' });
    if (content.length > 1000) return res.status(400).json({ error: '메세지는 1000자 이하로 입력해주세요.' });
    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    // Students publish only to their own DB-registered grade/class. Client
    // target fields cannot widen that scope. Admins retain target selection.
    let target_grade = isAdminUser(user) ? parseInteger(req.body.target_grade) : Number(user.grade);
    let target_class = null;

    if (!target_grade || target_grade < 1 || target_grade > MAX_GRADE) return res.status(400).json({ error: '대상 학년이 올바르지 않습니다.' });
    if (type === 'class') {
      target_class = isAdminUser(user) ? parseInteger(req.body.target_class) : Number(user.class_number);
      if (!target_class || target_class < 1 || target_class > MAX_CLASS) return res.status(400).json({ error: '대상 반이 올바르지 않습니다.' });
    }

    const [result] = await pool.execute('INSERT INTO messages (sender_id, content, type, target_grade, target_class) VALUES (?, ?, ?, ?, ?)', [req.user.id, content, type, target_grade, target_class || null]);

    clearResponseCaches({ messages: true, notifications: true });
    res.json({ message_id: result.insertId, success: true });
  } catch (error) {
    logApiError('POST /api/messages failed', error, { actorUserId: req.user?.id });
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.delete('/api/messages/:id', authMiddleware, assignmentWriteRateLimit, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT sender_id FROM messages WHERE message_id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '메세지를 찾을 수 없습니다.' });
    const user = await getCurrentUser(req.user.id);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (rows[0].sender_id !== req.user.id && !isAdminUser(user)) return res.status(403).json({ error: '권한이 없습니다.' });
    if (isAdminUser(user)) {
      await pool.execute('DELETE FROM messages WHERE message_id = ?', [req.params.id]);
    } else {
      const [result] = await pool.execute('DELETE FROM messages WHERE message_id = ? AND sender_id = ? AND target_grade = ? AND (target_class IS NULL OR target_class = ?)', [req.params.id, req.user.id, user.grade, user.class_number]);
      if (!result.affectedRows) return res.status(403).json({ error: '현재 소속 학년·반의 공지만 삭제할 수 있습니다.' });
    }
    clearResponseCaches({ messages: true, notifications: true });
    res.json({ success: true });
  } catch (error) {
    logApiError('DELETE /api/messages/:id failed', error, { messageId: req.params.id, actorUserId: req.user?.id });
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// AI 챗봇 보관: 현재 실행하지 않습니다. 재활성화 전 인증/비용/개인정보를 다시 검토하세요.
// app.post('/api/chatbot', authMiddleware, chatbotRateLimit, async (req, res) => {
//   try {
//     if (!gemini) {
//       return res.status(503).json({ success: false, error: 'AI 챗봇이 아직 설정되지 않았습니다. 관리자에게 문의해주세요.' });
//     }
//
//     const currentUser = await getCurrentUser(req.user.id);
//     if (!currentUser) {
//       return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
//     }
//
//     const rawMessage = String(req.body.message || '').trim();
//     if (!rawMessage) return res.status(400).json({ error: '질문을 입력해주세요.' });
//     if (rawMessage.length > CHATBOT_MAX_MESSAGE_LENGTH) {
//       return res.status(400).json({ error: `질문은 ${CHATBOT_MAX_MESSAGE_LENGTH}자 이하로 입력해주세요.` });
//     }
//
//     const history = normalizeChatHistory(req.body.history);
//     const cacheKey = getChatbotResponseCacheKey(currentUser.user_id, rawMessage, history);
//     const cachedReply = getCachedChatbotResponse(cacheKey);
//     if (cachedReply) {
//       return res.json({
//         success: true,
//         reply: cachedReply
//       });
//     }
//
//     const chatbotContext = await buildChatbotContext(currentUser);
//     const messages = [
//       {
//         role: 'system',
//         content: [
//           '너는 "과제 알리미" 서비스 안에서 동작하는 한국어 챗봇이다.',
//           '항상 한국어로 답하고, 짧고 실용적으로 설명한다.',
//           '학교 과제 관리와 학습 계획에 도움이 되는 방향으로 답한다.',
//           '아래 컨텍스트에는 사용자의 학년/반과 과제 요약만 포함되어 있다.',
//           '사용자 이름, 작성자 이름, 다른 학생 정보, 공지 원문 같은 민감한 정보는 모른다고 전제한다.',
//           '과제 본문은 요약본만 전달되므로 세부 지시가 더 필요하면 사용자에게 해당 부분만 직접 보내달라고 안내한다.',
//           '제공된 과제 요약 범위를 넘는 정보는 추측하지 않는다.',
//           '',
//           chatbotContext
//         ].join('\n')
//       },
//       ...history,
//       {
//         role: 'user',
//         content: rawMessage
//       }
//     ];
//     const response = await requestChatbotCompletion(messages);
//
//     const reply = String(response.choices?.[0]?.message?.content || '').trim();
//     if (!reply) {
//       return res.status(502).json({ error: '챗봇 응답이 비어 있습니다. 잠시 후 다시 시도해주세요.' });
//     }
//
//     setCachedChatbotResponse(cacheKey, reply);
//     res.json({
//       success: true,
//       reply
//     });
//   } catch (error) {
//     logApiError('POST /api/chatbot failed', error, { userId: req.user?.id });
//     if (error?.status === 401 || error?.status === 403) {
//       return res.status(502).json({ success: false, error: 'AI 챗봇 설정에 문제가 있습니다. 관리자에게 문의해주세요.' });
//     }
//     if (error?.status === 429) {
//       return res.status(503).json({ success: false, error: 'AI 사용량 한도에 잠시 걸렸습니다. 1~2분 후 다시 시도해주세요.' });
//     }
//     if (isChatbotTransientError(error)) {
//       return res.status(503).json({ success: false, error: 'AI 서버 연결이 잠시 불안정합니다. 잠시 후 다시 시도해주세요.' });
//     }
//     res.json({
//       success: false,
//       error: '챗봇 응답을 가져오지 못했습니다. 잠시 후 다시 시도해주세요.'
//     });
//   }
// });
//
// Serve frontend
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API를 찾을 수 없습니다.' });
  res.sendFile(path.join(__dirname, 'src', 'login.html'));
});

// Always return JSON errors for malformed/oversized API payloads, without internals.
app.use((error, req, res, _next) => {
  if (res.headersSent) return _next(error);
  const status = error?.type === 'entity.too.large' ? 413
    : (error instanceof SyntaxError && error?.type === 'entity.parse.failed') || ['Z_DATA_ERROR', 'Z_BUF_ERROR'].includes(error?.code) ? 400
    : error?.status === 404 || error?.code === 'ENOENT' ? 404 : 500;
  if (status >= 500) logApiError('Unhandled request error', error);
  const message = status === 413 ? '요청 데이터가 너무 큽니다.' : status === 400 ? '요청 형식이 올바르지 않습니다.'
    : status === 404 ? '요청한 파일을 찾을 수 없습니다.' : '서버 오류가 발생했습니다.';
  res.status(status).json({ error: message });
});

async function init() {
  let retries = 30;
  while (retries > 0) {
    let conn;
    try {
      if (ASSIGNMENT_IMAGES_ENABLED) await fs.mkdir(ASSIGNMENT_IMAGE_DIR, { recursive: true });
      conn = await pool.getConnection();
      await conn.ping();
      for (const statement of [...bootstrapSchema, ...refreshSchema]) await conn.execute(statement);
      await migrateSchema(conn);
      await cleanupOrphanedRecords(conn);
      await seedAdminAccount(conn);
      console.log('MySQL connected');
      return app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    } catch (error) {
      retries -= 1;
      logApiError(`Waiting for MySQL (${retries} retries left)`, error);
      if (retries > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
    } finally {
      if (conn) conn.release();
    }
  }
  console.error('Failed to initialize MySQL');
  process.exitCode = 1;
  await pool.end();
  return null;
}

if (require.main === module) init();
module.exports = { app, pool, init, migrateSchema };
