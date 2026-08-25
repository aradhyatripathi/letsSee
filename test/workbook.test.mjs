// Section 5 — the four-sheet workbook model.
//
// The traceability requirement is the interesting one: every populated cell in
// "Core Financials" must lead a reader to the exact source quote for that number
// without leaving the workbook. These tests walk that path the way a reader would
// — open the cell comment, read its ref, find the ref in "Sources & Quotes" — and
// fail if any link in it is broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TyreCore } from '../pipeline/lib/core.mjs';
import { fixturePath } from '../pipeline/fixtures/index.mjs';
import { extractRecordOffline } from '../pipeline/lib/extract.mjs';

const DASH = '—';
const SHEET_ORDER = ['Core Financials', 'Segments', 'Outlook', 'Sources & Quotes'];

// Company, Quarter, Currency, Unit, Source come before the metric columns.
// Derived rather than hardcoded so adding a metadata column cannot silently
// shift what this file believes it is asserting on.
const METRIC_COLUMN_OFFSET =
  TyreCore.buildWorkbookModel([]).sheets[0].aoa[0].length - TyreCore.CORE_METRICS.length;

function fixtureRecord(id, company) {
  const result = extractRecordOffline({
    sourceText: readFileSync(fixturePath(id), 'utf8'),
    company,
    quarter: 'Q1 FY26',
    source: `fixture:${id}.txt`,
    retrievedAt: '2025-08-08T00:00:00.000Z'
  });
  assert.ok(result.ok, `fixture extraction for ${company} failed: ${result.error}`);
  return result.record;
}

/** Forward A1 addressing. The naive `String.fromCharCode(65 + col)` breaks past Z, which
 *  it now does — Core Financials carries 27 columns. */
function colName(col) {
  let s = '';
  let n = col + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Inverse of the workbook's A1 addressing, so the mapping is checked, not assumed. */
function parseAddr(addr) {
  const m = /^([A-Z]+)(\d+)$/.exec(addr);
  assert.ok(m, `unreadable cell address ${addr}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

function sheet(model, name) {
  const found = model.sheets.find((s) => s.name === name);
  assert.ok(found, `no '${name}' sheet`);
  return found;
}

const FIXTURES = [['apollo', 'Apollo Tyres'], ['ceat', 'CEAT'], ['mrf', 'MRF']];
const RECORDS = FIXTURES.map(([id, company]) => fixtureRecord(id, company));

test('the workbook has the four spec sheets in order, with the right headers', () => {
  const model = TyreCore.buildWorkbookModel(RECORDS);

  assert.deepEqual(model.sheets.map((s) => s.name), SHEET_ORDER);
  assert.equal(model.generated_for, RECORDS.length);

  assert.deepEqual(
    sheet(model, 'Core Financials').aoa[0],
    ['Company', 'Quarter', 'Review', 'Currency', 'Unit', 'Source', ...TyreCore.CORE_METRICS.map((m) => m.label)]
  );
  assert.deepEqual(
    sheet(model, 'Segments').aoa[0],
    [
      'Company',
      'Quarter',
      ...TyreCore.CHANNEL_KEYS.map((k) => `Channel: ${k}`),
      ...TyreCore.PRODUCT_KEYS.map((k) => `Product: ${k}`)
    ]
  );
  // The three text columns say (unverified) in their heading: this is the one sheet
  // no quote check applies to, and a reader moving between sheets should not have to
  // know that.
  assert.deepEqual(sheet(model, 'Outlook').aoa[0],
    ['Company', 'Quarter', 'Commentary (unverified)', 'Raw Material Trend (unverified)', 'Capex (unverified)']);
  assert.deepEqual(
    sheet(model, 'Sources & Quotes').aoa[0],
    ['Ref', 'Company', 'Quarter', 'Review', 'Metric', 'Value', 'Currency', 'Unit', 'Source Quote', 'Verification', 'Source']
  );

  for (const s of model.sheets) {
    assert.equal(s.widths.length, s.aoa[0].length, `${s.name}: a column width per column`);
  }

  const core = sheet(model, 'Core Financials');
  assert.equal(core.aoa.length, RECORDS.length + 1, 'one row per company plus the header');
  assert.deepEqual(
    core.aoa.slice(1).map((r) => r[0]),
    ['Apollo Tyres', 'CEAT', 'MRF'],
    'rows are sorted by company so two exports of the same records line up'
  );
});

test('nulls render as the em dash, never 0 and never blank', () => {
  // A record reporting revenue and nothing else: every other cell is a figure the
  // filing did not state, which is not the same thing as zero.
  const sparse = TyreCore.recToStoredShape(
    {
      company: 'Sparse Co',
      quarter: 'Q1 FY26',
      currency: { code: 'INR', unit: 'Crore' },
      core: { revenue: 100 },
      core_quotes: { revenue: 'Revenue from operations 100.00' }
    },
    { source: 'fixture:sparse.txt' }
  );

  const model = TyreCore.buildWorkbookModel([sparse]);
  const coreRow = sheet(model, 'Core Financials').aoa[1];

  assert.deepEqual(
    coreRow.slice(0, METRIC_COLUMN_OFFSET),
    ['Sparse Co', 'Q1 FY26', 'NOT REVIEWED', 'INR', 'Crore', 'fixture:sparse.txt'],
    'an unreviewed row says so in the file that circulates furthest'
  );
  TyreCore.CORE_METRICS.forEach((metric, i) => {
    const cell = coreRow[METRIC_COLUMN_OFFSET + i];
    if (metric.key === 'revenue') assert.equal(cell, 100);
    else assert.equal(cell, DASH, `${metric.label} was not reported, so it must show the em dash`);
  });

  for (const cell of sheet(model, 'Segments').aoa[1].slice(2)) assert.equal(cell, DASH);
  assert.deepEqual(sheet(model, 'Outlook').aoa[1], ['Sparse Co', 'Q1 FY26', DASH, DASH, DASH]);

  const allCells = model.sheets.flatMap((s) => s.aoa.flat());
  assert.ok(!allCells.includes(''), 'no cell is blank');
  assert.ok(!allCells.includes(null), 'no cell is null');
  assert.ok(!allCells.includes(undefined), 'no cell is undefined');
  assert.equal(allCells.filter((c) => c === 0).length, 0, 'nothing unreported became a zero');
});

test('every populated Core Financials cell traces to a real Sources & Quotes row', () => {
  const model = TyreCore.buildWorkbookModel(RECORDS);
  const core = sheet(model, 'Core Financials');
  const sources = sheet(model, 'Sources & Quotes');

  // Indices come from the header rather than being counted by hand, so adding a column
  // to the audit sheet does not silently move these assertions onto the wrong cells.
  const srcCol = Object.fromEntries(sources.aoa[0].map((name, i) => [name, i]));
  const sourceRowByRef = new Map(sources.aoa.slice(1).map((row) => [row[0], row]));
  assert.equal(sourceRowByRef.size, sources.aoa.length - 1, 'refs in Sources & Quotes are unique');

  const recordByCompany = new Map(RECORDS.map((r) => [r.company, r]));
  const metricByKey = new Map(TyreCore.CORE_METRICS.map((m) => [m.key, m]));
  const commentByAddr = new Map();

  for (const comment of model.comments) {
    assert.equal(comment.sheet, 'Core Financials');
    assert.ok(!commentByAddr.has(comment.addr), `two comments on cell ${comment.addr}`);
    commentByAddr.set(comment.addr, comment);

    const { col, row } = parseAddr(comment.addr);
    const value = core.aoa[row][col];
    assert.equal(typeof value, 'number', `the comment on ${comment.addr} should sit on a populated cell`);

    // The ref is COMPANY|QUARTER|metric_key: it must name this cell's row and
    // column. The quarter is part of the key because storage holds more than one
    // quarter as soon as anyone backfills, and a company-only key would then
    // point at two different figures.
    const lastBar = comment.ref.lastIndexOf('|');
    const metricKey = comment.ref.slice(lastBar + 1);
    const prevBar = comment.ref.lastIndexOf('|', lastBar - 1);
    const quarter = comment.ref.slice(prevBar + 1, lastBar);
    const company = comment.ref.slice(0, prevBar);
    const metric = metricByKey.get(metricKey);

    assert.ok(metric, `${comment.ref} names an unknown metric`);
    assert.equal(core.aoa[row][0], company, `${comment.addr} is not on ${company}'s row`);
    assert.equal(core.aoa[row][1], quarter, `${comment.addr} is not on ${quarter}'s row`);
    assert.equal(core.aoa[0][col], metric.label, `${comment.addr} is not in the ${metric.label} column`);

    // And it must resolve to a row of the audit sheet carrying the same number.
    const sourceRow = sourceRowByRef.get(comment.ref);
    assert.ok(sourceRow, `${comment.ref} has no row in Sources & Quotes`);
    assert.equal(sourceRow[srcCol.Company], company);
    assert.equal(sourceRow[srcCol.Metric], metric.label);
    assert.equal(sourceRow[srcCol.Value], value, 'the audit row disagrees with the cell it explains');
    assert.match(String(sourceRow[srcCol.Review]), /Approved|NOT REVIEWED/, 'the audit row states the review state');

    const stored = recordByCompany.get(company).quotes[metricKey];
    assert.equal(sourceRow[srcCol['Source Quote']], stored || DASH, 'the audit row does not carry the stored quote');
    if (stored) {
      assert.ok(comment.text.includes(stored), 'the comment shows the quote itself, not just a pointer');
    } else {
      assert.ok(/unverified/.test(comment.text), 'a figure with no stored quote is called out as unverified');
    }
  }

  // Coverage in the other direction: no populated cell is left without a comment.
  let populated = 0;
  for (let row = 1; row < core.aoa.length; row++) {
    for (let i = 0; i < TyreCore.CORE_METRICS.length; i++) {
      const col = METRIC_COLUMN_OFFSET + i;
      const value = core.aoa[row][col];
      if (value === DASH) continue;
      populated++;
      const addr = `${colName(col)}${row + 1}`;
      assert.ok(commentByAddr.has(addr), `populated cell ${addr} has no source comment`);
    }
  }
  assert.ok(populated > 30, `expected the fixtures to populate a real number of cells, got ${populated}`);
  assert.equal(model.comments.length, populated);
});

test('Sources & Quotes reports how each quote verified', () => {
  const model = TyreCore.buildWorkbookModel(RECORDS);
  const aoa = sheet(model, 'Sources & Quotes').aoa;
  const col = Object.fromEntries(aoa[0].map((name, i) => [name, i]));
  const rows = aoa.slice(1);
  const fixtureIdByCompany = new Map(FIXTURES.map(([id, company]) => [company, id]));

  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row[col.Verification], 'verified', `${row[0]} came from a verified fixture extraction`);
    assert.equal(row[col.Source], `fixture:${fixtureIdByCompany.get(row[col.Company])}.txt`, 'the audit row names the filing it came from');
  }

  // A figure the extractor reported without a quote is still listed, flagged.
  const unquoted = TyreCore.recToStoredShape(
    {
      company: 'Unquoted Co',
      quarter: 'Q1 FY26',
      currency: { code: 'INR', unit: 'Crore' },
      core: { revenue: 100 },
      core_quotes: {}
    },
    { source: 'manual' }
  );
  const flagged = TyreCore.buildWorkbookModel([unquoted]);
  const flaggedAoa = sheet(flagged, 'Sources & Quotes').aoa;
  const fcol = Object.fromEntries(flaggedAoa[0].map((name, i) => [name, i]));
  const row = flaggedAoa[1];
  assert.equal(row[0], 'Unquoted Co|Q1 FY26|revenue');
  assert.equal(row[fcol['Source Quote']], DASH);
  assert.equal(row[fcol.Verification], 'unquoted');
});

test('reviewedOnly filters to approved records', () => {
  const approved = structuredClone(RECORDS[0]);
  approved.review = { status: 'approved', reviewer: 'analyst', reviewed_at: '2025-08-09T09:00:00.000Z', note: null };
  const rejected = structuredClone(RECORDS[1]);
  rejected.review = { status: 'rejected', reviewer: 'analyst', reviewed_at: '2025-08-09T09:05:00.000Z', note: 'wrong quarter' };
  const pending = RECORDS[2];
  assert.equal(pending.review.status, 'pending');

  const model = TyreCore.buildWorkbookModel([approved, rejected, pending], { reviewedOnly: true });

  assert.equal(model.generated_for, 1);
  for (const s of model.sheets) {
    assert.deepEqual(s.aoa.slice(1).map((r) => r[s.name === 'Sources & Quotes' ? 1 : 0]).filter((v, i, a) => a.indexOf(v) === i), [
      approved.company
    ], `${s.name} shows only the approved record`);
  }
  for (const comment of model.comments) {
    assert.ok(comment.ref.startsWith(`${approved.company}|`));
  }

  // reviewedOnly narrows to positively-approved records. Turning it off widens to
  // pending ones — but never to rejected ones: a record a human looked at and
  // threw out must not travel onward in the deliverable, whatever the toggle says.
  const unfiltered = TyreCore.buildWorkbookModel([approved, rejected, pending]);
  assert.equal(unfiltered.generated_for, 2, 'reviewedOnly off adds pending records, not rejected ones');
  const companies = unfiltered.sheets[0].aoa.slice(1).map((r) => r[0]);
  assert.ok(companies.includes(approved.company) && companies.includes(pending.company));
  assert.ok(!companies.includes(rejected.company), 'a rejected record is withheld from every sheet');
  assert.ok(
    !JSON.stringify(unfiltered.sheets).includes(String(rejected.core.revenue)),
    'no figure from a rejected record reaches any sheet'
  );
});
