import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repositoryRoot, 'web', 'src');
// GitHub only checks that .nojekyll exists, so its contents can also identify
// directories created by this builder without adding another public artifact.
const outputOwnershipMarker = 'assignment-alarm-pages-output-v1\n';
export const frontendFiles = Object.freeze([
  'index.html', 'login.html', 'pending.html', 'calendar.html', 'register.html', 'messages.html', 'settings.html', '.nojekyll',
  'css/style.css', 'css/redesign.css', 'css/secondary.css',
  'js/index.js', 'js/theme-init.js', 'js/api.js', 'js/app-shell.js', 'js/login.js', 'js/calendar.js',
  'js/register.js', 'js/messages.js', 'js/settings.js', 'js/pending.js'
]);

export function validateApiOrigin(value) {
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('ASSIGNMENT_API_BASE_URL must be a public HTTPS origin, for example https://api.your-domain.com'); }
  const validHost = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$|^\[[0-9a-f:]+\]$/i.test(url.hostname);
  if (url.protocol !== 'https:' || !validHost || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ASSIGNMENT_API_BASE_URL must contain only a valid HTTPS origin, without credentials, paths, query, or fragment');
  }
  return url.origin;
}

export function contentSecurityPolicy(apiOrigin) {
  const origin = validateApiOrigin(apiOrigin);
  return [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    `connect-src 'self' ${origin} https://accounts.google.com/gsi/`,
    "img-src 'self' blob: data: https:",
    'frame-src https://accounts.google.com/gsi/',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests'
  ].join('; ');
}

async function assertOwnedOrEmptyOutput(output) {
  let stat;
  try { stat = await fs.lstat(output); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('The Pages output must be a directory, not a file or symbolic link');
  }
  if ((await fs.readdir(output)).length === 0) return;
  try {
    const markerPath = path.join(output, '.nojekyll');
    const markerStat = await fs.lstat(markerPath);
    if (markerStat.isFile() && !markerStat.isSymbolicLink()
      && await fs.readFile(markerPath, 'utf8') === outputOwnershipMarker) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw new Error('Refusing to replace a nonempty directory not created by the Pages builder');
}

export async function buildPages({ apiBaseUrl = process.env.ASSIGNMENT_API_BASE_URL, outputDir = path.join(repositoryRoot, '_site') } = {}) {
  // The public URL is data, never shell/script code. No secrets belong in this build.
  const apiOrigin = validateApiOrigin(apiBaseUrl);
  const output = path.resolve(outputDir);
  if (output === path.parse(output).root || output === repositoryRoot || output === sourceRoot || sourceRoot.startsWith(output + path.sep) || output.startsWith(sourceRoot + path.sep)) {
    throw new Error('The Pages output directory must be separate from application sources');
  }
  await assertOwnedOrEmptyOutput(output);
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, '.nojekyll'), outputOwnershipMarker, { flag: 'wx' });
  const policy = contentSecurityPolicy(apiOrigin);
  for (const relative of frontendFiles) {
    const source = path.join(sourceRoot, relative);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular frontend files may be published: ' + relative);
    const target = path.join(output, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (relative.endsWith('.html')) {
      const html = await fs.readFile(source, 'utf8');
      if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)) throw new Error('Inline scripts are not allowed in Pages output: ' + relative);
      const tag = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">\n  <meta name="referrer" content="strict-origin-when-cross-origin">`;
      const withPolicy = html.replace(/(<meta charset="[^"]+">)/i, '$1\n  ' + tag);
      if (withPolicy === html) throw new Error('Missing charset marker for CSP: ' + relative);
      await fs.writeFile(target, withPolicy);
    } else if (relative !== '.nojekyll') {
      await fs.copyFile(source, target);
    }
  }
  const config = { apiBaseUrl: apiOrigin, authMode: 'bearer' };
  await fs.writeFile(path.join(output, 'js', 'runtime-config.js'), '// Public Pages configuration. No credentials are stored here.\nwindow.ASSIGNMENT_CONFIG = Object.freeze(' + JSON.stringify(config) + ');\n');
  return { outputDir: output, apiOrigin, authMode: 'bearer', files: frontendFiles.length + 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildPages().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
