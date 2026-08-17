// The shared data contract (pipeline/lib/core-source.js), exercised through the
// same Node entry point the pipeline uses.
//
// Everything downstream keys off this file's guarantees: the stored shape never
// invents a value, a quote only counts as verified if it is really in the source,
// and a delta is only computed when the two quarters are on the same basis.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TyreCore } from '../pipeline/lib/core.mjs';

const INR_CRORE = { code: 'INR', unit: 'Crore' };

function stored(overrides = {}, opts = { source: 'fixture:test.txt' }) {
  return TyreCore.recToStoredShape(
    {
      company: 'CEAT',
      quarter: 'Q1 FY26',
      currency: INR_CRORE,
      core: {},
      core_quotes: {},
      ...overrides
    },
    opts
  );
}

/* ------------------------------------------------------- recToStoredShape -- */

test('recToStoredShape produces the exact stored shape', () => {
  const rec = TyreCore.recToStoredShape(
    {
      company: '  Apollo Tyres ',
      quarter: 'Q1 FY26',
      currency: { code: ' inr ', unit: ' Crore ' },
      core: { revenue: 6338.42 },
      core_quotes: { revenue: 'Revenue from operations 6,338.42' },
      segments: { channels: { replacement: 68 }, product_categories: { TBR: 31 } },
      outlook: { commentary: ' Demand held up. ', rm_trend: '', capex: null }
    },
    { source: 'fixture:apollo.txt', retrieved_at: '2025-08-08T00:00:00.000Z' }
  );

  assert.deepEqual(Object.keys(rec).sort(), [
    'company', 'core', 'currency', 'id', 'outlook', 'quarter', 'quotes',
    'retrieved_at', 'review', 'segments', 'source', 'verification'
  ]);

  assert.equal(rec.company, 'Apollo Tyres');
  assert.equal(rec.quarter, 'Q1 FY26');
  assert.equal(rec.source, 'fixture:apollo.txt');
  assert.equal(rec.retrieved_at, '2025-08-08T00:00:00.000Z');
  assert.deepEqual(rec.currency, { code: 'INR', unit: 'Crore', fx_to_inr: 1 });
  assert.deepEqual(rec.review, { status: 'pending', reviewer: null, reviewed_at: null, note: null });
  assert.equal(rec.verification, null);

  assert.deepEqual(Object.keys(rec.core), TyreCore.CORE_KEYS);
  assert.deepEqual(Object.keys(rec.quotes), TyreCore.CORE_KEYS);
  assert.deepEqual(Object.keys(rec.segments.channels), TyreCore.CHANNEL_KEYS);
  assert.deepEqual(Object.keys(rec.segments.product_categories), TyreCore.PRODUCT_KEYS);
  assert.deepEqual(Object.keys(rec.outlook), TyreCore.OUTLOOK_KEYS);

  assert.equal(rec.core.revenue, 6338.42);
  assert.equal(rec.quotes.revenue, 'Revenue from operations 6,338.42');
  assert.equal(rec.segments.channels.replacement, 68);
  assert.equal(rec.segments.product_categories.TBR, 31);
  assert.equal(rec.outlook.commentary, 'Demand held up.');
  assert.equal(rec.outlook.rm_trend, null, 'an empty outlook string is not a report');
});

test('recToStoredShape keeps nulls as null and never invents a value', () => {
  const rec = TyreCore.recToStoredShape(
    {
      company: 'MRF',
      quarter: 'Q1 FY26',
      currency: { code: 'INR', unit: 'Crore' },
      // Everything here is a value the model failed to report properly: a string
      // where a number belongs, a NaN, an explicit null, a non-string quote.
      core: { revenue: '6338.42', ebitda: Number.NaN, pat: null, roe: Infinity },
      core_quotes: { revenue: 42, ebitda: null },
      segments: { channels: { replacement: '68' }, product_categories: { TBR: null } }
    },
    { source: 's' }
  );

  for (const key of TyreCore.CORE_KEYS) {
    assert.equal(rec.core[key], null, `core.${key} should be null`);
    assert.equal(rec.quotes[key], '', `quotes.${key} should be the empty string`);
  }
  assert.equal(rec.segments.channels.replacement, null);
  assert.equal(rec.segments.product_categories.TBR, null);
  assert.deepEqual(rec.outlook, { commentary: null, rm_trend: null, capex: null });
});

test('recToStoredShape is stable for the same input', () => {
  const input = {
    company: 'JK Tyre & Industries',
    quarter: 'Q1 FY26',
    currency: INR_CRORE,
    core: { revenue: 100 },
    core_quotes: { revenue: 'Revenue from operations 100.00' }
  };
  const opts = { source: 'fixture:jktyre.txt', retrieved_at: '2025-08-08T00:00:00.000Z' };

  const a = TyreCore.recToStoredShape(input, opts);
  const b = TyreCore.recToStoredShape(input, opts);

  assert.equal(a.id, b.id);
  assert.deepEqual(a, b);
  assert.equal(a.id, TyreCore.recordId('JK Tyre & Industries', 'Q1 FY26', 'fixture:jktyre.txt'));

  const otherQuarter = TyreCore.recToStoredShape({ ...input, quarter: 'Q2 FY26' }, opts);
  assert.notEqual(a.id, otherQuarter.id, 'a different quarter is a different record');
});

/* ---------------------------------------------------------- validateStored -- */

test('validateStored catches each class of malformed record', () => {
  assert.deepEqual(TyreCore.validateStored(null), ['record is not an object']);
  assert.deepEqual(TyreCore.validateStored('a record'), ['record is not an object']);

  const good = stored({ core: { revenue: 1 } });
  assert.deepEqual(TyreCore.validateStored(good), []);

  const drop = (mutate) => {
    const copy = structuredClone(good);
    mutate(copy);
    return TyreCore.validateStored(copy);
  };

  assert.deepEqual(drop((r) => { r.company = null; }), ['missing company']);
  assert.deepEqual(drop((r) => { r.quarter = ''; }), ['missing quarter']);
  assert.deepEqual(drop((r) => { r.currency = { code: null, unit: null }; }), [
    'missing currency.code',
    'missing currency.unit'
  ]);
  assert.deepEqual(drop((r) => { delete r.core; }), ['missing core']);
  assert.deepEqual(drop((r) => { delete r.core.roe; }), ['core.roe absent (expected number or null)']);
  assert.deepEqual(drop((r) => { r.core.revenue = '1'; }), ['core.revenue is not a number or null']);
  assert.deepEqual(drop((r) => { delete r.quotes; }), ['missing quotes']);
  assert.deepEqual(drop((r) => { delete r.segments.channels; }), ['missing segments']);

  const wrecked = TyreCore.validateStored({ core: { revenue: 'x' } });
  assert.ok(wrecked.length > 3, 'a record missing everything reports every problem, not just the first');
});

/* ------------------------------------------------------------ verifyQuotes -- */

const SOURCE = [
  'STATEMENT OF UNAUDITED CONSOLIDATED FINANCIAL RESULTS',
  '1   Revenue from operations                             6,338.42',
  '7   Profit for the period (5-6)                           394.61',
  'EBITDA for the quarter ended 30 June 2025 stood at INR 918.07 Crore.'
].join('\n');

test('verifyQuotes accepts a verbatim quote and rejects a paraphrase', () => {
  const rec = stored({
    core: { revenue: 6338.42, pat: 394.61 },
    core_quotes: {
      revenue: '1   Revenue from operations                             6,338.42',
      pat: 'Profit for the quarter came in at 394.61 crore, down year on year'
    }
  });

  const result = TyreCore.verifyQuotes(rec, SOURCE);

  assert.equal(result.ok, false);
  assert.equal(result.checked, 2);
  assert.equal(result.verified, 1);
  assert.equal(result.failed, 1);

  const byKey = Object.fromEntries(result.checks.map((c) => [c.key, c]));
  assert.equal(byKey.revenue.status, 'verified');
  assert.equal(byKey.revenue.score, 1);
  assert.equal(byKey.pat.status, 'not_found');
  assert.ok(byKey.pat.score < TyreCore.QUOTE_MATCH_THRESHOLD, `paraphrase scored ${byKey.pat.score}`);
});

test('verifyQuotes rejects a quote whose words are scattered across the document', () => {
  const filler = 'the quarter under review saw steady demand across all regions and channels. ';
  const document = `revenue ${filler.repeat(6)} margin ${filler.repeat(6)} capex`;
  const rec = stored({
    core: { revenue: 1 },
    core_quotes: { revenue: 'revenue margin capex' }
  });

  const result = TyreCore.verifyQuotes(rec, document);

  assert.equal(result.ok, false);
  assert.equal(result.checks[0].status, 'not_found');
  assert.ok(
    result.checks[0].score < 0.5,
    `every word is somewhere in the document, but not together (scored ${result.checks[0].score})`
  );
});

test('verifyQuotes counts a reported number with an empty quote as unquoted', () => {
  const rec = stored({ core: { revenue: 6338.42 }, core_quotes: { revenue: '' } });

  const result = TyreCore.verifyQuotes(rec, SOURCE);

  assert.equal(result.checked, 1);
  assert.equal(result.unquoted, 1);
  assert.equal(result.verified, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.checks[0], { key: 'revenue', value: 6338.42, quote: '', score: 0, status: 'unquoted' });
  // A missing quote is not a fabricated quote: it is surfaced for the reviewer
  // rather than failing the extraction outright.
  assert.equal(result.ok, true);
});

test('verifyQuotes verifies vacuously when there are no values and no quotes', () => {
  const rec = stored();

  const result = TyreCore.verifyQuotes(rec, SOURCE);

  assert.equal(result.ok, true);
  assert.equal(result.checked, 0);
  assert.deepEqual(result.checks, []);
});

/* --------------------------------------------------------- quoteMatchScore -- */

test('quoteMatchScore is 1 for an exact substring', () => {
  assert.equal(TyreCore.quoteMatchScore(SOURCE, 'Revenue from operations                             6,338.42'), 1);
  assert.equal(TyreCore.quoteMatchScore(SOURCE, 'nothing like this appears anywhere'), 0);
  assert.equal(TyreCore.quoteMatchScore(SOURCE, ''), 0);
  assert.equal(TyreCore.quoteMatchScore('', 'Revenue from operations'), 0);
});

test('quoteMatchScore tolerates what a PDF extractor does to punctuation and spacing', () => {
  const cases = [
    ['the Company’s EBITDA margin', "the Company's EBITDA margin"],
    ['“Revenue from operations”', '"Revenue from operations"'],
    ['Q1 FY26 – EBITDA margin', 'Q1 FY26 - EBITDA margin'],
    ['Q1 FY26 — EBITDA margin', 'Q1 FY26 - EBITDA margin'],
    ['profit − before tax', 'profit - before tax'],
    ['EBITDA margin of 14.5%', 'EBITDA     margin\n  of\t14.5%'],
    ['Total assets 24,850.32', 'Total assets 24,850.32']
  ];

  for (const [source, quote] of cases) {
    assert.equal(TyreCore.quoteMatchScore(source, quote), 1, `${JSON.stringify(quote)} should match ${JSON.stringify(source)}`);
  }
});

/* --------------------------------------------------------------- currency -- */

test('toInrCrore converts across currency and unit combinations', () => {
  assert.equal(TyreCore.toInrCrore(100, { code: 'INR', unit: 'Crore' }), 100);
  assert.equal(TyreCore.toInrCrore(100, { code: 'INR', unit: 'Crores' }), 100);
  assert.equal(TyreCore.toInrCrore(100, { code: 'INR', unit: 'Lakh' }), 1);
  assert.equal(TyreCore.toInrCrore(100, { code: 'INR', unit: 'Million' }), 10);
  assert.equal(TyreCore.toInrCrore(1, { code: 'INR', unit: 'Billion' }), 100);
  assert.equal(TyreCore.toInrCrore(100, { code: 'USD', unit: 'Million' }), 100 * 83 * 0.1);
  assert.equal(TyreCore.toInrCrore(-50, { code: 'USD', unit: 'Million' }), -50 * 83 * 0.1);

  assert.equal(TyreCore.toInrCrore(100, { code: 'XYZ', unit: 'Crore' }), null, 'unknown currency');
  assert.equal(TyreCore.toInrCrore(100, { code: 'INR', unit: 'Furlong' }), null, 'unknown unit');
  assert.equal(TyreCore.toInrCrore(null, { code: 'INR', unit: 'Crore' }), null);
  assert.equal(TyreCore.toInrCrore(Number.NaN, { code: 'INR', unit: 'Crore' }), null);
});

/* ------------------------------------------------------- quarters & deltas -- */

test('quarterSortKey parses the labels this sector files under', () => {
  assert.equal(TyreCore.quarterSortKey('Q1 FY26'), 20261);
  assert.equal(TyreCore.quarterSortKey('Q3FY2025'), 20253);
  assert.equal(TyreCore.quarterSortKey('q4 fy26'), 20264);
  assert.equal(TyreCore.quarterSortKey("Q2 FY'27"), 20272);
  assert.ok(TyreCore.quarterSortKey('Q4 FY25') < TyreCore.quarterSortKey('Q1 FY26'), 'a year boundary sorts forward');

  assert.equal(TyreCore.quarterSortKey('June quarter'), null);
  assert.equal(TyreCore.quarterSortKey(null), null);
});

test('computeDeltas compares consecutive quarters per company', () => {
  const q4 = stored({ quarter: 'Q4 FY25', core: { revenue: 100, pat: 10 } });
  const q1 = stored({ quarter: 'Q1 FY26', core: { revenue: 120, pat: 0 } });

  // Passed out of order on purpose: the sort is the function's job.
  const deltas = TyreCore.computeDeltas([q1, q4]);

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].company, 'CEAT');
  assert.equal(deltas[0].from_quarter, 'Q4 FY25');
  assert.equal(deltas[0].to_quarter, 'Q1 FY26');
  assert.deepEqual(deltas[0].metrics.revenue, { from: 100, to: 120, abs: 20, pct: 20 });
  assert.deepEqual(deltas[0].metrics.pat, { from: 10, to: 0, abs: -10, pct: -100 });
  assert.equal(deltas[0].metrics.ebitda, null, 'a metric absent from either quarter has no delta');
});

test('computeDeltas yields null rather than a bogus delta when the currency basis changed', () => {
  const inr = stored({ quarter: 'Q4 FY25', currency: { code: 'INR', unit: 'Crore' }, core: { revenue: 100 } });
  const usd = stored({ quarter: 'Q1 FY26', currency: { code: 'USD', unit: 'Million' }, core: { revenue: 12 } });

  const currencyChanged = TyreCore.computeDeltas([inr, usd]);
  assert.equal(currencyChanged.length, 1);
  for (const key of TyreCore.CORE_KEYS) {
    assert.equal(currencyChanged[0].metrics[key], null, `metrics.${key}`);
  }

  const unitChanged = TyreCore.computeDeltas([
    stored({ quarter: 'Q4 FY25', currency: { code: 'INR', unit: 'Crore' }, core: { revenue: 100 } }),
    stored({ quarter: 'Q1 FY26', currency: { code: 'INR', unit: 'Lakh' }, core: { revenue: 12000 } })
  ]);
  assert.equal(unitChanged[0].metrics.revenue, null, 'the same currency in a different unit is still a different basis');
});

test('computeDeltas keeps companies apart', () => {
  const deltas = TyreCore.computeDeltas([
    stored({ company: 'CEAT', quarter: 'Q4 FY25', core: { revenue: 100 } }),
    stored({ company: 'CEAT', quarter: 'Q1 FY26', core: { revenue: 110 } }),
    stored({ company: 'MRF', quarter: 'Q1 FY26', core: { revenue: 700 } })
  ]);

  assert.deepEqual(deltas.map((d) => d.company), ['CEAT'], 'a single quarter for MRF has nothing to compare against');
});

/* ------------------------------------------------------ selectFinancialText -- */

test('selectFinancialText is a no-op below the budget', () => {
  const text = 'Revenue from operations 6,338.42';

  const selection = TyreCore.selectFinancialText(text, 5000);

  assert.deepEqual(selection, { text, truncated: false, strategy: 'full' });
});

test('selectFinancialText keeps the financial section rather than the first N chars', () => {
  const narrative = 'A long chairman letter about the year gone by and the road ahead. ';
  const preamble = `${narrative.repeat(200)}DEEP-IN-THE-PREAMBLE ${narrative.repeat(200)}`;
  const financials = [
    'Statement of profit and loss for the quarter.',
    'Revenue from operations 6,338.42',
    'Total income 6,380.04',
    'EBITDA margin of 14.5%',
    'Balance sheet extract. Cash flow extract. Segment note.',
    'Earnings per share (unaudited) 6.21',
    'FINANCIAL-STATEMENT-MARKER'
  ].join('\n');
  const document = `${preamble}\n${financials.repeat(20)}\n${narrative.repeat(200)}`;

  const selection = TyreCore.selectFinancialText(document, 5000);

  assert.equal(selection.truncated, true);
  assert.equal(selection.strategy, 'financial-section');
  assert.equal(selection.source_length, document.length);
  assert.ok(selection.kept_from > 0, 'the kept window does not start at the top of the document');
  assert.ok(selection.text.includes('FINANCIAL-STATEMENT-MARKER'), 'the financial statements survived');
  assert.ok(!selection.text.includes('DEEP-IN-THE-PREAMBLE'), 'the middle of the preamble did not');
  assert.ok(selection.text.startsWith('A long chairman letter'), 'the head is kept for company/quarter context');
});

test('buildExtractionPrompt carries the schema, the hints and the selected text', () => {
  const prompt = TyreCore.buildExtractionPrompt('Revenue from operations 6,338.42', {
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });

  assert.equal(prompt.system, TyreCore.EXTRACTION_SYSTEM);
  assert.ok(prompt.user.includes('Expected company: Apollo Tyres'));
  assert.ok(prompt.user.includes('Expected quarter: Q1 FY26'));
  assert.ok(prompt.user.includes(TyreCore.SCHEMA_HINT));
  assert.ok(prompt.user.includes('Revenue from operations 6,338.42'));
  assert.equal(prompt.selection.truncated, false);
});

/* ---------------------------------------------------------- parseModelJSON -- */

test('parseModelJSON recovers from a code fence and from surrounding prose', () => {
  assert.deepEqual(TyreCore.parseModelJSON('{"company":"CEAT"}'), { company: 'CEAT' });
  assert.deepEqual(TyreCore.parseModelJSON('```json\n{"company":"CEAT"}\n```'), { company: 'CEAT' });
  assert.deepEqual(TyreCore.parseModelJSON('```\n{"company":"CEAT"}\n```'), { company: 'CEAT' });
  assert.deepEqual(
    TyreCore.parseModelJSON('Here is the extraction:\n{"core":{"revenue":6338.42}}\nLet me know if you need more.'),
    { core: { revenue: 6338.42 } }
  );
  assert.deepEqual(
    TyreCore.parseModelJSON('Note: the filing uses a } character.\n{"quotes":{"revenue":"a } brace in a quote"}}\ndone'),
    { quotes: { revenue: 'a } brace in a quote' } }
  );
});

test('parseModelJSON throws a clear error on genuinely unparseable output', () => {
  assert.throws(() => TyreCore.parseModelJSON('I am not able to help with that request.'), /no JSON object found/);
  assert.throws(() => TyreCore.parseModelJSON(''), /no JSON object found/);
  assert.throws(() => TyreCore.parseModelJSON('{"core": {"revenue": 6338.42'), /unterminated JSON object/);
});

/* ------------------------------------------------------------ buildQAPrompt -- */

test('buildQAPrompt includes every record passed and the question', () => {
  const records = [
    stored({ company: 'Apollo Tyres', core: { revenue: 6338.42 }, core_quotes: { revenue: 'Revenue from operations 6,338.42' } }),
    stored({ company: 'MRF', core: { revenue: 7211.05 } }),
    stored({ company: 'CEAT', core: { ebitda_margin: 12.9 } })
  ];
  const question = 'Which company has the best EBITDA margin this quarter?';

  const prompt = TyreCore.buildQAPrompt(records, question);

  assert.equal(prompt.system, TyreCore.QA_SYSTEM);
  assert.equal(prompt.record_count, 3);
  assert.ok(prompt.user.includes('Records available to answer from: 3'));
  assert.ok(prompt.user.endsWith(`Question: ${question}`));

  for (const record of records) {
    assert.ok(prompt.user.includes(`"${record.company}"`), `${record.company} is in the context`);
  }
  assert.ok(prompt.user.includes('6338.42'), 'reported figures are serialized');
  assert.ok(prompt.user.includes('Revenue from operations 6,338.42'), 'so are the quotes that ground them');
  assert.ok(prompt.user.includes('"review_status": "pending"'), 'the model is told whether a record was reviewed');

  const single = TyreCore.buildQAPrompt([records[0]], 'How did Apollo do?');
  assert.ok(single.user.includes('Records available to answer from: 1'));

  const none = TyreCore.buildQAPrompt([], 'Anything?');
  assert.equal(none.record_count, 0);
  assert.ok(none.user.includes('Question: Anything?'));
});

/* -------------------------------------------- quote verification, regressions -- */

// Indian quarterly tables carry three or four comparative columns side by side.
// A model can quote a completely genuine row label and still read the number out
// of the wrong column, which is the most likely way a wrong figure gets in.
test('a figure read from the wrong comparative column is not accepted', () => {
  const source =
    'Revenue from operations 6,338.42 5,904.11 24,510.88 and profit for the period 394.61 ' +
    'for the quarter ended 30 June 2025.';

  const wrongColumn = TyreCore.verifyQuotes(
    { core: { revenue: 5904.11 }, quotes: { revenue: 'Revenue from operations 6,338.42' } },
    source
  );
  assert.equal(wrongColumn.checks[0].status, 'value_not_in_quote');
  assert.equal(wrongColumn.checks[0].score, 1, 'the quote itself is genuine — it is the number that is wrong');
  assert.equal(wrongColumn.ok, false, 'the record must not pass');
  assert.equal(wrongColumn.value_not_in_quote, 1);

  const rightColumn = TyreCore.verifyQuotes(
    { core: { revenue: 6338.42 }, quotes: { revenue: 'Revenue from operations 6,338.42' } },
    source
  );
  assert.equal(rightColumn.checks[0].status, 'verified');
  assert.equal(rightColumn.ok, true);
});

test('a rounded percentage quote still verifies against the fuller figure', () => {
  const v = TyreCore.verifyQuotes(
    { core: { ebitda_margin: 14.53 }, quotes: { ebitda_margin: 'EBITDA margin of 14.5%' } },
    'EBITDA margin of 14.5% for the quarter ended 30 June 2025.'
  );
  assert.equal(v.checks[0].status, 'verified', 'rounding in a quote is normal and must not be a failure');
});

// Word order carries the meaning. A quote stitched together from words that all
// appear in the document, in an order the document never used, says something the
// filing does not — so it must not score as if it were verbatim.
test('a quote reassembled out of order does not pass as verbatim', () => {
  const source =
    'Revenue from operations 6,543.21 and profit for the period 812.44 for the quarter ended 30 June 2025.';
  const swapped = 'Revenue from operations 812.44 and profit for the period 6,543.21';

  assert.ok(
    TyreCore.quoteMatchScore(source, swapped) < TyreCore.QUOTE_MATCH_THRESHOLD,
    'every token is real, but the claim is not'
  );
  assert.equal(TyreCore.quoteMatchScore(source, 'profit for the period 812.44'), 1);
});

test('computeDeltas does not invent a movement', () => {
  const at = (quarter, revenue, unit) =>
    TyreCore.recToStoredShape(
      { company: 'Apollo Tyres', quarter, currency: { code: 'INR', unit }, core: { revenue } },
      { source: `fixture:${quarter}` }
    );

  // Same company, same quarter, reached two ways — not a quarter's movement.
  assert.deepEqual(TyreCore.computeDeltas([at('Q1 FY26', 100, 'Crore'), at('Q1 FY26', 100, 'Crore')]), []);

  // 'Crore' and 'Crores' are the same basis spelled two ways.
  const spelling = TyreCore.computeDeltas([at('Q4 FY25', 100, 'Crore'), at('Q1 FY26', 110, 'Crores')]);
  assert.equal(spelling.length, 1);
  assert.equal(spelling[0].metrics.revenue.abs, 10);
  assert.equal(Math.round(spelling[0].metrics.revenue.pct), 10);

  // A genuine basis change is not comparable and must stay null.
  const basis = TyreCore.computeDeltas([at('Q4 FY25', 100, 'Crore'), at('Q1 FY26', 110, 'Million')]);
  assert.equal(basis[0].metrics.revenue, null);
});

test('a rejected record never reaches the Q&A model', () => {
  const rec = (company, status) => {
    const r = TyreCore.recToStoredShape(
      { company, quarter: 'Q1 FY26', currency: { code: 'INR', unit: 'Crore' }, core: { revenue: 100 } },
      { source: 'fixture:x' }
    );
    r.review.status = status;
    return r;
  };

  const prompt = TyreCore.buildQAPrompt(
    [rec('Apollo Tyres', 'approved'), rec('MRF', 'rejected'), rec('CEAT', 'pending')],
    'Rank these companies by revenue.'
  );

  assert.equal(prompt.record_count, 2);
  assert.equal(prompt.excluded_rejected, 1);
  assert.ok(!prompt.user.includes('MRF'), 'a record a human rejected is a wrong record');
  assert.ok(prompt.user.includes('Apollo Tyres') && prompt.user.includes('CEAT'));
  assert.ok(/1 human-approved, 1 still pending/.test(prompt.user), 'the model is told what it is looking at');
});
