import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/dompurify.js';

const byId = id => document.getElementById(id);
const messages = byId('messages');
const transcript = byId('transcript');
const question = byId('question');
const status = byId('status');
const send = byId('send');
const stop = byId('stop');
const threadList = byId('threads');
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
let thread = sessionStorage.getItem('minimi-thread') || crypto.randomUUID();
let active;
let view = 0;

function message(role, text) {
  byId('welcome').hidden = true;
  const element = document.createElement('article');
  element.className = 'message ' + role;
  element.setAttribute('aria-label', role === 'user' ? 'You' : 'Assistant');
  element.textContent = text;
  messages.append(element);
  return element;
}

function renderAnswer(element, answer, citations = []) {
  const chars = Array.from(answer);
  const prefix = 'MINIMICITE' + crypto.randomUUID().replaceAll('-', '') + 'X';
  const links = [];
  const seen = new Set();
  let cursor = 0;
  let markdown = '';
  for (const { end, url, title } of [...citations].sort((a, b) => a.end - b.end)) {
    if (end < cursor || end > chars.length || !/^https?:\/\//i.test(url)) continue;
    const key = end + ' ' + url;
    if (seen.has(key)) continue;
    seen.add(key);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.className = 'cite';
    anchor.title = title;
    anchor.setAttribute('aria-label', title);
    anchor.textContent = '[' + (links.length + 1) + ']';
    markdown += chars.slice(cursor, end).join('') + prefix + links.length + 'Z';
    links.push(anchor);
    cursor = end;
  }
  markdown += chars.slice(cursor).join('');
  const safe = DOMPurify.sanitize(marked.parse(markdown), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong',
      'em', 'del', 'a', 'blockquote', 'pre', 'code', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'start'],
    ALLOW_DATA_ATTR: false,
  });
  const walker = document.createTreeWalker(safe, NodeFilter.SHOW_TEXT);
  const marker = new RegExp(prefix + '(\\d+)Z', 'g');
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    let end = 0;
    for (const match of node.data.matchAll(marker)) {
      fragment.append(node.data.slice(end, match.index));
      const anchor = links[Number(match[1])];
      // Keep citations out of a model-generated link to avoid nested anchors.
      if (anchor && !node.parentElement?.closest('a')) fragment.append(anchor);
      end = match.index + match[0].length;
    }
    if (end) {
      fragment.append(node.data.slice(end));
      node.replaceWith(fragment);
    }
  }
  for (const anchor of safe.querySelectorAll('a')) {
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    if (anchor.getAttribute('href')?.includes(prefix)) anchor.removeAttribute('href');
  }
  // An annotation can land inside Markdown syntax that doesn't survive rendering.
  const remaining = links.filter(anchor => !anchor.parentNode);
  if (remaining.length) {
    const sources = document.createElement('p');
    sources.append('Sources ', ...remaining);
    safe.append(sources);
  }
  element.classList.add('formatted');
  element.replaceChildren(safe);
}

function scrollToLatest() {
  transcript.scrollTop = transcript.scrollHeight;
}

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Request failed.');
  }
  return response;
}

async function refreshThreads() {
  const response = await request('/api/threads');
  const threads = await response.json();
  threadList.replaceChildren(...threads.map(({ thread: id, title }) => {
    const button = document.createElement('button');
    button.textContent = title;
    button.title = title;
    if (id === thread) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => loadThread(id).catch(showError));
    return button;
  }));
}

function showError(error) {
  status.textContent = error.message;
}

async function loadThread(id) {
  if (active) return;
  const version = ++view;
  thread = id;
  sessionStorage.setItem('minimi-thread', id);
  status.textContent = '';
  messages.replaceChildren();
  byId('welcome').hidden = false;
  const response = await request('/api/thread?id=' + encodeURIComponent(id));
  const turns = await response.json();
  if (version !== view) return;
  for (const turn of turns) {
    message('user', turn.question);
    renderAnswer(message('assistant', ''), turn.answer, turn.citations);
  }
  scrollToLatest();
  await refreshThreads();
}

async function* events(body) {
  let buffer = '';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

byId('new').addEventListener('click', () => {
  if (!active) loadThread(crypto.randomUUID()).catch(showError);
});

byId('example').addEventListener('click', event => {
  question.value = event.currentTarget.textContent;
  question.focus();
});
stop.addEventListener('click', () => active?.abort());
question.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    byId('composer').requestSubmit();
  }
});

byId('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text || active) return;
  view++;
  const controller = new AbortController();
  active = controller;
  send.hidden = true;
  stop.hidden = false;
  status.textContent = 'Thinking…';
  question.value = '';
  sessionStorage.setItem('minimi-thread', thread);
  const user = message('user', text);
  const reply = message('assistant', '');
  scrollToLatest();
  let completed = false;
  try {
    const response = await request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread, question: text, timezone }),
      signal: controller.signal,
    });
    for await (const event of events(response.body)) {
      const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
      if (event.type === 'status') status.textContent = event.text;
      if (event.type === 'delta') {
        status.textContent = 'Answering…';
        reply.append(event.text);
      }
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'done') {
        renderAnswer(reply, event.answer, event.citations);
        completed = true;
        break;
      }
      if (atBottom) scrollToLatest();
    }
    if (!completed) throw new Error('The connection ended early. You can send the message again.');
    status.textContent = '';
    await refreshThreads();
  } catch (error) {
    if (!completed) {
      user.remove();
      reply.remove();
      byId('welcome').hidden = messages.childElementCount > 0;
      if (!question.value) question.value = text;
    }
    showError(controller.signal.aborted ? new Error('Stopped.') : error);
  } finally {
    active = undefined;
    send.hidden = false;
    stop.hidden = true;
    question.focus();
  }
});

loadThread(thread).catch(showError);
