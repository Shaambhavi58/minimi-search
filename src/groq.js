import { setTimeout as delay } from 'node:timers/promises';
import { instructions } from './agent.js';

const searchTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Find public web sources for current facts. Use focused queries and search multiple vendors in parallel.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        domains: {
          type: 'array', items: { type: 'string' },
          description: 'Known official vendor domains. Set these when official sources are requested.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

async function search(call, key, signal, fetcher) {
  let query;
  let domains;
  try {
    const args = JSON.parse(call.function.arguments);
    query = args.query?.trim();
    domains = Array.isArray(args.domains)
      ? args.domains.filter(value => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value)).slice(0, 3)
      : [];
  } catch {
    return { error: 'Expected a search query.' };
  }
  if (call.function.name !== 'web_search' || !query || query.length > 400) {
    return { error: 'Expected a web_search query of at most 400 characters.' };
  }
  const response = await fetcher('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, search_depth: 'basic', max_results: 3, ...(domains.length ? { include_domains: domains } : {}) }),
    signal,
  });
  if (!response.ok) return { error: `Web search returned HTTP ${response.status}.` };
  const data = await response.json();
  return { results: (data.results ?? []).slice(0, 3) };
}

export async function runGroq({ context, apiKey, searchKey, signal, emit, fetcher = fetch }) {
  if (!searchKey) throw new Error('Set TAVILY_API_KEY in .env to enable verified web citations.');
  const { question, memory, today, timezone, model } = context;
  const messages = [
    { role: 'system', content: instructions +
      '\nReply in English to English prompts and in Roman-script Hinglish to Hinglish prompts. ' +
      'For official-source requests, restrict searches to known vendor domains. ' +
      'Place a source marker immediately after each sourced claim, outside any bold or link syntax. ' +
      'Example format: The plan costs **$25/month** [S1]. Use only IDs from the supplied evidence. ' +
      'The app renders those IDs as clickable links. Do not write raw URLs or a sources list. ' +
      'If search fails, say which facts you could not verify.' },
    { role: 'system', content: JSON.stringify({
      today, timezone, ...memory,
      records: memory.records.slice(0, 8).map(record => ({
        ...record, question: record.question.slice(0, 500), answer: (record.answer ?? '').slice(0, 1200),
      })),
    }) },
    { role: 'user', content: question },
  ];
  const sources = new Map();
  const searches = new Map();
  let remaining = 8;
  let uncitedDraft;
  for (let round = 0; round < 4; round++) {
    const request = () => fetcher('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages, reasoning_effort: 'low', max_completion_tokens: 1600,
        ...(uncitedDraft ? { response_format: { type: 'json_object' } } : {}),
        ...(round < 2 && remaining > 0 && !uncitedDraft ? { tools: [searchTool], tool_choice: 'auto' } : {}),
      }),
      signal,
    });
    let response = await request();
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const seconds = Number(retryAfter);
      if (retryAfter !== null && seconds >= 0 && seconds <= 12) {
        emit('status', { text: 'Waiting for Groq’s rate limit to reset…' });
        await response.body?.cancel();
        await delay(Math.max(250, Math.ceil(seconds * 1000)), undefined, { signal });
        response = await request();
      }
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('Groq rejected the API key. Check GROQ_API_KEY in .env.');
      if (response.status === 429) {
        if (uncitedDraft) return uncitedSearchResult(sources);
        const reset = response.headers.get('retry-after');
        const wait = reset && /^\d+(?:\.\d+)?$/.test(reset)
          ? `Retry in ${Math.ceil(Number(reset))} seconds.`
          : 'Check the reset time on your Groq Limits page.';
        throw new Error('Groq rate limit reached. ' + wait);
      }
      throw new Error(`Groq returned HTTP ${response.status}. Check your project and model settings.`);
    }
    const { choices } = await response.json();
    const choice = choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('Groq reached its response limit. Try a narrower question.');
    const message = choice?.message;
    const calls = message?.tool_calls;
    if (!calls?.length) {
      if (!message?.content?.trim()) throw new Error('Groq returned an empty answer. Try again.');
      if (uncitedDraft) return renderVerifiedClaims(message.content, sources);
      const result = attachSources(message.content, sources);
      if (!sources.size || result.citations.length) return result;
      if (uncitedDraft || round === 3) return uncitedSearchResult(sources);
      uncitedDraft = message.content;
      messages.push(
        { role: 'assistant', content: uncitedDraft },
        { role: 'user', content: 'Revise your previous answer in the same language using the search evidence above. Return a JSON object shaped like {"claims":[{"text":"Pro costs **$25 per month**.","sourceIds":["S1"]}]}. Each text must be a short supported claim. Use only source IDs from the evidence and prefer official sources. Put no citations or URLs in text. Return an empty claims array if evidence is insufficient.' },
      );
      continue;
    }

    emit('status', { text: 'Searching the web…' });
    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
    const results = await Promise.allSettled(calls.map(call => {
      const args = call.function.arguments;
      if (searches.has(args)) return searches.get(args);
      if (remaining <= 0) return { error: 'Search budget exhausted.' };
      remaining--;
      const pending = search(call, searchKey, signal, fetcher);
      searches.set(args, pending);
      return pending;
    }));
    if (signal?.aborted) throw signal.reason;
    for (const [index, result] of results.entries()) {
      const data = result.status === 'fulfilled' ? result.value : { error: 'Web search was unavailable.' };
      const evidence = data.results?.flatMap(item => {
        let url;
        try { url = new URL(item.url); } catch { return []; }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
        const title = String(item.title || url.hostname).slice(0, 200);
        const id = 'S' + (sources.size + 1);
        sources.set(id, { url: url.href, title });
        return [{ id, title, url: url.href, content: String(item.content ?? '').slice(0, 800) }];
      });
      messages.push({ role: 'tool', tool_call_id: calls[index].id, content: JSON.stringify(evidence ?? data) });
    }
  }
  throw new Error('Groq did not complete the answer. Try a narrower question.');
}

function attachSources(text, sources) {
  let answer = '';
  let cursor = 0;
  const citations = [];
  const references = /[ \t]*\[(S\d+)\]|[【〖][^】〗\n]*[】〗]/g;
  for (const match of text.matchAll(references)) {
    answer += text.slice(cursor, match.index);
    const source = sources.get(match[1]);
    if (source) citations.push({ ...source, end: Array.from(answer).length });
    cursor = match.index + match[0].length;
  }
  answer += text.slice(cursor);
  return { answer, citations };
}

function renderVerifiedClaims(content, sources) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch {
    return uncitedSearchResult(sources);
  }
  if (!Array.isArray(payload?.claims)) return uncitedSearchResult(sources);
  let answer = '';
  const citations = [];
  for (const claim of payload.claims) {
    if (typeof claim?.text !== 'string' || !claim.text.trim() || !Array.isArray(claim.sourceIds)) continue;
    const matches = [...new Set(claim.sourceIds)].map(id => sources.get(id)).filter(Boolean);
    if (!matches.length) continue;
    if (answer) answer += '\n\n';
    const text = claim.text.trim();
    const punctuation = text.match(/[.!?]$/)?.[0] ?? '';
    answer += punctuation ? text.slice(0, -1) : text;
    const end = Array.from(answer).length;
    citations.push(...matches.map(source => ({ ...source, end })));
    answer += punctuation;
  }
  return citations.length ? { answer, citations } : uncitedSearchResult(sources);
}

function uncitedSearchResult(sources) {
  const answer = 'I found sources, but could not link a verified claim to them.\n\nSources retrieved';
  const end = Array.from(answer).length;
  return { answer, citations: [...sources.values()].map(source => ({ ...source, end })) };
}
