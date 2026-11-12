export const FRONTEND_ORIGIN = 'https://insaeng0.github.io';

function errorResponse(status, message, origin) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
  if (origin === FRONTEND_ORIGIN) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(JSON.stringify({ success: false, error: message }), { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (origin && origin !== FRONTEND_ORIGIN) return errorResponse(403, '허용되지 않은 사이트에서 보낸 요청입니다.', null);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/uploads/assignment-images/')) return errorResponse(404, '요청한 주소를 찾지 못했습니다.', origin);
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(request.method)) return errorResponse(405, '허용되지 않은 요청 방식입니다.', origin);
    const headers = new Headers();
    for (const key of ['Origin', 'Authorization', 'Content-Type', 'Accept', 'Accept-Language', 'Access-Control-Request-Method', 'Access-Control-Request-Headers']) {
      const value = request.headers.get(key);
      if (value !== null) headers.set(key, value);
    }
    const client = request.headers.get('CF-Connecting-IP');
    if (client && /^[0-9a-f:.]+$/i.test(client)) headers.set('X-Forwarded-For', client);
    headers.set('X-Forwarded-Proto', 'https');
    headers.set('X-Forwarded-Host', url.host);
    // The binding pins the tunnel, loopback address and port. Request data can
    // never select another host, subnet, URL scheme, or Cloudflare service.
    const target = new URL(url.pathname + url.search, 'http://assignment.internal');
    try {
      const upstream = new Request(target, { method: request.method, headers, redirect: 'manual',
        ...(!['GET', 'HEAD'].includes(request.method) ? { body: request.body, duplex: 'half' } : {}) });
      return await env.ASSIGNMENT_API.fetch(upstream);
    } catch {
      return errorResponse(503, '서버 연결을 복구하고 있습니다. 잠시 후 다시 시도해주세요.', origin);
    }
  }
};
