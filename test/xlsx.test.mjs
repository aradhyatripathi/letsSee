// The Excel workbook — the build spec's primary output artefact (Section 5).
//
// It is written here rather than by a library, because it was the one output that did not
// work without a network: SheetJS came from a CDN, so on a machine behind a corporate
// proxy the Export button disabled itself and the main deliverable was simply absent.
//
// The tests read the package back rather than trusting the writer, because a spreadsheet
// reader that meets a malformed part does not report an error — it opens the file and
// silently drops content, which in a workbook whose whole claim is traceability is the
// worst possible failure.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TyreCore } from '../pipeline/lib/core.mjs';
import { TyreXlsx } from '../pipeline/lib/xlsx.mjs';
import { assertContentTypesCover, assertPackageWellFormed, assertRelationshipsResolve, sheetNamed, unzip } from './ooxml-helpers.mjs';

function record(over = {}) {
  const base = {
    id: 'r-' + (over.company || 'x'),
    company: 'CEAT',
    quarter: 'Q1 FY26',
    source: 'fixture:q1-fy26/ceat.txt',
    currency: { code: 'INR', unit: 'Crore', fx_to_inr: 1 },
    core: Object.fromEntries(TyreCore.CORE_KEYS.map((k, i) => [k, 100 + i])),
    quotes: Object.fromEntries(TyreCore.CORE_KEYS.map((k) => [k, `the span supporting ${k}`])),
    segments: { channels: { replacement: 60, oem: 30, export: 10 }, product_categories: { TBR: 40, TBB: 10, PCR: 30, '2W': 15, OHT: 5 } },
    outlook: { commentary: 'Steady demand.', rm_trend: 'Rubber eased.', capex: 'On track.' },
    review: { status: 'approved', reviewer: 'Priya Nair', reviewed_at: '2026-08-25T09:00:00Z', note: null },
    verification: { ok: true, checked: 21, verified: 21, failed: 0, unquoted: 0, checks: [] }
  };
  return { ...base, ...over };
}

const approved = (company) => record({ company, id: 'a-' + company });
const pending = (company) => record({
  company, id: 'p-' + company,
  review: { status: 'pending', reviewer: null, reviewed_at: null, note: null }
});

const build = (records, opts) => unzip(TyreXlsx.writeXlsx(TyreCore.buildWorkbookModel(records, opts)));

test('the package is one a spreadsheet reader can open', () => {
  const files = build([approved('CEAT'), approved('MRF')], {});

  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) {
    assert.ok(files.has(required), `missing ${required}`);
  }
  assertPackageWellFormed(files);
  assertRelationshipsResolve(files);
  assertContentTypesCover(files);

  // Every sheet the model declared is a part, and the workbook names them all.
  const workbook = files.get('xl/workbook.xml');
  const model = TyreCore.buildWorkbookModel([approved('CEAT')], {});
  for (const sheet of model.sheets) {
    const escaped = sheet.name.replace(/&/g, '&amp;');
    assert.ok(workbook.includes(`name="${escaped}"`), `${sheet.name} is not listed in the workbook`);
  }
  assert.equal([...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length, model.sheets.length);
});

test('numbers stay numbers and text stays text', () => {
  const files = build([approved('CEAT')], {});
  const sheet = sheetNamed(files, 'Core Financials');

  // A figure has to be a number, or the spreadsheet cannot sum or chart it.
  assert.match(sheet, /<c r="G2" s="\d+"><v>100<\/v><\/c>/, 'revenue is a numeric cell');
  // And a label has to be text.
  assert.match(sheet, /<c r="A2"[^>]*t="inlineStr"><is><t[^>]*>CEAT<\/t><\/is><\/c>/);
  assert.match(sheet, /NOT REVIEWED|Approved by Priya Nair/);
});

test('an unreported figure is the em dash, never a zero', () => {
  const sparse = TyreCore.recToStoredShape({
    company: 'Sparse Co',
    quarter: 'Q1 FY26',
    currency: { code: 'INR', unit: 'Crore' },
    core: { revenue: 100 },
    core_quotes: { revenue: 'Revenue from operations 100.00' }
  }, { source: 'fixture:sparse.txt' });
  sparse.review = { status: 'approved', reviewer: 'P', reviewed_at: 'x', note: null };

  const sheet = sheetNamed(build([sparse], {}), 'Core Financials');
  assert.match(sheet, /<t[^>]*>—<\/t>/, 'unreported figures render as the em dash');
  assert.ok(!/<v>0<\/v>/.test(sheet), 'and never as a zero');
});

test('every cell comment carries its quote and lands on the right cell', () => {
  const model = TyreCore.buildWorkbookModel([approved('CEAT'), approved('MRF')], {});
  const files = build([approved('CEAT'), approved('MRF')], {});

  assert.ok(model.comments.length > 20, 'the fixtures produce a real number of comments');
  // Numbered per sheet, so the part's name follows Core Financials' position rather
  // than being fixed — the same reason the sheets themselves are looked up by name.
  const commentsPart = [...files.keys()].find((n) => /^xl\/comments\d+\.xml$/.test(n));
  const comments = files.get(commentsPart);
  assert.ok(comments, 'the comments part exists');
  assert.ok([...files.keys()].some((n) => /^xl\/drawings\/vmlDrawing\d+\.vml$/.test(n)),
    'and the shape part a reader wants alongside it');

  for (const comment of model.comments) {
    assert.ok(comments.includes(`ref="${comment.addr}"`), `no comment on ${comment.addr}`);
  }
  assert.equal((comments.match(/<comment /g) || []).length, model.comments.length);

  // The quote itself is in the file, which is the entire point of the workbook.
  const sample = model.comments.find((c) => c.text.includes('the span supporting revenue'));
  assert.ok(sample, 'a revenue comment exists');
  assert.ok(comments.includes('the span supporting revenue'), 'and its quote is in the part');

  // The sheet must point at the drawing, or the notes are invisible.
  assert.match(sheetNamed(files, 'Core Financials'), /<legacyDrawing r:id="rIdVml"\/>/);
});

test('column widths and the frozen header survive', () => {
  const files = build([approved('CEAT')], {});
  const sheet = sheetNamed(files, 'Core Financials');
  const model = TyreCore.buildWorkbookModel([approved('CEAT')], {});
  assert.equal((sheet.match(/<col /g) || []).length, model.sheets.find((sh) => sh.name === 'Core Financials').widths.length);
  assert.match(sheet, /<pane[^>]*state="frozen"/, 'the header row stays put when scrolling');
});

test('a sheet name Excel would reject is made safe, and duplicates are separated', () => {
  assert.equal(TyreXlsx.sheetName('Sources & Quotes', 0), 'Sources & Quotes');
  assert.equal(TyreXlsx.sheetName('a/b:c*d?e[f]g', 0), 'a b c d e f g');
  assert.equal(TyreXlsx.sheetName('', 3), 'Sheet4');
  assert.equal(TyreXlsx.sheetName('x'.repeat(60), 0).length, 31);

  const parts = TyreXlsx.buildXlsxParts({
    sheets: [{ name: 'Same', aoa: [['a']] }, { name: 'same', aoa: [['b']] }],
    comments: []
  });
  const workbook = parts.find((p) => p.name === 'xl/workbook.xml').data;
  const names = [...workbook.matchAll(/name="([^"]+)"/g)].map((m) => m[1].toLowerCase());
  assert.equal(new Set(names).size, names.length, 'two sheets sharing a name make a file Excel refuses to open');
});

test('a company name full of XML metacharacters cannot break the package', () => {
  const nasty = 'A & B <Tyres> "Ltd" ' + '￿';
  const files = build([approved(nasty)], {});
  assertPackageWellFormed(files);

  const sheet = sheetNamed(files, 'Core Financials');
  assert.match(sheet, /A &amp; B &lt;Tyres&gt;/, 'the name survives, escaped');
  assert.ok(!sheet.includes('￿'), 'and the character XML cannot carry is gone');
});

test('the same model writes the same bytes twice', () => {
  const model = TyreCore.buildWorkbookModel([approved('CEAT'), pending('MRF')], {});
  assert.deepEqual(TyreXlsx.writeXlsx(model), TyreXlsx.writeXlsx(model));
});

test('a model with no sheets is refused rather than written', () => {
  assert.throws(() => TyreXlsx.writeXlsx({ sheets: [] }), /no sheets/);
});

test('recordsToXlsx goes from records to bytes in one call, and obeys the review filter', () => {
  const bytes = TyreXlsx.recordsToXlsx([approved('CEAT'), pending('MRF')], { reviewedOnly: true });
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'it is a ZIP');

  const sheet = sheetNamed(unzip(bytes), 'Core Financials');
  assert.match(sheet, /CEAT/);
  assert.ok(!sheet.includes('MRF'), 'an unapproved record is not in an approved-only workbook');
});

test('the workbook needs no library — only the shared ZIP writer', async () => {
  // The dashboard used to load SheetJS from a CDN for this. If that import ever comes
  // back, the primary deliverable stops working on a machine that cannot reach it.
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../dashboard/tyre_comparison_dashboard.html', import.meta.url), 'utf8');
  // Narrowed to an actual import: the prose in this file mentions SheetJS by name to
  // explain why it is gone, and matching that would make the assertion unfalsifiable.
  const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    scriptSrcs.filter((u) => /xlsx|sheetjs|spreadsheet/i.test(u)),
    [],
    'the dashboard no longer pulls a spreadsheet library'
  );
  assert.ok(!/\bXLSX\.(utils|writeFile|write)\b/.test(html), 'and no longer calls one');
  assert.match(html, /TyreXlsx\.writeXlsx\(model\)/, 'it writes the workbook itself');
});

// Excel's hard limit is 32,767 characters in a cell. Past it, it does not refuse the
// file — it opens it, says it repaired unreadable content, and drops what it did not
// like. Records are bounded where they are stored as well; this is the last line
// before bytes, and a format guarantee should not depend on an upstream step running.
test('no cell is longer than Excel will accept', () => {
  const long = 'the group continues to expand capacity. '.repeat(12000);
  assert.ok(long.length > 400000);

  assert.ok(TyreXlsx.clip(long).length <= TyreXlsx.MAX_CELL_CHARS);
  assert.match(TyreXlsx.clip(long), /…\[clipped]$/, 'and a reader can tell it was cut');
  assert.equal(TyreXlsx.clip('short'), 'short', 'anything that fits is untouched');

  // Written straight into a model, so the writer's own clip is what is under test.
  // Going through recToStoredShape would not exercise it: records are bounded at
  // 4,000 characters upstream, so the cell limit would never be reached and this
  // would pass with the writer's clip deleted.
  const files = unzip(TyreXlsx.writeXlsx({
    sheets: [{ name: 'Outlook', aoa: [['Company', 'Commentary'], ['Apollo Tyres', long]] }],
    comments: [{ sheet: 'Outlook', addr: 'B2', text: long }]
  }));

  for (const [name, xml] of files) {
    if (!name.startsWith('xl/worksheets/') && name !== 'xl/comments1.xml') continue;
    for (const [, text] of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
      assert.ok(text.length <= TyreXlsx.MAX_CELL_CHARS + 200, `a cell in ${name} holds ${text.length} characters`);
    }
  }
  assert.match(sheetNamed(files, 'Outlook'), /…\[clipped]<\/t>/, 'the sheet cell says it was cut');
  assert.match(files.get('xl/comments1.xml'), /…\[clipped]<\/t>/, 'and so does the comment');
});

// The record store is bounded too, so a document never becomes a record in the first
// place — and the clip leaves a marker, which means a quote clipped to fit is no
// longer a verbatim span and still fails verification rather than passing as its own
// prefix.
test('a record cannot carry a document in a string field', () => {
  const long = 'x'.repeat(500000);
  const rec = TyreCore.recToStoredShape({
    company: 'Apollo Tyres', quarter: 'Q1 FY26', currency: { code: 'INR', unit: 'Crore' },
    core: { revenue: 6500 }, core_quotes: { revenue: long },
    outlook: { commentary: long, rm_trend: '', capex: '' }
  }, { source: 'x.pdf' });

  assert.ok(rec.quotes.revenue.length <= TyreCore.MAX_STORED_STRING_CHARS);
  assert.ok(rec.outlook.commentary.length <= TyreCore.MAX_STORED_STRING_CHARS);
  assert.match(rec.quotes.revenue, /…\[clipped]$/);

  const v = TyreCore.verifyQuotes(rec, long);
  assert.equal(v.checks[0].status, 'quote_too_long', 'the clipped quote is still not a citation');
});

// Every other sheet carries a figure with a quote behind it and a Verification column.
// The Outlook sheet is free text nobody checked, and a reader moving between sheets
// should not have to know which of them the checking applies to.
test('the Outlook sheet says its columns are unverified', () => {
  const model = TyreCore.buildWorkbookModel([approved('CEAT')], {});
  const outlook = model.sheets.find((s) => s.name === 'Outlook');
  for (const heading of outlook.aoa[0].slice(2)) {
    assert.match(heading, /\(unverified\)$/, `"${heading}" does not say it is unverified`);
  }
});
