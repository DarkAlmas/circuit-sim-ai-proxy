/**
 * OpenAI-compatible chat proxy. The Groq key is read from the environment
 * only at request time and is never logged or copied from the client.
 *
 * The rate-limit map lives in this instance. Fluid Compute can run several
 * instances, and a cold start clears the map, so the limit is best-effort.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const MAX_BODY_BYTES = 100 * 1024;
const MAX_UPSTREAM_BYTES = 1024 * 1024;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_MESSAGES = 64;
const MODEL_RE = /^[A-Za-z0-9._:@+/-]{1,64}$/;
const GITHUB_PAGES_ORIGIN = 'https://darkalmas.github.io';

const sharedBuckets = new Map();
const textEncoder = new TextEncoder();

export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 200) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  if (url.origin !== origin) return false;
  if (origin === GITHUB_PAGES_ORIGIN) return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

export function clientIp(request) {
  return firstIp(request.headers.get('x-real-ip'))
    || firstIp(request.headers.get('x-vercel-forwarded-for'))
    || firstIp(request.headers.get('x-forwarded-for'))
    || 'unknown';
}

export async function handleRequest(request, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const nowFn = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const buckets = deps.buckets ?? sharedBuckets;
  const origin = request.headers.get('origin');

  if (origin && !isAllowedOrigin(origin)) {
    return json(403, errorBody('Origin is not allowed.', 'access_denied'), { Vary: 'Origin' });
  }

  const cors = corsHeaders(origin);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (method !== 'POST') {
    return json(405, errorBody('Method not allowed.', 'invalid_request_error'), {
      ...cors,
      Allow: 'POST, OPTIONS',
    });
  }

  const limit = takeToken(buckets, clientIp(request), nowFn());
  if (!limit.ok) {
    return json(429, errorBody('Too many requests. Try again later.', 'rate_limit_error'), {
      ...cors,
      'Retry-After': String(limit.retryAfter),
    });
  }

  const apiKey = typeof env.GROQ_API_KEY === 'string' ? env.GROQ_API_KEY.trim() : '';
  if (!apiKey) {
    return json(503, errorBody('GROQ_API_KEY is not configured.', 'server_error'), cors);
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json(413, errorBody('Request body exceeds 100KB.', 'invalid_request_error'), cors);
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return json(415, errorBody('Content-Type must be application/json.', 'invalid_request_error'), cors);
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return json(400, errorBody('Could not read the request body.', 'invalid_request_error'), cors);
  }
  if (textEncoder.encode(raw).byteLength > MAX_BODY_BYTES) {
    return json(413, errorBody('Request body exceeds 100KB.', 'invalid_request_error'), cors);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, errorBody('Request body is not valid JSON.', 'invalid_request_error'), cors);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, errorBody('Request body must be a JSON object.', 'invalid_request_error'), cors);
  }

  if (Object.hasOwn(body, 'stream') && body.stream !== false) {
    return json(400, errorBody(
      'Streaming is not supported. Send the request with "stream": false.',
      'invalid_request_error',
    ), cors);
  }

  const model = body.model == null || body.model === '' ? DEFAULT_MODEL : body.model;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) {
    return json(400, errorBody('Invalid model.', 'invalid_request_error'), cors);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    return json(400, errorBody(
      'messages must be a non-empty array of at most 64 items.',
      'invalid_request_error',
    ), cors);
  }
  if (body.messages.some((message) => !message || typeof message !== 'object' || Array.isArray(message))) {
    return json(400, errorBody('Each message must be an object.', 'invalid_request_error'), cors);
  }

  const payload = { ...body, model, stream: false };
  let upstream;
  try {
    upstream = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return json(
      timedOut ? 504 : 502,
      errorBody(timedOut ? 'Upstream timed out.' : 'Upstream request failed.', 'server_error'),
      cors,
    );
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, errorBody('Upstream redirect was refused.', 'server_error'), cors);
  }

  const upstreamLength = Number(upstream.headers.get('content-length') || 0);
  if (Number.isFinite(upstreamLength) && upstreamLength > MAX_UPSTREAM_BYTES) {
    return json(502, errorBody('Upstream response is too large.', 'server_error'), cors);
  }

  let text;
  try {
    text = await upstream.text();
  } catch {
    return json(502, errorBody('Could not read the upstream response.', 'server_error'), cors);
  }
  if (textEncoder.encode(text).byteLength > MAX_UPSTREAM_BYTES) {
    return json(502, errorBody('Upstream response is too large.', 'server_error'), cors);
  }

  const headers = {
    ...cors,
    'Cache-Control': 'no-store',
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
  };
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) headers['Retry-After'] = retryAfter;
  return new Response(text, { status: upstream.status, headers });
}

function firstIp(value) {
  if (!value) return '';
  const ip = value.split(',')[0].trim();
  if (!ip || ip.length > 128) return '';
  return ip;
}

function corsHeaders(origin) {
  const headers = {
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (!origin || !isAllowedOrigin(origin)) return headers;
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
  headers['Access-Control-Expose-Headers'] = 'Retry-After';
  headers['Access-Control-Max-Age'] = '86400';
  return headers;
}

function errorBody(message, type) {
  return { error: { message, type } };
}

function json(status, payload, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function takeToken(buckets, ip, now) {
  if (buckets.size > 2000) pruneBuckets(buckets, now);
  let hits = buckets.get(ip);
  if (!hits) {
    hits = [];
    buckets.set(ip, hits);
  }
  const windowStart = now - WINDOW_MS;
  while (hits.length > 0 && hits[0] <= windowStart) hits.shift();
  if (hits.length >= MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((hits[0] + WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter };
  }
  hits.push(now);
  return { ok: true };
}

function pruneBuckets(buckets, now) {
  const windowStart = now - WINDOW_MS;
  for (const [ip, hits] of buckets) {
    while (hits.length > 0 && hits[0] <= windowStart) hits.shift();
    if (hits.length === 0) buckets.delete(ip);
  }
  while (buckets.size > 5000) {
    const oldest = buckets.keys().next().value;
    buckets.delete(oldest);
  }
}
