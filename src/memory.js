import { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
const months = 'january february march april may june july august september october november december'.split(' ');
const monthNames = months.flatMap(name => [name, name.slice(0, 3)]).join('|');
const explicitDate = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${monthNames})(?:,?\s+(\d{4}))?\b|\b(${monthNames})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`);
const weekdays = 'sunday monday tuesday wednesday thursday friday saturday'.split(' ');
const stop = new Set('about answer ask asked best change changed changes check compare could did does from have last list monday tuesday wednesday thursday friday saturday sunday please previous price pricing remember said say since still tell than that them then there they this today tool tools update updates was were what when which with would yesterday your'.split(' '));

export function localDate(now, timezone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function dateReference(text, today) {
  const query = text.toLowerCase();
  const anchor = Date.parse(today);
  const dayName = /\b(?:(last|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(query);
  const relative = /\b(yesterday|today|aaj)\b/.exec(query);
  const explicit = explicitDate.exec(query);
  const iso = /\b\d{4}-\d{2}-\d{2}\b/.exec(query);

  if (iso && validDay(iso[0])) return iso[0];
  if (explicit) {
    const month = months.findIndex(name => [name, name.slice(0, 3)].includes(explicit[2] ?? explicit[4]));
    if (month >= 0) {
      const year = explicit[3] ?? explicit[6];
      const day = Number(explicit[1] ?? explicit[5]);
      const suffix = `-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      let result = (year ?? today.slice(0, 4)) + suffix;
      if (!year && result > today) result = Number(today.slice(0, 4)) - 1 + suffix;
      if (validDay(result)) return result;
    }
  }
  if (dayName) {
    const current = new Date(anchor).getUTCDay();
    const target = weekdays.indexOf(dayName[2]);
    // A named weekday without a modifier means the most recent occurrence.
    let ago = (current - target + 7) % 7;
    if (dayName[1] === 'last') ago = (current + 6) % 7 + 7 - (target + 6) % 7;
    if (dayName[1] === 'this') ago = (current + 6) % 7 - (target + 6) % 7;
    return new Date(anchor - ago * DAY).toISOString().slice(0, 10);
  }
  if (relative) return new Date(anchor - (relative[1] === 'yesterday' ? DAY : 0)).toISOString().slice(0, 10);
  return null;
}

function validDay(day) {
  const timestamp = Date.parse(day);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day;
}

function terms(text) {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter(word => !stop.has(word) && !/^\d+$/.test(word)).slice(0, 24);
}

export function createMemory(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY, session TEXT NOT NULL, thread TEXT NOT NULL,
      at TEXT NOT NULL, day TEXT NOT NULL, question TEXT NOT NULL,
      answer TEXT NOT NULL, citations TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_thread ON turns(session, thread, id);
    CREATE INDEX IF NOT EXISTS turns_day ON turns(session, day, id);
    CREATE VIRTUAL TABLE IF NOT EXISTS turn_search USING fts5(
      question, answer, content='turns', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS index_turn AFTER INSERT ON turns BEGIN
      INSERT INTO turn_search(rowid, question, answer) VALUES (new.id, new.question, new.answer);
    END;
  `);
  const insert = db.prepare('INSERT INTO turns(session,thread,at,day,question,answer,citations) VALUES(?,?,?,?,?,?,?)');
  const recent = db.prepare('SELECT * FROM turns WHERE session=? AND thread=? ORDER BY id DESC LIMIT 8');
  const dated = db.prepare('SELECT * FROM turns WHERE session=? AND day=? ORDER BY id DESC LIMIT 17');
  const search = db.prepare(`
    SELECT t.* FROM turn_search JOIN turns t ON t.id=turn_search.rowid
    WHERE turn_search MATCH ? AND t.session=? ORDER BY bm25(turn_search, 5, 1), t.id DESC LIMIT 12
  `);
  const threads = db.prepare(`
    SELECT t.thread, substr(t.question, 1, 80) AS title FROM turns t
    JOIN (SELECT min(id) AS first, max(id) AS latest FROM turns
          WHERE session=? GROUP BY thread ORDER BY latest DESC LIMIT 100) g ON t.id=g.first
    ORDER BY g.latest DESC
  `);
  const transcript = db.prepare('SELECT * FROM turns WHERE session=? AND thread=? ORDER BY id');

  return {
    save({ session, thread, at, day, question, answer, citations }) {
      insert.run(session, thread, at, day, question, answer, JSON.stringify(citations));
    },
    threads: session => threads.all(session),
    transcript: (session, thread) => transcript.all(session, thread).map(row => ({
      question: row.question, answer: row.answer, citations: JSON.parse(row.citations),
    })),
    recall(session, thread, question, today) {
      const recallIntent = /\b(we|our|earlier|previous|remember|shortlisted|since|aaj|puch[ah]?a|pooch[ah]?a|yaad|pehle|still correct|last time|your (?:answer|recommendation)|i (?:ask|asked|mention|mentioned)|you (?:said|told|recommended|suggested))\b/i.test(question);
      const requestedDay = recallIntent ? dateReference(question, today) : null;
      const sameThread = recent.all(session, thread);
      const onDay = requestedDay ? dated.all(session, requestedDay) : [];
      const keywords = terms(question);
      const lexical = keywords.length && recallIntent
        ? search.all(keywords.map(word => `"${word}"`).join(' OR '), session) : [];
      const seen = new Set();
      let budget = 36_000;
      const records = [];
      for (const row of [...onDay.slice(0, 16), ...sameThread, ...lexical]) {
        if (seen.has(row.id) || budget < 500) continue;
        seen.add(row.id);
        const question = excerpt(row.question, Math.min(4_000, Math.floor(budget / 2)));
        const answer = excerpt(row.answer, Math.min(4_000, budget - question.length));
        budget -= question.length + answer.length + 150;
        const priorSources = [...new Set(JSON.parse(row.citations).map(citation => citation.url))]
          .slice(0, 4).map(url => url.slice(0, 300));
        budget -= priorSources.join('').length;
        records.push({ day: row.day, at: row.at, sameThread: row.thread === thread, question, answer, priorSources });
      }
      return {
        requestedDay,
        dateMatches: onDay.length,
        dateResultsTruncated: onDay.length > records.filter(row => row.day === requestedDay).length,
        records,
      };
    },
    close: () => db.close(),
  };
}

function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const first = Math.floor(limit * 0.7);
  return text.slice(0, first) + '\n[excerpt shortened]\n' + text.slice(-(limit - first));
}
