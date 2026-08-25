// The deck: what goes on it, and whether the file is one PowerPoint can open.
//
// Two halves, tested differently. buildDeckModel is data, so it is asserted on
// directly. writePptx produces bytes, so the tests unpack the ZIP and check the
// package the way a consumer would: every part declared, every relationship
// resolving, every XML fragment balanced and escaped.
//
// The review rule matters most here. A deck is the artefact that circulates —
// it gets mailed on, screenshotted, and read a month later out of context — so a
// record a person rejected must never appear on one, under any option.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TyreCore } from '../pipeline/lib/core.mjs';
import { TyreDeck } from '../pipeline/lib/deck.mjs';
import { assertBalancedXml, unzip } from './ooxml-helpers.mjs';

/* ------------------------------------------------------------- fixtures -- */

function record(over = {}) {
  const base = {
    id: 'r-' + (over.company || 'x'),
    company: 'CEAT',
    quarter: 'Q1 FY26',
    source: 'fixture:ceat.txt',
    currency: { code: 'INR', unit: 'Crore', fx_to_inr: 1 },
    core: Object.fromEntries(TyreCore.CORE_KEYS.map((k, i) => [k, 100 + i])),
    quotes: Object.fromEntries(TyreCore.CORE_KEYS.map((k) => [k, `quote for ${k}`])),
    segments: { channels: { replacement: 60, oem: 30, export: 10 }, product_categories: { TBR: 40, TBB: 10, PCR: 30, '2W': 15, OHT: 5 } },
    outlook: { commentary: 'Steady demand.', rm_trend: 'Natural rubber eased.', capex: 'Capex on track.' },
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
const rejected = (company) => record({
  company, id: 'x-' + company,
  review: { status: 'rejected', reviewer: 'Priya Nair', reviewed_at: '2026-08-25T09:00:00Z', note: 'wrong table' }
});

const allText = (model) => JSON.stringify(model.slides);

/* ---------------------------------------------------------- deck model -- */

test('every core metric reaches a slide — none can be added and forgotten', () => {
  const covered = new Set(TyreCore.DECK_SECTIONS.flatMap((s) => s.keys));
  assert.deepEqual(
    TyreCore.CORE_KEYS.filter((k) => !covered.has(k)),
    [],
    'a metric in CORE_METRICS with no DECK_SECTIONS entry would silently never be shown'
  );
  assert.equal(covered.size, TyreCore.CORE_KEYS.length, 'and none is listed twice');
});

test('a rejected record is withheld whether or not reviewedOnly is set', () => {
  const records = [approved('CEAT'), rejected('MRF')];
  for (const reviewedOnly of [true, false]) {
    const model = TyreCore.buildDeckModel(records, { reviewedOnly });
    assert.equal(model.provenance.rejected_withheld, 1);
    assert.equal(model.provenance.total, 1);
    assert.doesNotMatch(allText(model), /MRF/, `MRF reached the deck with reviewedOnly=${reviewedOnly}`);
  }
});

test('reviewedOnly narrows to approved; without it pending records are marked', () => {
  const records = [approved('CEAT'), pending('MRF')];

  const strict = TyreCore.buildDeckModel(records, { reviewedOnly: true });
  assert.equal(strict.provenance.total, 1);
  assert.equal(strict.provenance.pending, 0);
  assert.doesNotMatch(allText(strict), /MRF/);

  const draft = TyreCore.buildDeckModel(records, {});
  assert.equal(draft.provenance.total, 2);
  assert.equal(draft.provenance.pending, 1);
  assert.match(allText(draft), /MRF \*/, 'an unreviewed company is starred');
  assert.doesNotMatch(allText(draft), /CEAT \*/, 'an approved one is not');
  assert.match(allText(draft), /not yet reviewed by a person/, 'and the asterisk is explained on the slide');
});

test('one currency goes in the subtitle; several get their own column and a warning', () => {
  const single = TyreCore.buildDeckModel([approved('CEAT'), approved('MRF')], {});
  const headline = single.slides.find((s) => s.title === 'Headline comparison');
  assert.ok(!headline.columns.includes('Currency'), 'no column is needed when every row agrees');
  assert.match(headline.subtitle, /INR Crore/);

  const mixed = TyreCore.buildDeckModel([
    approved('CEAT'),
    record({ company: 'Goodyear India', id: 'g', currency: { code: 'USD', unit: 'Million', fx_to_inr: 83 } })
  ], {});
  const mixedHeadline = mixed.slides.find((s) => s.title === 'Headline comparison');
  assert.ok(mixedHeadline.columns.includes('Currency'));
  assert.match(mixedHeadline.footnote, /do not read across as a ranking/i);
  assert.equal(mixed.provenance.currencies.length, 2);
});

test('figures are never converted between currencies', () => {
  const usd = record({ company: 'Goodyear India', id: 'g', currency: { code: 'USD', unit: 'Million', fx_to_inr: 83 } });
  const model = TyreCore.buildDeckModel([usd], {});
  const headline = model.slides.find((s) => s.title === 'Headline comparison');
  const revenueIdx = headline.columns.indexOf('Revenue');
  const shown = headline.rows[0][revenueIdx];
  assert.equal(shown, String(usd.core.revenue), 'the reported figure is what appears, unscaled');
});

test('a long roster continues onto further slides instead of overflowing one', () => {
  const many = Array.from({ length: 30 }, (_, i) => approved(`Company ${String(i).padStart(2, '0')}`));
  const model = TyreCore.buildDeckModel(many, {});
  const headline = model.slides.filter((s) => s.title.startsWith('Headline comparison'));
  assert.ok(headline.length > 1, 'thirty companies do not fit on one slide');
  assert.equal(
    headline.reduce((n, s) => n + s.rows.length, 0), 30,
    'and every company is on one of them — continuation, not truncation'
  );
  assert.match(headline[1].title, /\(cont\.\)/);
});

test('an empty selection produces an explanation, not a broken deck', () => {
  const model = TyreCore.buildDeckModel([rejected('MRF')], {});
  assert.equal(model.provenance.total, 0);
  assert.ok(model.slides.length >= 2);
  assert.match(allText(model), /withheld because a reviewer rejected/);
});

test('the closing slide states what quote verification cannot catch', () => {
  const model = TyreCore.buildDeckModel([approved('CEAT')], {});
  const last = model.slides[model.slides.length - 1];
  assert.match(last.title, /cannot tell you/i);
  assert.match(JSON.stringify(last.bullets), /wrong table|standalone/i);
});

/* ------------------------------------------------------------- renderer -- */

const sampleDeck = () => TyreCore.buildDeckModel(
  [approved('CEAT'), pending('MRF'), rejected('Nope')],
  { generatedAt: '2026-08-25T00:00:00Z' }
);

test('the package holds every part a presentation needs, and each resolves', () => {
  const model = sampleDeck();
  const files = unzip(TyreDeck.writePptx(model));

  for (const required of [
    '[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels', 'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml'
  ]) {
    assert.ok(files.has(required), `missing ${required}`);
  }

  const types = files.get('[Content_Types].xml');
  for (let n = 1; n <= model.slides.length; n++) {
    assert.ok(files.has(`ppt/slides/slide${n}.xml`), `slide ${n} is in the package`);
    assert.ok(files.has(`ppt/slides/_rels/slide${n}.xml.rels`), `slide ${n} has its relationships`);
    assert.ok(types.includes(`/ppt/slides/slide${n}.xml`), `slide ${n} has a declared content type`);
  }

  // Every relationship id the presentation references must be defined.
  const presentation = files.get('ppt/presentation.xml');
  const rels = files.get('ppt/_rels/presentation.xml.rels');
  for (const [, id] of presentation.matchAll(/r:id="(rId\d+)"/g)) {
    assert.ok(rels.includes(`Id="${id}"`), `presentation references ${id} with nothing defining it`);
  }
});

test('every XML part is balanced and properly escaped', () => {
  const files = unzip(TyreDeck.writePptx(sampleDeck()));
  for (const [name, xml] of files) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    assertBalancedXml(name, xml);
  }
});

test('a company name full of XML metacharacters cannot break the file', () => {
  // The control characters are the point: a PDF text layer hands them over, and an
  // unescaped one would make the whole package unopenable.
  const nasty = 'A & B <Tyres> "Ltd" ' + '\u0007\u001F';
  const model = TyreCore.buildDeckModel([approved(nasty)], {});
  const files = unzip(TyreDeck.writePptx(model));
  for (const [name, xml] of files) assertBalancedXml(name, xml);

  const slides = [...files.entries()].filter(([n]) => n.startsWith('ppt/slides/slide')).map(([, x]) => x).join('');
  assert.match(slides, /A &amp; B &lt;Tyres&gt;/, 'the name survives, escaped');
  assert.doesNotMatch(slides, /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/, 'control characters are stripped, not embedded');
});

test('the same model renders to the same bytes twice', () => {
  const model = sampleDeck();
  assert.deepEqual(TyreDeck.writePptx(model), TyreDeck.writePptx(model));
});

test('slide count matches the model, and rendering is refused with no slides', () => {
  const model = sampleDeck();
  const files = unzip(TyreDeck.writePptx(model));
  const slideParts = [...files.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.equal(slideParts.length, model.slides.length);
  assert.throws(() => TyreDeck.writePptx({ slides: [] }), /no slides/);
});

test('the rendered slides carry the figures and the review state', () => {
  const model = TyreCore.buildDeckModel([approved('CEAT'), pending('MRF')], {});
  const files = unzip(TyreDeck.writePptx(model));
  const slides = [...files.entries()].filter(([n]) => n.startsWith('ppt/slides/slide')).map(([, x]) => x).join('');
  assert.match(slides, /CEAT/);
  assert.match(slides, /MRF \*/, 'the pending marker survives into the file');
  assert.match(slides, /Approved by Priya Nair/);
  assert.match(slides, /PENDING REVIEW/);
});

test('recordsToPptx goes from records to bytes in one call', () => {
  const bytes = TyreDeck.recordsToPptx([approved('CEAT')], { reviewedOnly: true });
  assert.ok(bytes instanceof Uint8Array && bytes.length > 1000);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'it is a ZIP');
});

/* ------------------------------------------ regressions from the review pass -- */

test('a caveat appears on every continuation slide, not only the last', () => {
  // Thirteen companies paginate the comparison tables. The footnote carries the
  // caveats — different currencies, unreviewed companies — and one that shows up only
  // on the last of three slides is worse than none: the reader on slide one sees a
  // clean table and no warning at all.
  const many = Array.from({ length: 14 }, (_, i) =>
    (i % 2 ? pending : approved)(`Co${String(i).padStart(2, '0')}`));
  many[0].currency = { code: 'USD', unit: 'Million', fx_to_inr: 83 };

  const parts = TyreCore.buildDeckModel(many, {}).slides.filter((s) => s.title.startsWith('Headline'));
  assert.ok(parts.length > 1, 'this input must actually paginate for the test to mean anything');
  for (const [i, slide] of parts.entries()) {
    assert.match(slide.footnote || '', /do not read across as a ranking/i, `slide ${i + 1} lost the currency caveat`);
    assert.match(slide.footnote || '', /not yet reviewed/i, `slide ${i + 1} lost the unreviewed legend`);
    assert.match(slide.footnote || '', new RegExp(`Slide ${i + 1} of ${parts.length}`), `slide ${i + 1} does not say where it sits`);
  }
});

test('a record with no currency is not folded into everyone else’s', () => {
  const noCurrency = record({ company: 'Unstated', id: 'u', currency: null });
  const model = TyreCore.buildDeckModel([approved('CEAT'), noCurrency], {});

  assert.ok(model.provenance.currencies.includes('currency not stated'));
  assert.doesNotMatch(model.slides[0].subtitle, /figures in INR Crore/,
    'the deck must not assert a currency for a figure whose currency is unknown');
  const headline = model.slides.find((s) => s.title === 'Headline comparison');
  assert.ok(headline.columns.includes('Currency'), 'the per-row currency column has to appear');
});

test('the provenance counts reconcile with the input', () => {
  const model = TyreCore.buildDeckModel([
    approved('A'),
    pending('B'),
    record({ company: 'C', id: 'c', quarter: 'Q4 FY25' }),
    rejected('D'),
    record({ company: 'E', id: 'e', quarter: null })
  ], {});
  const p = model.provenance;
  assert.equal(p.input_records, 5);
  assert.equal(
    p.total + p.other_quarters_held_back + p.undated_withheld + p.rejected_withheld,
    p.input_records,
    'every input record is either on the deck or accounted for by one of the held-back counts'
  );
});

test('a record with no quarter is held back but said out loud', () => {
  const model = TyreCore.buildDeckModel([approved('CEAT'), record({ company: 'Undated', id: 'u', quarter: null })], {});
  assert.equal(model.provenance.undated_withheld, 1);
  const howTo = model.slides.find((s) => s.title === 'How to read this deck');
  assert.match(JSON.stringify(howTo.bullets), /state no quarter/i,
    'an approved record that cannot be placed must not simply vanish');
});

test('trend slides do not claim approval they cannot vouch for', () => {
  const history = [
    approved('CEAT'),
    record({ company: 'CEAT', id: 'c-old', quarter: 'Q4 FY25', review: { status: 'pending', reviewer: null, reviewed_at: null, note: null } })
  ];
  const draft = TyreCore.buildDeckModel(history, {}).slides.find((s) => s.title === 'Revenue by quarter');
  assert.ok(draft, 'two quarters earn a trend slide');
  assert.match(draft.footnote, /have not been reviewed/i,
    'with an unreviewed record in the history the slide must not say every figure was approved');

  const clean = TyreCore.buildDeckModel([approved('CEAT'), record({ company: 'CEAT', id: 'c2', quarter: 'Q4 FY25' })], {})
    .slides.find((s) => s.title === 'Revenue by quarter');
  assert.match(clean.footnote, /approved by a person/i);
});

test('characters XML cannot carry are removed before they break the package', () => {
  // A single U+FFFF in a company name makes the slide XML not-well-formed. The reader
  // that notices does not report an error — it opens the deck and silently drops every
  // table row after the bad character, which is the worst possible failure mode.
  const hostile = `CEAT￿ Ltd \uD800 lone-high \uDC00 lone-low ￾`;
  const model = TyreCore.buildDeckModel([approved(hostile), approved('MRF')], {});
  const files = unzip(TyreDeck.writePptx(model));
  for (const [name, xml] of files) assertBalancedXml(name, xml);

  const slides = [...files.entries()].filter(([n]) => n.startsWith('ppt/slides/slide')).map(([, x]) => x).join('');
  for (const forbidden of ['￿', '￾', '\uD800', '\uDC00']) {
    assert.ok(!slides.includes(forbidden), `${JSON.stringify(forbidden)} survived into the XML`);
  }
  assert.match(slides, /MRF/, 'the row after the hostile one is still there');
});

test('a properly paired astral character survives', () => {
  assert.equal(TyreDeck.sanitizeXmlText('a\u{1F600}b'), 'a\u{1F600}b', 'an emoji is a valid XML character');
  assert.equal(TyreDeck.sanitizeXmlText('a\uD83Db'), 'ab', 'half of one is not');
  assert.equal(TyreDeck.sanitizeXmlText('tab\there\nand\rreturn'), 'tab\there\nand\rreturn', 'tab, newline and return are legal');
});

test('a ZIP too large for its 16-bit entry count is refused, not wrapped', () => {
  assert.throws(
    () => TyreDeck.zip(new Array(70000).fill({ name: 'a.xml', data: 'x' })),
    /65535|ZIP64/,
    'wrapping the count silently would produce an archive that unzips to a fraction of itself'
  );
});
