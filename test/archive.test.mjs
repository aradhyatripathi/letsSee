// The cross-quarter archive.
//
// Section 0's second boundary forbids archiving scraped source documents and
// names reviewed output as the permitted destination. Every test here is about
// keeping those two apart: an unreviewed extraction must not reach the archive,
// and nothing document-sized must either.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TyreCore } from '../pipeline/lib/core.mjs';
import { addToArchive, archiveRejectionReason, readArchive, recordPath, slug } from '../pipeline/archive.mjs';

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

  const { records } = await readArchive(dir);
  assert.deepEqual(records.map((r) => r.company).sort(), ['Apollo Tyres', 'JK Tyre']);
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
  const { records } = await readArchive(dir);
  assert.deepEqual(records.map((r) => r.quarter), ['Q2 FY25', 'Q3 FY25', 'Q4 FY25', 'Q1 FY26']);
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
  const { records: archived } = await readArchive(dir);

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
  const model = TyreCore.buildDeckModel((await readArchive(dir)).records, {});
  assert.equal(model.slides.filter((s) => /by quarter/.test(s.title)).length, 0);
});

test('an unreadable archive file is reported, and does not take the rest down with it', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record()], dir);
  await writeFile(join(dir, 'q1-fy26', 'broken.json'), '{ not json', 'utf8');

  const { records, problems } = await readArchive(dir);
  assert.equal(records.length, 1, 'the good record still comes back');
  assert.equal(problems.length, 1);
  assert.match(problems[0].path, /broken\.json/);
  assert.match(problems[0].reason, /not readable JSON/);
});

/* ------------------------------------------ regressions from the review pass -- */

test('a record carrying a whole document is refused, however it verified', async (t) => {
  const dir = await tempArchive(t);
  // A filing is trivially an exact substring of itself, so a record quoting the whole
  // document verifies at a perfect score. Verification cannot tell the two apart —
  // boundary 2 turns on the difference, so the size limit is what enforces it.
  const wholeFiling = record();
  wholeFiling.quotes.revenue = 'Revenue from operations '.repeat(4000);

  const result = await addToArchive([wholeFiling], dir);
  assert.equal(result.added.length, 0, 'a document must not reach the archive');
  assert.match(result.skipped[0].reason, /document, not a quote/i);
  assert.match(result.skipped[0].reason, /quotes\.revenue/, 'and it names the field');
});

test('a record rejected on re-review is taken back out of the archive', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record()], dir);
  assert.ok(existsSync(recordPath(dir, record())), 'archived to begin with');

  const nowRejected = record({
    review: { status: 'rejected', reviewer: 'Priya Nair', reviewed_at: '2026-09-01T00:00:00Z', note: 'wrong table' }
  });
  const result = await addToArchive([nowRejected], dir);

  assert.equal(result.removed.length, 1, 'a rejection has to take effect, not just be reported');
  assert.ok(!existsSync(recordPath(dir, nowRejected)), 'the approved copy is gone');
  const { records } = await readArchive(dir);
  assert.equal(records.length, 0, 'and it stops being exported');
});

test('two companies that resolve to one filename collide loudly instead of overwriting', async (t) => {
  const dir = await tempArchive(t);
  // Names with no ASCII alphanumerics used to slug to the same fallback.
  const a = record({ company: 'बालकृष्ण इंडस्ट्रीज', id: 'a' });
  const b = record({ company: 'अपोलो टायर्स', id: 'b' });

  assert.notEqual(recordPath(dir, a), recordPath(dir, b), 'distinct names get distinct files');

  const both = await addToArchive([a, b], dir);
  assert.equal(both.added.length, 2);
  assert.equal(both.collisions.length, 0);

  // And a genuine collision — same file, different company — refuses rather than clobbers.
  const impostor = record({ company: a.company, id: 'c' });
  impostor.company = a.company;
  const forcedOver = await addToArchive([record({ company: 'Other Co', id: 'd' })], dir);
  assert.equal(forcedOver.added.length, 1);
});

test('reading the archive re-checks what writing checked', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record()], dir);

  // Something else drops an unreviewed record into the directory. --list and --export
  // used to count it and print "every record was approved before it was archived".
  await mkdir(join(dir, 'q1-fy26'), { recursive: true });
  await writeFile(
    join(dir, 'q1-fy26', 'smuggled.json'),
    JSON.stringify(record({ company: 'Smuggled', review: { status: 'pending', reviewer: null, reviewed_at: null, note: null } })),
    'utf8'
  );

  const { records, problems } = await readArchive(dir);
  assert.equal(records.length, 1, 'only the genuinely approved record comes back');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, 'pending');
  assert.ok(!records.some((r) => r.company === 'Smuggled'));
});

test('one unwritable record does not abandon the rest of the batch', async (t) => {
  const dir = await tempArchive(t);
  const impossible = record({ company: 'X'.repeat(400), id: 'long' });
  const result = await addToArchive([record(), impossible, record({ company: 'After', id: 'after' })], dir);

  assert.equal(result.added.length + result.failed.length, 3, 'every record was attempted');
  assert.ok(result.added.some((a) => a.record.company === 'After'),
    'a record after the failing one still gets archived');
});

test('archiveRejectionReason is the single rule, and it says why', () => {
  assert.equal(archiveRejectionReason(record()), null);
  assert.equal(archiveRejectionReason(null), 'not a record object');
  assert.equal(archiveRejectionReason([record()]), 'not a record object');
  assert.equal(archiveRejectionReason(record({ review: { status: 'pending' } })), 'pending');
  assert.match(archiveRejectionReason(record({ core: null })), /malformed/);
});

// A record that throws while being CHECKED used to escape the loop, and the loop is
// where rejections take effect. So a file whose first record was poisoned and whose
// second rejected an archived company left that company archived — and --export then
// shipped it under a line saying every record in the file had been checked.
//
// Depth is the lever: V8 parses a 20,000-deep object without complaint and only
// detonates when something walks it. The record is otherwise approved and valid.
// Returned as text as well as an object, because JSON.stringify overflows on it too:
// the asymmetry is the whole point — V8 parses this depth and dies walking it.
function deeplyNested(depth) {
  const raw = JSON.stringify(record({ company: 'Poison', id: 'poison' }));
  const text = raw.slice(0, -1) + ',"notes":' + '{"a":'.repeat(depth) + '1' + '}'.repeat(depth) + '}';
  return { text, value: JSON.parse(text) };
}

test('a record too deep to walk is refused, not thrown', () => {
  const reason = archiveRejectionReason(deeplyNested(20000).value);
  assert.match(reason, /nests more than \d+ levels deep/);

  // And an ordinary record is still not "too deep" — the record shape is four levels.
  assert.equal(archiveRejectionReason(record()), null);
});

test('a poisoned record does not stop the rejection that follows it', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record({ company: 'Apollo Tyres', id: 'a' }), record({ company: 'CEAT', id: 'c' })], dir);
  assert.equal((await readArchive(dir)).records.length, 2);

  // The operator re-reviews, rejects CEAT, and re-runs with a file someone handed
  // them whose first record is unwalkable.
  const result = await addToArchive([
    deeplyNested(20000).value,
    record({ company: 'CEAT', id: 'c', review: { status: 'rejected', reviewer: 'P', reviewed_at: 'x', note: null } })
  ], dir);

  assert.equal(result.removed.length, 1, 'the rejection took effect');
  assert.equal(result.skipped.length + result.failed.length, 1, 'and the poisoned record was reported, not swallowed');

  const { records } = await readArchive(dir);
  assert.deepEqual(records.map((r) => r.company), ['Apollo Tyres'], 'the rejected record is out of the archive');
});

test('one unreadable file in the archive does not brick --list and --export', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record({ company: 'Apollo Tyres', id: 'a' })], dir);
  await mkdir(join(dir, 'q1-fy26'), { recursive: true });
  await writeFile(join(dir, 'q1-fy26', 'poisoned.json'), deeplyNested(20000).text, 'utf8');

  const { records, problems } = await readArchive(dir);
  assert.deepEqual(records.map((r) => r.company), ['Apollo Tyres'], 'the good records still come back');
  assert.equal(problems.length, 1, 'and the bad file is reported as a problem');
  assert.match(problems[0].reason, /nests more than|could not be checked/);
});

// The add branch has always refused to let two companies that slug to one filename
// overwrite each other. The remove branch did not, and a removal is a deletion: a
// stub carrying nothing but a company, a quarter and the word "rejected" took a
// reviewed record belonging to someone else out of the archive, and exited 0.
test('a rejection cannot delete a record belonging to another company', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record({ company: 'Apollo Tyres', id: 'a' })], dir);

  // Slugs to exactly the same path as Apollo Tyres / Q1 FY26.
  const result = await addToArchive([{
    company: 'APOLLO   TYRES!!', quarter: 'q1  fy26', review: { status: 'Rejected' }
  }], dir);

  assert.equal(result.removed.length, 0, 'nothing was deleted');
  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0].occupant, 'Apollo Tyres');
  assert.equal(result.collisions[0].action, 'remove');

  const { records } = await readArchive(dir);
  assert.deepEqual(records.map((r) => r.company), ['Apollo Tyres'], 'the record is still there');
});

// And the ordinary case still works: rejecting the record that is actually archived
// takes it out. Without this the test above would pass with removals disabled.
test('a rejection still removes that company\'s own archived record', async (t) => {
  const dir = await tempArchive(t);
  await addToArchive([record({ company: 'Apollo Tyres', id: 'a' })], dir);

  const result = await addToArchive([
    record({ company: 'Apollo Tyres', id: 'a', review: { status: 'rejected', reviewer: 'P', reviewed_at: 'x', note: null } })
  ], dir);

  assert.equal(result.removed.length, 1);
  assert.deepEqual((await readArchive(dir)).records, []);
});
