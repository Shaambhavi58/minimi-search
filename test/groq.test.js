import test from 'node:test';
import assert from 'node:assert/strict';
import { runGroq } from '../src/groq.js';

test('Groq references resolve to search URLs, and invented or opaque IDs disappear', async () => {
  const url = 'https://neon.com/pricing';
  let modelCalls = 0;
  const result = await runGroq({
    context: {
      question: 'Has pricing changed?',
      memory: { records: [{ question: 'Compare Neon and Supabase' }] },
      today: '2026-11-14', timezone: 'Asia/Kolkata', model: 'openai/gpt-oss-120b',
    },
    apiKey: 'test-groq-key',
    searchKey: 'test-search-key',
    emit: () => {},
    fetcher: async (endpoint, options) => {
      const body = JSON.parse(options.body);
      if (new URL(endpoint).hostname === 'api.tavily.com') {
        assert.equal(options.headers.Authorization, 'Bearer test-search-key');
        assert.equal(body.query, 'Neon pricing');
        return Response.json({ results: [{ url, title: 'Neon pricing', content: 'Plan details' }] });
      }
      assert.equal(options.headers.Authorization, 'Bearer test-groq-key');
      if (modelCalls++ === 0) {
        assert.deepEqual(body.tools.map(tool => tool.function.name), ['web_search']);
        assert.match(body.messages[1].content, /Compare Neon and Supabase/);
        return Response.json({ choices: [{ message: { tool_calls: [{
          id: 'search', type: 'function', function: { name: 'web_search', arguments: '{"query":"Neon pricing"}' },
        }] } }] });
      }
      assert.equal(JSON.parse(body.messages.at(-1).content)[0].id, 'S1');
      return Response.json({ choices: [{ message: { content: 'Plan details. [S1] [S99]【1†L32-L33】' } }] });
    },
  });
  assert.equal(result.answer, 'Plan details.');
  assert.deepEqual(result.citations, [{ url, title: 'Neon pricing', end: 13 }]);
});
