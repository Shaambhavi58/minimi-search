import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Mock only the upstream API. Exercise the real HTTP entry point, stream and database.
const mockProvider = `
  globalThis.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    const { records, requestedDay } = JSON.parse(request.input[1].content);
    const question = request.input.at(-1).content;
    const followUp = question.startsWith('What did I ask');
    const found = records.some(record => record.day === requestedDay && record.answer === 'Prior pricing baseline');
    const text = followUp ? (found ? 'Current price verified.' : 'No matching conversation.') : 'Prior pricing baseline';
    const output = { type: 'output_text', text, annotations: followUp && found
      ? [{ type: 'url_citation', end_index: text.length, url: 'https://example.com/pricing' }] : [] };
    const events = [
      { type: 'response.output_text.delta', delta: text },
      { type: 'response.completed', response: { output: [{ type: 'message', content: [output] }] } },
    ];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\\n\\n').join(''));
  };
  await import('./src/server.js');
`;

async function start(dataDir) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', mockProvider], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, OPENAI_API_KEY: 'offline-fixture' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  try {
    let output = '';
    for await (const chunk of child.stdout) {
      output += chunk;
      const url = output.match(/http:\/\/localhost:\d+/)?.[0];
      if (url) {
        return {
          url: url.replace('localhost', '127.0.0.1'),
          stop: async () => { child.kill(); await exited; },
        };
      }
    }
    throw new Error('Server exited before listening');
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function chat(url, cookie, thread, question) {
  const response = await fetch(url + '/api/chat', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread, question, timezone: 'UTC' }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'status');
  assert.equal(events.at(-1).type, 'done');
  return events.at(-1);
}

test('streamed chat recalls another thread after restart and isolates browser sessions', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minimi-test-'));
  let server;
  try {
    server = await start(dir);
    const page = await fetch(server.url);
    assert.match(await page.text(), /Minimi Search/);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const original = randomUUID();
    assert.equal((await chat(server.url, cookie, original, 'Compare Postgres hosting')).answer, 'Prior pricing baseline');
    await server.stop();
    server = await start(dir);

    const result = await chat(server.url, cookie, randomUUID(), 'What did I ask today about Postgres hosting? Is it still correct?');
    assert.equal(result.answer, 'Current price verified.');
    assert.equal(result.citations[0].url, 'https://example.com/pricing');
    const transcript = await fetch(server.url + '/api/thread?id=' + original, { headers: { Cookie: cookie } });
    assert.equal((await transcript.json())[0].question, 'Compare Postgres hosting');
    const privateTranscript = await fetch(server.url + '/api/thread?id=' + original);
    assert.deepEqual(await privateTranscript.json(), []);
  } finally {
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
