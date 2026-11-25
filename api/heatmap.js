// Vanta's own homepage only. The private Sites service token stays server-side.
// This endpoint is a narrow collector, never a general proxy or data-read API.
import { createHash, randomBytes } from 'node:crypto';

const ORIGIN = 'https://www.vantastudio.dk';
const SITE_ID = 'vh_147f00e02bb84d1e9104179eedaafcbe';
const UPSTREAM = 'https://vanta-heatmap-studio.huhuhkjihih.chatgpt.site/api/collect';
const MAX_BODY = 262144;
const WINDOW_MS = 60000;
const CLIENT_LIMIT = 120;
const INSTANCE_LIMIT = 1200;
const MAX_CLIENTS = 2048;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const KEYS = {
  envelope: new Set(['siteId', 'consent', 'session']),
  session: new Set(['id', 'revision', 'version', 'device', 'page', 'startedAt', 'width', 'height', 'pageHeight', 'maxScroll', 'events', 'sections']),
  event: new Set(['type', 'x', 'y', 't', 'target', 'section', 'rx', 'ry']),
  section: new Set(['id', 'label', 'top', 'bottom', 'visibleMs']),
};

class Invalid extends Error {
  constructor(status = 400) { super('Rejected'); this.status = status; }
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Invalid();
  if (Object.keys(value).some(key => !keys.has(key))) throw new Invalid();
  return value;
}
function number(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Invalid();
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Invalid();
  return value;
}
function header(req, name) {
  const value = req.headers?.[name];
  return typeof value === 'string' ? value : '';
}
function normalize(input, now) {
  const envelope = record(input, KEYS.envelope);
  if (envelope.siteId !== SITE_ID || envelope.consent !== true) throw new Invalid();
  const s = record(envelope.session, KEYS.session);
  if (typeof s.id !== 'string' || !/^[A-Za-z0-9_-]{12,100}$/.test(s.id)) throw new Invalid();
  if (s.page !== '/' || s.version !== 'a') throw new Invalid();
  if (s.device !== 'desktop' && s.device !== 'mobile') throw new Invalid();
  const width = number(s.width, 100, 10000);
  const height = number(s.height, 100, 10000);
  if ((width < 768) !== (s.device === 'mobile')) throw new Invalid();
  const revision = number(s.revision, 1, 1000000);
  if (!Number.isInteger(revision)) throw new Invalid();
  if (!Array.isArray(s.events) || s.events.length > 2000 || !Array.isArray(s.sections) || s.sections.length > 100) throw new Invalid();
  const events = s.events.map(value => {
    const e = record(value, KEYS.event);
    if (!['click', 'move', 'dead'].includes(e.type)) throw new Invalid();
    const event = { type: e.type, x: number(e.x, 0, 1), y: number(e.y, 0, 1), t: number(e.t, 0, 1800000) };
    if (e.target !== undefined) event.target = identifier(e.target);
    if (e.section !== undefined) event.section = identifier(e.section);
    if (e.rx !== undefined) event.rx = number(e.rx, 0, 1);
    if (e.ry !== undefined) event.ry = number(e.ry, 0, 1);
    return event;
  });
  const ids = new Set();
  const sections = s.sections.map(value => {
    const section = record(value, KEYS.section);
    const id = identifier(section.id);
    if (ids.has(id)) throw new Invalid();
    ids.add(id);
    const top = number(section.top, 0, 1);
    return { id, label: id, top, bottom: number(section.bottom, top, 1), visibleMs: number(section.visibleMs, 0, 1800000) };
  });
  return { siteId: SITE_ID, consent: true, session: {
    id: s.id, revision, version: 'a', device: s.device, page: '/',
    startedAt: number(s.startedAt, now - 30 * 86400000, now + 60000),
    width, height, pageHeight: number(s.pageHeight, height, 200000),
    maxScroll: number(s.maxScroll, 0, 1), events, sections,
  } };
}

async function readBody(req) {
  const length = header(req, 'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new Invalid(413);
  const encoding = header(req, 'content-encoding').toLowerCase();
  if (encoding && encoding !== 'identity') throw new Invalid(415);
  const contentType = header(req, 'content-type').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'text/plain' && contentType !== 'application/json') throw new Invalid(415);
  // Vercel's standard Node helpers expose text/plain as a string and JSON as
  // an object. The getter itself can throw for malformed JSON.
  let body;
  try { body = req.body; } catch { throw new Invalid(); }
  if (body === undefined && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY) throw new Invalid(413);
      chunks.push(bytes);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY) throw new Invalid(413);
    try { return JSON.parse(body); } catch { throw new Invalid(); }
  }
  let encoded;
  try { encoded = JSON.stringify(body); } catch { throw new Invalid(); }
  if (typeof encoded !== 'string') throw new Invalid();
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BODY) throw new Invalid(413);
  return body;
}

/** Dependency injection permits security checks without real secrets/network. */
export function createHeatmapHandler({ fetchImpl = (...args) => fetch(...args), env = process.env, now = Date.now } = {}) {
  const clients = new Map();
  const salt = randomBytes(16);
  let instance = { expires: 0, count: 0 };
  function limited(req, time) {
    if (time >= instance.expires) instance = { expires: time + WINDOW_MS, count: 0 };
    if (++instance.count > INSTANCE_LIMIT) return true;
    for (const [key, value] of clients) if (time >= value.expires) clients.delete(key);
    // Ephemeral salted digests support abuse control; no IP is stored or logged.
    // These counters are instance-local, not a distributed rate-limit guarantee.
    const address = (header(req, 'x-vercel-forwarded-for') || header(req, 'x-forwarded-for')).split(',', 1)[0].trim().slice(0, 100) || req.socket?.remoteAddress || 'unknown';
    const key = createHash('sha256').update(salt).update(address).digest('hex');
    let counter = clients.get(key);
    if (!counter) {
      if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value);
      counter = { expires: time + WINDOW_MS, count: 0 };
      clients.set(key, counter);
    }
    return ++counter.count > CLIENT_LIMIT;
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reject = status => res.status(status).json({ ok: false });
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reject(405); }
    if (header(req, 'origin') !== ORIGIN) return reject(403);
    const fetchSite = header(req, 'sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin') return reject(403);
    const secret = env.VANTA_HEATMAP_SERVICE_TOKEN;
    if (typeof secret !== 'string' || !secret.trim() || /[\r\n]/.test(secret)) return reject(503);
    const time = now();
    if (limited(req, time)) { res.setHeader('Retry-After', '60'); return reject(429); }
    let payload;
    try { payload = normalize(await readBody(req), time); }
    catch (error) { return reject(error instanceof Invalid ? error.status : 400); }
    try {
      const response = await fetchImpl(UPSTREAM, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: {
          'Content-Type': 'text/plain',
          Origin: ORIGIN,
          'OAI-Sites-Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify(payload),
      });
      // Never relay upstream headers, cookies, redirects, HTML or error bodies.
      if (response.status === 202) return res.status(202).json({ accepted: true });
      if (response.status === 429) { res.setHeader('Retry-After', '60'); return reject(429); }
      return reject(502);
    } catch { return reject(502); }
  };
}

export default createHeatmapHandler();
