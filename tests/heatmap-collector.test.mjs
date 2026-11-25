import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeatmapHandler } from '../api/heatmap.js';

const ORIGIN = 'https://www.vantastudio.dk';
const SITE = 'vh_147f00e02bb84d1e9104179eedaafcbe';
const NOW = 1806150000000;
const env = { VANTA_HEATMAP_SERVICE_TOKEN: 'fake-test-service-token' };
function fixture() {
  return { siteId: SITE, consent: true, session: {
    id: 'test-session-123456', revision: 1, version: 'a', device: 'desktop', page: '/', startedAt: NOW - 5000,
    width: 1440, height: 900, pageHeight: 4000, maxScroll: .55,
    events: [{ type: 'click', x: .25, y: .2, t: 400, target: 'contact-cta', section: 'hero', rx: .5, ry: .5 }],
    sections: [{ id: 'hero', label: 'Ignored arbitrary section text', top: 0, bottom: .3, visibleMs: 2000 }],
  } };
}
function request(body = fixture(), patch = {}) {
  return { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }, body: typeof body === 'string' ? body : JSON.stringify(body), socket: { remoteAddress: '192.0.2.1' }, ...patch };
}
async function call(handler, req = request()) {
  const res = { code: 0, headers: {}, body: undefined, setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler(req, res);
  return res;
}
function setup(options = {}) {
  const forwarded = [];
  const handler = createHeatmapHandler({ env, now: () => NOW, fetchImpl: async (...args) => { forwarded.push(args); return { status: 202 }; }, ...options });
  return { handler, forwarded };
}

test('forwards a minimized consented homepage session to one fixed private endpoint', async () => {
  const { handler, forwarded } = setup();
  const req = request();
  req.headers.cookie = 'visitor-cookie=private';
  req.headers.authorization = 'visitor-secret';
  req.headers['oai-sites-authorization'] = 'attacker-override';
  const res = await call(handler, req);
  assert.equal(res.code, 202); assert.deepEqual(res.body, { accepted: true });
  const [url, options] = forwarded[0];
  assert.equal(url, 'https://vanta-heatmap-studio.huhuhkjihih.chatgpt.site/api/collect');
  assert.equal(options.redirect, 'manual');
  assert.deepEqual(Object.keys(options.headers).sort(), ['Content-Type', 'OAI-Sites-Authorization', 'Origin']);
  assert.equal(options.headers['OAI-Sites-Authorization'], `Bearer ${env.VANTA_HEATMAP_SERVICE_TOKEN}`);
  assert.equal(options.headers.Origin, ORIGIN);
  const body = JSON.parse(options.body);
  assert.equal(body.siteId, SITE);
  assert.equal(body.session.sections[0].label, 'hero');
  assert.equal(options.body.includes('Ignored arbitrary'), false);
  assert.equal(JSON.stringify(res).includes(env.VANTA_HEATMAP_SERVICE_TOKEN), false);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('rejects every non-POST method without exposing configuration', async () => {
  const { handler, forwarded } = setup({ env: {} });
  for (const method of ['GET', 'OPTIONS', 'PUT', 'DELETE']) assert.equal((await call(handler, request(undefined, { method }))).code, 405);
  assert.equal(forwarded.length, 0);
});

test('rejects missing/null/foreign/apex origins and cross-site browser requests', async () => {
  const { handler, forwarded } = setup();
  for (const origin of ['', 'null', 'https://vantastudio.dk', 'https://attacker.test', [ORIGIN, ORIGIN]]) {
    assert.equal((await call(handler, request(fixture(), { headers: { origin, 'content-type': 'text/plain' } }))).code, 403);
  }
  assert.equal((await call(handler, request(fixture(), { headers: { origin: ORIGIN, 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' } }))).code, 403);
  assert.equal(forwarded.length, 0);
});

test('requires explicit consent, fixed site, homepage and version a', async () => {
  const { handler, forwarded } = setup();
  for (const mutate of [x => { x.consent = false; }, x => { x.siteId = 'vh_another_site'; }, x => { x.session.page = '/private?email=person@example.test'; }, x => { x.session.version = 'b'; }]) {
    const data = fixture(); mutate(data);
    assert.equal((await call(handler, request(data))).code, 400);
  }
  assert.equal(forwarded.length, 0);
});

test('rejects unknown potentially sensitive fields at every payload level', async () => {
  const { handler, forwarded } = setup();
  for (const mutate of [x => { x.email = 'person@example.test'; }, x => { x.session.ip = '192.0.2.2'; }, x => { x.session.events[0].value = 'private input'; }, x => { x.session.sections[0].text = 'private text'; }]) {
    const data = fixture(); mutate(data);
    assert.equal((await call(handler, request(data))).code, 400);
  }
  assert.equal(forwarded.length, 0);
});

test('validates finite coordinates, safe IDs, timestamps, revision and coherent viewport', async () => {
  const { handler, forwarded } = setup();
  for (const mutate of [x => { x.session.events[0].x = 1.1; }, x => { x.session.events[0].y = null; }, x => { x.session.events[0].target = '#private input'; }, x => { x.session.startedAt = NOW + 120000; }, x => { x.session.revision = 1.2; }, x => { x.session.device = 'mobile'; }, x => { x.session.sections[0].bottom = -.1; }]) {
    const data = fixture(); mutate(data);
    assert.equal((await call(handler, request(data))).code, 400);
  }
  assert.equal(forwarded.length, 0);
});

test('enforces event caps and request byte limits even without Content-Length', async () => {
  const { handler, forwarded } = setup();
  const data = fixture(); data.session.events = Array.from({ length: 2001 }, () => data.session.events[0]);
  assert.equal((await call(handler, request(data))).code, 400);
  assert.equal((await call(handler, request('x'.repeat(262145)))).code, 413);
  const req = request(); req.headers['content-length'] = '262145';
  assert.equal((await call(handler, req)).code, 413);
  assert.equal(forwarded.length, 0);
});

test('rejects malformed JSON, compressed bodies and unsupported media', async () => {
  const { handler, forwarded } = setup();
  assert.equal((await call(handler, request('{broken json'))).code, 400);
  assert.equal((await call(handler, request(fixture(), { headers: { origin: ORIGIN, 'content-type': 'text/plain', 'content-encoding': 'gzip' } }))).code, 415);
  assert.equal((await call(handler, request(fixture(), { headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } }))).code, 415);
  assert.equal(forwarded.length, 0);
});

test('accepts Vercel parsed JSON and handles malformed-body getters safely', async () => {
  const { handler, forwarded } = setup();
  assert.equal((await call(handler, request(fixture(), { body: fixture(), headers: { origin: ORIGIN, 'content-type': 'application/json' } }))).code, 202);
  const req = request(); Object.defineProperty(req, 'body', { get() { throw Error('private parsing detail'); } });
  const res = await call(handler, req);
  assert.equal(res.code, 400); assert.deepEqual(res.body, { ok: false });
  assert.equal(forwarded.length, 1);
});

test('raw streamed request is bounded and produces the same validated payload', async () => {
  const { handler, forwarded } = setup();
  const raw = JSON.stringify(fixture());
  const req = request(undefined, { body: undefined, async *[Symbol.asyncIterator]() { yield Buffer.from(raw.slice(0, 40)); yield Buffer.from(raw.slice(40)); } });
  assert.equal((await call(handler, req)).code, 202);
  const large = request(undefined, { body: undefined, async *[Symbol.asyncIterator]() { yield Buffer.alloc(200000); yield Buffer.alloc(100000); } });
  assert.equal((await call(handler, large)).code, 413);
  assert.equal(forwarded.length, 1);
});

test('missing or malformed server secret causes no network or credential disclosure', async () => {
  for (const token of [undefined, '', '\ninvalid']) {
    const { handler, forwarded } = setup({ env: { VANTA_HEATMAP_SERVICE_TOKEN: token } });
    const res = await call(handler);
    assert.equal(res.code, 503); assert.deepEqual(res.body, { ok: false });
    assert.equal(forwarded.length, 0);
  }
});

test('upstream redirects, failures, bodies and cookies never reach the visitor', async () => {
  for (const status of [302, 401, 403, 500]) {
    let read = false;
    const { handler } = setup({ fetchImpl: async () => ({ status, headers: { 'Set-Cookie': 'private', Location: 'https://signin.test' }, text() { read = true; return 'private upstream body'; } }) });
    const res = await call(handler);
    assert.equal(res.code, 502); assert.deepEqual(res.body, { ok: false }); assert.equal(read, false);
    assert.equal(res.headers.location, undefined); assert.equal(res.headers['set-cookie'], undefined);
  }
  const { handler } = setup({ fetchImpl: async () => { throw Error('private upstream or token detail'); } });
  assert.equal((await call(handler)).code, 502);
});

test('upstream throttling is generic and retryable', async () => {
  const { handler } = setup({ fetchImpl: async () => ({ status: 429 }) });
  const res = await call(handler);
  assert.equal(res.code, 429); assert.equal(res.headers['retry-after'], '60'); assert.deepEqual(res.body, { ok: false });
});

test('instance-local client throttle limits repeated posts and resets after its window', async () => {
  let time = NOW;
  const { handler, forwarded } = setup({ now: () => time });
  for (let i = 0; i < 120; i++) assert.equal((await call(handler)).code, 202);
  const blocked = await call(handler);
  assert.equal(blocked.code, 429); assert.equal(blocked.headers['retry-after'], '60');
  assert.equal(forwarded.length, 120);
  time += 60001;
  assert.equal((await call(handler)).code, 202);
});

test('instance-wide throttle applies even when client addresses vary', async () => {
  const { handler, forwarded } = setup();
  for (let i = 0; i < 1200; i++) {
    const req = request(); req.headers['x-vercel-forwarded-for'] = `test-client-${i}`;
    assert.equal((await call(handler, req)).code, 202);
  }
  const req = request(); req.headers['x-vercel-forwarded-for'] = 'another-client';
  assert.equal((await call(handler, req)).code, 429);
  assert.equal(forwarded.length, 1200);
});
