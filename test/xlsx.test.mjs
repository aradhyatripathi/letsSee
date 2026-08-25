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
import { assertContentTypesCover, assertPackageWellFormed, assertRelationshipsResolve, unzip } from './ooxml-helpers.mjs';

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
  const sheet = files.get('xl/worksheets/sheet1.xml');

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

  const sheet = build([sparse], {}).get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<t[^>]*>—<\/t>/, 'unreported figures render as the em dash');
  assert.ok(!/<v>0<\/v>/.test(sheet), 'and never as a zero');
});

test('every cell comment carries its quote and lands on the right cell', () => {
  const model = TyreCore.buildWorkbookModel([approved('CEAT'), approved('MRF')], {});
  const files = build([approved('CEAT'), approved('MRF')], {});

  assert.ok(model.comments.length > 20, 'the fixtures produce a real number of comments');
  const comments = files.get('xl/comments1.xml');
  assert.ok(comments, 'the comments part exists');
  assert.ok(files.has('xl/drawings/vmlDrawing1.vml'), 'and the shape part a reader wants alongside it');

  for (const comment of model.comments) {
    assert.ok(comments.includes(`ref="${comment.addr}"`), `no comment on ${comment.addr}`);
  }
  assert.equal((comments.match(/<comment /g) || []).length, model.comments.length);

  // The quote itself is in the file, which is the entire point of the workbook.
  const sample = model.comments.find((c) => c.text.includes('the span supporting revenue'));
  assert.ok(sample, 'a revenue comment exists');
  assert.ok(comments.includes('the span supporting revenue'), 'and its quote is in the part');

  // The sheet must point at the drawing, or the notes are invisible.
  assert.match(files.get('xl/worksheets/sheet1.xml'), /<legacyDrawing r:id="rIdVml"\/>/);
});

test('column widths and the frozen header survive', () => {
  const files = build([approved('CEAT')], {});
  const sheet = files.get('xl/worksheets/sheet1.xml');
  const model = TyreCore.buildWorkbookModel([approved('CEAT')], {});
  assert.equal((sheet.match(/<col /g) || []).length, model.sheets[0].widths.length);
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

  const sheet = files.get('xl/worksheets/sheet1.xml');
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

  const sheet = unzip(bytes).get('xl/worksheets/sheet1.xml');
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
