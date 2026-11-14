import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentRequest, runAgent } from './agent.js';
import { runGroq } from './groq.js';
import { createMemory, localDate } from './memory.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([path, [file, type]]) => [path, [readFileSync(new URL('../public/' + file, import.meta.url)), type]]));

for (const name of ['marked', 'dompurify']) {
  assets.set('/vendor/' + name + '.js', [
    readFileSync(new URL(import.meta.resolve(name))), 'text/javascript; charset=utf-8',
  ]);
}

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const originalKey = process.env.OPENAI_API_KEY?.trim();
// Accept the existing setup when a Groq key was saved under the old variable.
const groqKey = process.env.GROQ_API_KEY?.trim() || (originalKey?.startsWith('gsk_') ? originalKey : '');
const apiKey = groqKey || originalKey;
const model = groqKey
  ? process.env.GROQ_MODEL || 'openai/gpt-oss-120b'
  : process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const dataDir = process.env.DATA_DIR || '.data';
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const memory = createMemory(join(dataDir, 'chat.sqlite'));
const active = new Set();

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 65_536) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'");

  const asset = assets.get(path);
  if (req.method === 'GET' && asset && path !== '/') {
    res.writeHead(200, { 'Content-Type': asset[1] });
    return res.end(asset[0]);
  }

  if (req.method === 'POST' && req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site request rejected.' });
  let session = /(?:^|;\s*)minimi_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (!uuid.test(session ?? '')) {
    session = randomUUID();
    res.setHeader('Set-Cookie', `minimi_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
  }

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': asset[1] });
    return res.end(asset[0]);
  }
  if (req.method === 'GET' && path === '/api/threads') return json(res, 200, memory.threads(session));
  if (req.method === 'GET' && path === '/api/thread') {
    const thread = url.searchParams.get('id');
    if (!uuid.test(thread ?? '')) return json(res, 400, { error: 'Invalid chat ID.' });
    return json(res, 200, memory.transcript(session, thread));
  }
  if (req.method !== 'POST' || path !== '/api/chat') return json(res, 404, { error: 'Not found.' });
  if (!apiKey) return json(res, 503, { error: 'Set GROQ_API_KEY or OPENAI_API_KEY in .env and restart the server.' });
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return json(res, 415, { error: 'Expected application/json.' });
  }

  const body = await readJson(req);
  const { thread, timezone } = body ?? {};
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!uuid.test(thread ?? '') || !question || question.length > 16_000 || typeof timezone !== 'string' || timezone.length > 80) {
    return json(res, 400, { error: 'Expected a chat ID, time zone and a message of 1–16,000 characters.' });
  }
  const now = new Date();
  let today;
  try {
    today = localDate(now, timezone);
  } catch {
    return json(res, 400, { error: 'Invalid time zone.' });
  }

  // Serialize writes per browser so concurrent tabs see a consistent baseline.
  if (active.has(session)) return json(res, 409, { error: 'An answer is already running in this browser.' });
  const recalled = memory.recall(session, thread, question, today);
  active.add(session);
  const cancel = new AbortController();
  res.on('close', () => cancel.abort());
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(120_000)]);

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
  const emit = (type, data) => {
    if (!res.destroyed) res.write(JSON.stringify({ type, ...data }) + '\n');
  };
  emit('status', { text: 'Thinking…' });

  try {
    const context = { question, memory: recalled, today, timezone, model };
    const result = groqKey
      ? await runGroq({ context, apiKey, searchKey: process.env.TAVILY_API_KEY?.trim(), signal, emit })
      : await runAgent({ request: agentRequest(context), apiKey, signal, emit });
    if (!signal.aborted) {
      memory.save({ session, thread, at: now.toISOString(), day: today, question, ...result });
      emit('done', result);
    }
  } catch (error) {
    if (!cancel.signal.aborted) {
      const message = signal.aborted ? 'The answer timed out. Try a narrower question.' :
        error.name === 'TypeError' ? 'Could not reach the model provider. Try again.' : error.message;
      emit('error', { message });
    }
  } finally {
    active.delete(session);
    res.end();
  }
}

const port = Number(process.env.PORT || 3000);
const server = createServer((req, res) => {
  handle(req, res).catch(error => {
    if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : 'Server error.' });
    else res.end();
    if (!error.status) console.error(error.name);
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Minimi Search is running at http://localhost:${server.address().port}`);
  if (!apiKey) console.log('Copy .env.example to .env and set GROQ_API_KEY or OPENAI_API_KEY to enable chat.');
});
