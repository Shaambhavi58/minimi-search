import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemory, dateReference, localDate } from '../src/memory.js';

test('resolves local days, year rollover and both forms of a named date', () => {
  const now = new Date('2026-11-12T20:30:00Z');
  assert.equal(localDate(now, 'Asia/Kolkata'), '2026-11-13');
  assert.equal(localDate(now, 'America/Los_Angeles'), '2026-11-12');
  const today = '2026-11-12';
  assert.equal(dateReference('On Monday we shortlisted 5 CRM tools', today), '2026-11-09');
  assert.equal(dateReference('Last Tuesday I asked about Postgres hosting', today), '2026-11-03');
  assert.equal(dateReference('What did I ask you on 3 November? Is your answer still correct today?', today), '2026-11-03');
  assert.equal(dateReference('What did I ask on Nov 3, 2026?', today), '2026-11-03');
  assert.equal(dateReference('What did I ask on 31 December?', today), '2025-12-31');
  assert.equal(dateReference('What did I ask on 2026-02-30?', today), null);
});

test('recovers the full shortlist and answer from another chat on the requested day', t => {
  const memory = createMemory(':memory:');
  t.after(memory.close);
  const answer = 'HubSpot, Pipedrive, Zoho CRM, Freshsales and Close';
  memory.save({
    session: 'alice', thread: 'crm', at: '2026-11-09T12:00:00Z', day: '2026-11-09',
    question: 'Shortlist five CRM tools for a 20-person sales team.', answer, citations: [],
  });
  memory.save({
    session: 'alice', thread: 'crm', at: '2026-11-10T12:00:00Z', day: '2026-11-10',
    question: 'Thanks', answer: 'Happy to help.', citations: [],
  });
  const question = 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?';
  const result = memory.recall('alice', 'new', question, '2026-11-12');
  assert.equal(result.dateMatches, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].answer, answer);
  assert.equal(memory.threads('alice')[0].title, 'Shortlist five CRM tools for a 20-person sales team.');
  assert.equal(memory.transcript('alice', 'crm').length, 2);
  assert.deepEqual(memory.recall('bob', 'new', question, '2026-11-12').records, []);
  assert.deepEqual(memory.transcript('bob', 'crm'), []);
});

test('retains multiple topics for a date and retrieves a topical match without a date', t => {
  const memory = createMemory(':memory:');
  t.after(memory.close);
  for (const topic of ['Postgres hosting', 'Keyboards']) {
    memory.save({
      session: 'alice', thread: topic, day: '2026-11-03', at: '2026-11-03T11:00:00Z',
      question: topic, answer: 'Prior answer', citations: [],
    });
  }
  const recall = question => memory.recall('alice', 'new', question, '2026-11-12');
  assert.equal(recall('What did I ask you on 3 November?').dateMatches, 2);
  assert.equal(recall('Has Postgres hosting changed since we compared it?').records[0].question, 'Postgres hosting');
  assert.equal(recall('What did I ask you yesterday?').dateMatches, 0);
});
