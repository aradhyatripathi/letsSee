// The cross-quarter archive.
//
// Section 0's second boundary forbids archiving scraped source documents and
// names reviewed output as the permitted destination. Every test here is about
// keeping those two apart: an unreviewed extraction must not reach the archive,
// and nothing document-sized must either.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TyreCore } from '../pipeline/lib/core.mjs';
import { addToArchive, readArchive, recordPath, slug } from '../pipeline/archive.mjs';

function record(over = {}) {
  const base = {
    id: 'apollo_q1-fy26_abc',
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26',
    source: 'https://corporate.apollotyres.com/investors/financials/',
    retrieved_at: '2026-08-25T09:00:00Z',
    currency: { code: 'INR', unit: 'Crore', fx_to_inr: 1 },
    core: Object.fromEntries(TyreCore.CORE_KEYS.map((k, i) => [k, 100 + i])),
    quotes: Object.fromEntries(TyreCore.CORE_KEYS.map((k) => [k, `a short span supporting ${k}`])),
    segments: { channels: { replacement: 60, oem: 30, export: 10 }, product_categories: { TBR: 40, TBB: 10, PCR: 30, '2W': 15, OHT: 5 } },
    outlook: { commentary: 'Steady.', rm_trend: 'Rubber eased.', capex: 'On track.' },
    review: { status: 'approved', reviewer: 'Priya Nair', reviewed_at: '2026-08-25T09:30:00Z', note: null },
    verification: { ok: true, checked: 21, verified: 21, failed: 0, unquoted: 0, checks: [] }
  };
  return { ...base, ...over };
}

async function tempArchive(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tyre-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('only approved records are archived', async (t) => {
  const dir = await tempArchive(t);
  const result = await addToArchive([
    record(),
    record({ id: 'b', company: 'MRF', review: { status: 'pending', reviewer: null, reviewed_at: null, note: null } }),
    record({ id: 'c', company: 'CEAT', review: { status: 'rejected', reviewer: 'Priya Nair', reviewed_at: 'x', note: 'wrong table' } }),
    record({ id: 'd', company: 'JK Tyre' })
  ], dir);

  assert.equal(result.added.length, 2, 'the two approved records');
  assert.deepEqual(result.skipped.map((s) => s.reason).sort(), ['pending', 'rejected']);

  const archived = await readArchive(dir);
  assert.deepEqual(archived.map((r) => r.company).sort(), ['Apollo Tyres', 'JK Tyre']);
});

test('a record with no review at all is treated as unreviewed', async (t) => {
  const dir = await tempArchive(t);
  const bare = record();
  delete bare.review;
  const result = await addToArchive([bare], dir);
  assert.equal(result.added.length, 0);
  assert.equal(result.skipped[0].reason, 'pending');
});

test('a malformed record is refused with the reason, not written', async (t) => {
  const dir = await tempArchive(t);
  const broken = record({ core: null });
  const result = await addToArchive([broken], dir);
  assert.equal(result.added.length, 0);
  assert.match(result.skipped[0].reason, /malformed/);
});

test('re-adding the same record changes nothing', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record()], dir);
  const again = await addToArchive([record()], dir);
  assert.equal(again.added.length, 0);
  assert.equal(again.unchanged.length, 1);
});

test('a changed figure is reported and left alone unless forced', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record()], dir);

  const restated = record();
  restated.core.revenue = 9999;

  const held = await addToArchive([restated], dir);
  assert.equal(held.changed.length, 1, 'a restatement is surfaced, not applied silently');
  assert.equal(held.added.length, 0);
  const onDisk = JSON.parse(await readFile(recordPath(dir, restated), 'utf8'));
  assert.notEqual(onDisk.core.revenue, 9999, 'the archived figure is untouched');

  const forced = await addToArchive([restated], dir, { force: true });
  assert.equal(forced.added.length, 1);
  const after = JSON.parse(await readFile(recordPath(dir, restated), 'utf8'));
  assert.equal(after.core.revenue, 9999);
});

test('re-review alone does not count as a change', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record()], dir);
  const reviewedAgain = record({
    review: { status: 'approved', reviewer: 'Arjun Rao', reviewed_at: '2026-09-01T00:00:00Z', note: 'checked again' },
    retrieved_at: '2026-09-01T00:00:00Z'
  });
  const result = await addToArchive([reviewedAgain], dir);
  assert.equal(result.unchanged.length, 1, 'the figures and quotes are what identify a record, not who signed it off');
});

test('quarters read back oldest first, whatever order they arrived in', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([
    record({ quarter: 'Q1 FY26' }),
    record({ quarter: 'Q3 FY25' }),
    record({ quarter: 'Q4 FY25' }),
    record({ quarter: 'Q2 FY25' })
  ], dir);
  const archived = await readArchive(dir);
  assert.deepEqual(archived.map((r) => r.quarter), ['Q2 FY25', 'Q3 FY25', 'Q4 FY25', 'Q1 FY26']);
});

test('one file per company per quarter, named so a diff is readable', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record({ company: 'JK Tyre & Industries', quarter: 'Q1 FY26' })], dir);
  assert.ok(existsSync(join(dir, 'q1-fy26', 'jk-tyre-industries.json')));
  assert.equal(slug('JK Tyre & Industries', 'x'), 'jk-tyre-industries');
  assert.equal(slug('', 'fallback'), 'fallback');
});

test('nothing document-sized reaches the archive', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record()], dir);
  const raw = await readFile(recordPath(dir, record()), 'utf8');
  const archived = JSON.parse(raw);

  // A retrieved filing runs to tens of thousands of characters. Quotes are short
  // spans and are part of what makes a figure auditable, so they belong here; a
  // whole document does not, and this is the canary if a field ever carries one.
  const strings = [];
  (function walk(node) {
    if (typeof node === 'string') strings.push(node);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  })(archived);
  const longest = strings.reduce((n, s) => Math.max(n, s.length), 0);
  assert.ok(longest < 2000, `a string of ${longest} characters is document-sized, not a quote`);
  assert.ok(!('source_text' in archived) && !('text' in archived), 'no field carries retrieved text');
});

test('an archive spanning quarters gives the deck one comparison quarter and trend slides', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([
    record({ company: 'Apollo Tyres', quarter: 'Q4 FY25' }),
    record({ company: 'CEAT', quarter: 'Q4 FY25' }),
    record({ company: 'Apollo Tyres', quarter: 'Q1 FY26' }),
    record({ company: 'CEAT', quarter: 'Q1 FY26' })
  ], dir);
  const archived = await readArchive(dir);

  const model = TyreCore.buildDeckModel(archived, {});
  assert.equal(model.provenance.quarter, 'Q1 FY26', 'the latest quarter is the one compared');
  assert.equal(model.provenance.total, 2, 'two companies, not four rows');
  assert.deepEqual(model.provenance.archived_quarters, ['Q4 FY25', 'Q1 FY26']);

  const headline = model.slides.find((s) => s.title === 'Headline comparison');
  assert.equal(headline.rows.length, 2, 'a company appears once, not once per quarter');

  const trend = model.slides.find((s) => s.title === 'Revenue by quarter');
  assert.ok(trend, 'history earns a trend slide');
  assert.deepEqual(trend.columns, ['Company', 'Q4 FY25', 'Q1 FY26']);
  assert.equal(trend.rows.length, 2);

  const earlier = TyreCore.buildDeckModel(archived, { quarter: 'Q4 FY25' });
  assert.equal(earlier.provenance.quarter, 'Q4 FY25', 'an earlier quarter can be asked for by name');
});

test('a single-quarter set gets no trend slides', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record({ company: 'Apollo Tyres' }), record({ company: 'CEAT' })], dir);
  const model = TyreCore.buildDeckModel(await readArchive(dir), {});
  assert.equal(model.slides.filter((s) => /by quarter/.test(s.title)).length, 0);
});

test('an unreadable archive file names itself rather than failing obscurely', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record()], dir);
  await writeFile(join(dir, 'q1-fy26', 'broken.json'), '{ not json', 'utf8');
  await assert.rejects(() => readArchive(dir), /broken\.json is not readable JSON/);
});
