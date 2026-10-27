import assert from 'node:assert/strict';
import test from 'node:test';
import { POST, OPTIONS, maxDuration } from '../api/v1/chat/completions.js';
import { clientIp, handleRequest, isAllowedOrigin } from '../lib/proxy.js';

const SERVER_KEY = 'server-side-key';

function chatRequest({
  method = 'POST',
  origin,
  body,
  headers = {},
  rawBody,
} = {}) {
  const h = new Headers(headers);
  if (origin) h.set('origin', origin);
  if (body !== undefined || rawBody !== undefined) {
    if (!h.has('content-type')) h.set('content-type', 'application/json');
  }
  const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
  return new Request('https://circuit-sim-ai-proxy.vercel.app/v1/chat/completions', {
    method,
    headers: h,
    body: payload,
  });
}

function deps(fetchImpl, extra = {}) {
  return {
    fetch: fetchImpl,
    env: { GROQ_API_KEY: SERVER_KEY },
    buckets: new Map(),
    now: () => 1_700_000_000_000,
    ...extra,
  };
}

test('route module exposes POST, OPTIONS, and a 35s max duration', () => {
  assert.equal(typeof POST, 'function');
  assert.equal(typeof OPTIONS, 'function');
  assert.equal(maxDuration, 35);
});

test('origin allowlist reflects only GitHub Pages and local http', () => {
  assert.equal(isAllowedOrigin('https://darkalmas.github.io'), true);
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8080'), true);
  assert.equal(isAllowedOrigin('http://localhost'), true);
  assert.equal(isAllowedOrigin('https://localhost:5173'), false);
  assert.equal(isAllowedOrigin('https://darkalmas.github.io.evil.com'), false);
  assert.equal(isAllowedOrigin('http://darkalmas.github.io'), false);
  assert.equal(isAllowedOrigin('https://user:pass@darkalmas.github.io'), false);
  assert.equal(isAllowedOrigin('http://localhost.evil.com'), false);
});

test('OPTIONS preflight reflects an allowed origin and hides a forbidden one', async () => {
  const allowed = await handleRequest(chatRequest({
    method: 'OPTIONS',
    origin: 'https://darkalmas.github.io',
  }), deps());
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://darkalmas.github.io');
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.match(allowed.headers.get('access-control-allow-headers'), /Authorization/);

  const blocked = await handleRequest(chatRequest({
    method: 'OPTIONS',
    origin: 'https://evil.example',
  }), deps());
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
});

test('forwards a chat completion with the server key and the default model', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const response = await handleRequest(chatRequest({
    origin: 'http://127.0.0.1:5500',
    headers: { Authorization: 'Bearer client-pasted-key' },
    body: {
      temperature: 0.2,
      messages: [{ role: 'user', content: 'ping' }],
    },
  }), deps(fetchImpl));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5500');
  const payload = JSON.parse(await response.text());
  assert.equal(payload.choices[0].message.content, 'ok');
  assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, `Bearer ${SERVER_KEY}`);
  assert.equal(captured.init.redirect, 'manual');
  const forwarded = JSON.parse(captured.init.body);
  assert.equal(forwarded.model, 'openai/gpt-oss-20b');
  assert.equal(forwarded.stream, false);
  assert.equal(forwarded.temperature, 0.2);
  assert.deepEqual(forwarded.messages, [{ role: 'user', content: 'ping' }]);
  assert.equal(JSON.stringify(captured).includes('client-pasted-key'), false);
});

test('keeps an explicit model and allows curl with no Origin', async () => {
  let captured;
  const fetchImpl = async (_url, init) => {
    captured = init;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const response = await handleRequest(chatRequest({
    body: { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] },
  }), deps(fetchImpl));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(JSON.parse(captured.body).model, 'llama-3.3-70b-versatile');
});

test('refuses streaming, a missing key, and a forbidden browser origin', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('should not be called');
  };
  const stream = await handleRequest(chatRequest({
    body: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
  }), deps(fetchImpl));
  assert.equal(stream.status, 400);
  assert.match((await stream.json()).error.message, /stream/i);

  const missing = await handleRequest(chatRequest({
    body: { messages: [{ role: 'user', content: 'hi' }] },
  }), deps(fetchImpl, { env: {} }));
  assert.equal(missing.status, 503);
  assert.equal((await missing.text()).includes(SERVER_KEY), false);

  const blank = await handleRequest(chatRequest({
    body: { messages: [{ role: 'user', content: 'hi' }] },
  }), deps(fetchImpl, { env: { GROQ_API_KEY: '   ' } }));
  assert.equal(blank.status, 503);

  const forbidden = await handleRequest(chatRequest({
    origin: 'https://evil.example',
    body: { messages: [{ role: 'user', content: 'hi' }] },
  }), deps(fetchImpl));
  assert.equal(forbidden.status, 403);
  assert.equal(calls, 0);
});

test('caps body size and rejects invalid JSON', async () => {
  const huge = await handleRequest(chatRequest({
    rawBody: `{"messages":"${'x'.repeat(MAX_OVER)}"}`,
  }), deps(async () => {
    throw new Error('should not be called');
  }));
  assert.equal(huge.status, 413);

  const bad = await handleRequest(chatRequest({ rawBody: '{not json' }), deps());
  assert.equal(bad.status, 400);
});

const MAX_OVER = 100 * 1024;

test('rate limit returns 429 with Retry-After on the 21st request', async () => {
  const buckets = new Map();
  const now = 1_700_000_000_000;
  const fetchImpl = async () => new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const base = deps(fetchImpl, { buckets, now: () => now });
  for (let i = 0; i < 20; i += 1) {
    const response = await handleRequest(chatRequest({
      headers: { 'x-real-ip': '203.0.113.9' },
      body: { messages: [{ role: 'user', content: 'hi' }] },
    }), base);
    assert.equal(response.status, 200);
  }
  const blocked = await handleRequest(chatRequest({
    headers: { 'x-real-ip': '203.0.113.9' },
    body: { messages: [{ role: 'user', content: 'hi' }] },
  }), base);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '600');

  const other = await handleRequest(chatRequest({
    headers: { 'x-real-ip': '203.0.113.10' },
    body: { messages: [{ role: 'user', content: 'hi' }] },
  }), base);
  assert.equal(other.status, 200);
});

test('does not echo the server key when upstream fails or times out', async () => {
  const leaked = await handleRequest(chatRequest({
    body: { messages: [{ role: 'user', content: 'hi' }] },
  }), deps(async () => {
    throw Object.assign(new Error(`connect failed for Bearer ${SERVER_KEY}`), { name: 'TypeError' });
  }));
  assert.equal(leaked.status, 502);
  assert.equal((await leaked.text()).includes(SERVER_KEY), false);

  const timedOut = await handleRequest(chatRequest({
    body: { messages: [{ role: 'user', content: 'hi' }] },
  }), deps(async () => {
    throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  }));
  assert.equal(timedOut.status, 504);
});

test('refuses upstream redirects and forwards Groq status plus Retry-After', async () => {
  const redirect = await handleRequest(chatRequest({
    body: { messages: [{ role: 'user', content: 'hi' }] },
  }), deps(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } })));
  assert.equal(redirect.status, 502);

  const limited = await handleRequest(chatRequest({
    body: { messages: [{ role: 'user', content: 'hi' }] },
  }), deps(async () => new Response('{"error":{"message":"slow down"}}', {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '7' },
  })));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '7');
});

test('client IP prefers x-real-ip', () => {
  const request = new Request('https://example.test', {
    headers: {
      'x-real-ip': '198.51.100.4',
      'x-forwarded-for': '203.0.113.1, 198.51.100.4',
    },
  });
  assert.equal(clientIp(request), '198.51.100.4');
});
