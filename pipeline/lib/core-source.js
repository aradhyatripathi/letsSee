/* ==== TYRE-CORE:BEGIN ====
 * Single source of truth for the data contract shared by the dashboard and the
 * Node pipeline. This file is inlined verbatim into
 * dashboard/tyre_comparison_dashboard.html between the TYRE-CORE markers, and
 * loaded by pipeline/lib/core.mjs. `npm run sync:core` copies it into the
 * dashboard; `npm test` fails if the two ever drift apart.
 *
 * Plain script — no imports, no exports, no top-level await. Everything hangs
 * off the TyreCore object defined at the bottom.
 */

/* ---------------------------------------------------------------- schema -- */

// Copied verbatim from the build spec, Section 2. Every stage keys off this.
var SCHEMA_HINT = [
  '{',
  '  company, quarter,                       // strings, or null',
  '  currency: { code, unit },               // INR/USD/... , Crore/Million/...',
  '  core: {',
  '    revenue, ebitda, ebitda_margin, pat, net_margin, roe, roce,',
  '    debt_equity, current_ratio, quick_ratio, interest_coverage,',
  '    total_assets, total_liabilities, total_equity, cash,',
  '    ocf, capex_amt, fcf, inv_turnover, dso, dpo',
  '    // number or null, never estimated',
  '  },',
  '  core_quotes: { ...same keys as core, short exact quote or "" },',
  '  segments: {',
  '    channels: { replacement, oem, export },',
  '    product_categories: { TBR, TBB, PCR, "2W", OHT }',
  '  },',
  '  outlook: { commentary, rm_trend, capex }  // paraphrased, no verbatim quotes',
  '}'
].join('\n');

// key: field name in `core`. money: true means the value carries the record's
// currency unit; pct: a percentage; ratio: a bare multiple; days: a day count.
var CORE_METRICS = [
  { key: 'revenue',            label: 'Revenue',              kind: 'money' },
  { key: 'ebitda',             label: 'EBITDA',               kind: 'money' },
  { key: 'ebitda_margin',      label: 'EBITDA Margin',        kind: 'pct'   },
  { key: 'pat',                label: 'PAT',                  kind: 'money' },
  { key: 'net_margin',         label: 'Net Margin',           kind: 'pct'   },
  { key: 'roe',                label: 'ROE',                  kind: 'pct'   },
  { key: 'roce',               label: 'ROCE',                 kind: 'pct'   },
  { key: 'debt_equity',        label: 'Debt / Equity',        kind: 'ratio' },
  { key: 'current_ratio',      label: 'Current Ratio',        kind: 'ratio' },
  { key: 'quick_ratio',        label: 'Quick Ratio',          kind: 'ratio' },
  { key: 'interest_coverage',  label: 'Interest Coverage',    kind: 'ratio' },
  { key: 'total_assets',       label: 'Total Assets',         kind: 'money' },
  { key: 'total_liabilities',  label: 'Total Liabilities',    kind: 'money' },
  { key: 'total_equity',       label: 'Total Equity',         kind: 'money' },
  { key: 'cash',               label: 'Cash',                 kind: 'money' },
  { key: 'ocf',                label: 'Operating Cash Flow',  kind: 'money' },
  { key: 'capex_amt',          label: 'Capex',                kind: 'money' },
  { key: 'fcf',                label: 'Free Cash Flow',       kind: 'money' },
  { key: 'inv_turnover',       label: 'Inventory Turnover',   kind: 'ratio' },
  { key: 'dso',                label: 'DSO',                  kind: 'days'  },
  { key: 'dpo',                label: 'DPO',                  kind: 'days'  }
];

var CORE_KEYS = CORE_METRICS.map(function (m) { return m.key; });

var CHANNEL_KEYS = ['replacement', 'oem', 'export'];
var PRODUCT_KEYS = ['TBR', 'TBB', 'PCR', '2W', 'OHT'];
var OUTLOOK_KEYS = ['commentary', 'rm_trend', 'capex'];

// Indicative rates, used only to put every company on one axis for comparison.
// Reported figures are always kept in their source currency and unit; the
// normalized value is a derived convenience, never a substitute for the source.
var FX_TO_INR = { INR: 1, USD: 83, EUR: 90, GBP: 105, KRW: 0.06, JPY: 0.56, CNY: 11.5 };

// What the dashboard fills in when a filing does not state its scale.
var DEFAULT_UNIT_FOR_CURRENCY = {
  INR: 'Crore', USD: 'Million', EUR: 'Million', GBP: 'Million',
  KRW: 'Billion', JPY: 'Billion', CNY: 'Million'
};

// Multiplier from one unit into INR crore (1 crore = 10 million).
var UNIT_TO_CRORE = {
  crore: 1,
  cr: 1,
  lakh: 0.01,
  million: 0.1,
  mn: 0.1,
  bn: 100,
  billion: 100,
  thousand: 0.0001,
  actual: 0.0000001,
  unit: 0.0000001,
  '': 1
};

/* -------------------------------------------------------------- utilities -- */

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function unitKey(unit) {
  return String(unit == null ? '' : unit).trim().toLowerCase().replace(/s$/, '');
}

function fxToInr(code) {
  var c = String(code == null ? 'INR' : code).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(FX_TO_INR, c) ? FX_TO_INR[c] : null;
}

// Convert a reported money figure into INR crore. Returns null when the value is
// absent or the currency/unit is not one we can convert without guessing.
function toInrCrore(value, currency) {
  if (!isNum(value)) return null;
  var cur = currency || {};
  var fx = fxToInr(cur.code);
  if (fx == null) return null;
  var mult = UNIT_TO_CRORE[unitKey(cur.unit)];
  if (mult == null) return null;
  return value * fx * mult;
}

function formatMetric(value, metric, currency) {
  if (!isNum(value)) return '—';
  var kind = metric && metric.kind;
  if (kind === 'pct') return value.toFixed(1) + '%';
  if (kind === 'ratio') return value.toFixed(2) + 'x';
  if (kind === 'days') return Math.round(value) + ' days';
  var cur = currency || {};
  var suffix = [cur.code || '', cur.unit || ''].filter(Boolean).join(' ');
  var shown = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return suffix ? shown + ' ' + suffix : shown;
}

// Cheap deterministic id so re-importing the same filing twice is detectable.
function recordId(company, quarter, source) {
  var basis = [company || '', quarter || '', source || ''].join('|').toLowerCase();
  var h = 5381;
  for (var i = 0; i < basis.length; i++) {
    h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  }
  var slug = String(company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  var q = String(quarter || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug + '_' + q + '_' + h.toString(36);
}

/* -------------------------------------------------------- stored transform -- */

// Extraction output -> stored shape. Field-for-field, no invention: anything the
// model did not report stays null, and quotes stay exactly as returned.
function recToStoredShape(rec, opts) {
  var o = opts || {};
  var r = rec || {};
  var cur = r.currency || {};
  var code = cur.code == null ? null : String(cur.code).trim().toUpperCase() || null;
  var unit = cur.unit == null ? null : String(cur.unit).trim() || null;

  var core = {};
  var quotes = {};
  var srcCore = r.core || {};
  var srcQuotes = r.core_quotes || {};
  for (var i = 0; i < CORE_KEYS.length; i++) {
    var k = CORE_KEYS[i];
    var v = srcCore[k];
    core[k] = isNum(v) ? v : null;
    var q = srcQuotes[k];
    quotes[k] = typeof q === 'string' ? q : '';
  }

  var segIn = r.segments || {};
  var chIn = segIn.channels || {};
  var pcIn = segIn.product_categories || {};
  var channels = {};
  var products = {};
  for (var c = 0; c < CHANNEL_KEYS.length; c++) {
    channels[CHANNEL_KEYS[c]] = isNum(chIn[CHANNEL_KEYS[c]]) ? chIn[CHANNEL_KEYS[c]] : null;
  }
  for (var p = 0; p < PRODUCT_KEYS.length; p++) {
    products[PRODUCT_KEYS[p]] = isNum(pcIn[PRODUCT_KEYS[p]]) ? pcIn[PRODUCT_KEYS[p]] : null;
  }

  var outIn = r.outlook || {};
  var outlook = {};
  for (var oi = 0; oi < OUTLOOK_KEYS.length; oi++) {
    var ov = outIn[OUTLOOK_KEYS[oi]];
    outlook[OUTLOOK_KEYS[oi]] = typeof ov === 'string' && ov.trim() ? ov.trim() : null;
  }

  var company = r.company == null ? null : String(r.company).trim() || null;
  var quarter = r.quarter == null ? null : String(r.quarter).trim() || null;
  var source = o.source == null ? null : String(o.source);

  return {
    id: o.id || recordId(company, quarter, source),
    company: company,
    quarter: quarter,
    source: source,
    currency: { code: code, unit: unit, fx_to_inr: fxToInr(code) },
    core: core,
    quotes: quotes,
    segments: { channels: channels, product_categories: products },
    outlook: outlook,
    review: o.review || { status: 'pending', reviewer: null, reviewed_at: null, note: null },
    retrieved_at: o.retrieved_at || null,
    verification: o.verification || null
  };
}

// Structural check on a stored record. Returns a list of human-readable problems;
// empty means the record is well-formed (it says nothing about whether the
// numbers are right — that is what review is for).
function validateStored(rec) {
  var errs = [];
  if (!rec || typeof rec !== 'object') return ['record is not an object'];
  if (!rec.company) errs.push('missing company');
  if (!rec.quarter) errs.push('missing quarter');
  if (!rec.currency || !rec.currency.code) errs.push('missing currency.code');
  if (!rec.currency || !rec.currency.unit) errs.push('missing currency.unit');
  if (!rec.core || typeof rec.core !== 'object') {
    errs.push('missing core');
  } else {
    for (var i = 0; i < CORE_KEYS.length; i++) {
      var k = CORE_KEYS[i];
      if (!(k in rec.core)) errs.push('core.' + k + ' absent (expected number or null)');
      else if (rec.core[k] !== null && !isNum(rec.core[k])) errs.push('core.' + k + ' is not a number or null');
    }
  }
  if (!rec.quotes || typeof rec.quotes !== 'object') errs.push('missing quotes');
  if (!rec.segments || !rec.segments.channels || !rec.segments.product_categories) {
    errs.push('missing segments');
  }
  return errs;
}

/* ---------------------------------------------------- quote verification -- */

// Normalize for matching only. Collapses whitespace, unifies the quote marks and
// dashes a PDF extractor mangles, drops the rest of the punctuation, lowercases.
function normalizeForMatch(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9%.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s) {
  var t = normalizeForMatch(s).split(' ');
  var out = [];
  for (var i = 0; i < t.length; i++) if (t[i]) out.push(t[i]);
  return out;
}

// Length of the longest common subsequence of two token arrays. Order-sensitive,
// which is the whole point: it is what stops a quote reassembled from the
// document's own words out of order from scoring as if it were verbatim.
function lcsLength(a, b) {
  var prev = new Array(b.length + 1).fill(0);
  var cur = new Array(b.length + 1).fill(0);
  for (var i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (var j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : (prev[j] > cur[j - 1] ? prev[j] : cur[j - 1]);
    }
    var swap = prev; prev = cur; cur = swap;
  }
  return prev[b.length];
}

// How well `quote` matches some span of `sourceText`. A verbatim quote scores 1;
// a paraphrase, a fabrication, or a quote stitched together from words that all
// appear in the document but not in that order scores below it.
//
// Two passes, because order matters but is expensive: a cheap sliding multiset
// scan finds the windows worth looking at, then those candidates are re-scored
// by longest common subsequence so word order counts. Scoring on the multiset
// alone would give "revenue 812.44 ... profit 6,543.21" a perfect score against
// a source that says the opposite.
function quoteMatchScore(sourceText, quote) {
  var nq = normalizeForMatch(quote);
  if (!nq) return 0;
  var ns = normalizeForMatch(sourceText);
  if (!ns) return 0;
  if (ns.indexOf(nq) !== -1) return 1;

  var qt = tokenize(quote);
  if (!qt.length) return 0;
  var st = tokenize(sourceText);
  if (!st.length) return 0;

  var want = {};
  for (var i = 0; i < qt.length; i++) want[qt[i]] = (want[qt[i]] || 0) + 1;

  var win = qt.length;
  var have = {};
  var matched = 0;
  var candidates = [];
  var bestBag = 0;

  function add(tok) {
    have[tok] = (have[tok] || 0) + 1;
    if (want[tok] && have[tok] <= want[tok]) matched++;
  }
  function drop(tok) {
    if (want[tok] && have[tok] <= want[tok]) matched--;
    have[tok]--;
  }

  for (var j = 0; j < st.length; j++) {
    add(st[j]);
    if (j >= win) drop(st[j - win]);
    if (matched > bestBag) bestBag = matched;
    // A window can only beat the current best on order if its bag of words is
    // already close, so this is a safe filter and keeps the LCS pass bounded.
    if (matched >= win * 0.6) candidates.push(Math.max(0, j - win + 1));
  }

  // The bag score is an upper bound on the ordered score, so a bag that never
  // gets close cannot produce a match and needs no second pass.
  if (!candidates.length) return bestBag / win;

  var STRIDE = Math.max(1, Math.ceil(candidates.length / 400));
  var best = 0;
  for (var c = 0; c < candidates.length; c += STRIDE) {
    var start = candidates[c];
    var score = lcsLength(qt, st.slice(start, start + win)) / win;
    if (score > best) best = score;
    if (best === 1) break;
  }
  return best;
}

// Does the figure actually appear in the span quoted to support it? Verifying
// the quote against the source proves the sentence is real; it does not prove it
// is the sentence this number came from. Indian quarterly tables carry three or
// four comparative columns, so a model can quote a perfectly genuine row label
// and still report the prior quarter's number from it.
function quoteContainsValue(quote, value) {
  if (!isNum(value)) return true;

  // Period labels and dates are how a filing names the column, not the figure in
  // it. Left in, they are candidate numbers: a fabricated ROCE of 26 would
  // "verify" against the text FY26, and a 1 against Q1. Strip them first.
  // A bare four-digit number is deliberately NOT stripped — it can be a genuine
  // figure (revenue of 2,025 crore) and is only a year in the patterns below.
  var scrubbed = String(quote == null ? '' : quote)
    .replace(/\b(?:FY|CY)\s*'?\s*\d{2,4}\b/gi, ' ')
    .replace(/\b[QH]\s*[1-4]\b/gi, ' ')
    .replace(/\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*,?\s*\d{2,4}\b/gi, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*,?\s*\d{2,4}\b/gi, ' ');

  // Indian filings write a loss in the accounting convention — "(1,234.50)" —
  // so a parenthesised figure is the negative of what it reads as. Without this
  // a correctly-quoted loss fails the check and the whole record is thrown away.
  var found = scrubbed.match(/\(\s*\d[\d,]*(?:\.\d+)?\s*\)|-?\d[\d,]*(?:\.\d+)?/g);
  if (!found) return false;

  // Percentages and ratios are often quoted rounded ("margin of 14.5%" for
  // 14.53), so allow a tolerance that scales with the figure's own magnitude.
  var tolerance = Math.max(0.05, Math.abs(value) * 0.005);
  for (var i = 0; i < found.length; i++) {
    var token = found[i];
    var n = parseFloat(token.replace(/[(),\s]/g, ''));
    if (!isFinite(n)) continue;
    if (token.charAt(0) === '(') n = -n;
    if (Math.abs(n - value) <= tolerance) return true;
  }
  return false;
}

var QUOTE_MATCH_THRESHOLD = 0.85;

// Section 4 / Stage 2: this is the actual enforcement of "never fabricate a
// quote". Every non-empty quote must be traceable back to the retrieved source
// text; a number reported without a quote is flagged rather than silently kept.
function verifyQuotes(rec, sourceText, opts) {
  var threshold = (opts && typeof opts.threshold === 'number') ? opts.threshold : QUOTE_MATCH_THRESHOLD;
  var core = (rec && rec.core) || {};
  var quotes = (rec && (rec.quotes || rec.core_quotes)) || {};
  var checks = [];
  var failed = 0;
  var unquoted = 0;

  for (var i = 0; i < CORE_KEYS.length; i++) {
    var k = CORE_KEYS[i];
    var value = core[k];
    var quote = quotes[k];
    var hasValue = isNum(value);
    var hasQuote = typeof quote === 'string' && quote.trim().length > 0;

    if (!hasValue && !hasQuote) continue;

    if (hasValue && !hasQuote) {
      unquoted++;
      checks.push({ key: k, value: value, quote: '', score: 0, status: 'unquoted' });
      continue;
    }

    var score = quoteMatchScore(sourceText, quote);
    var status;
    if (score < threshold) status = 'not_found';
    else if (hasValue && !quoteContainsValue(quote, value)) status = 'value_not_in_quote';
    else status = 'verified';
    if (status !== 'verified') failed++;
    checks.push({ key: k, value: hasValue ? value : null, quote: quote, score: Math.round(score * 1000) / 1000, status: status });
  }

  return {
    ok: failed === 0,
    threshold: threshold,
    checked: checks.length,
    verified: checks.filter(function (c) { return c.status === 'verified'; }).length,
    failed: failed,
    not_found: checks.filter(function (c) { return c.status === 'not_found'; }).length,
    value_not_in_quote: checks.filter(function (c) { return c.status === 'value_not_in_quote'; }).length,
    unquoted: unquoted,
    checks: checks
  };
}

/* ------------------------------------------------------------- comparison -- */

// Sortable key for a period label, or null when the label does not parse —
// callers fall back to insertion order.
//
// The Indian companies file on a fiscal year ("Q1 FY26", "Q3FY2025", "H1 FY26");
// the global ones a comparison would pull in file on a calendar year ("Q1 2026",
// "Q1 CY26"). Both are handled. Note the two are on separate numbering, so a
// CY-labelled quarter and an FY-labelled quarter covering the same real months do
// not land on the same key — that ambiguity is inherent in comparing fiscal-year
// against calendar-year reporters, not something a label parser can resolve.
function quarterSortKey(quarter) {
  if (!quarter) return null;
  var s = String(quarter).toUpperCase();

  var q = /Q\s*([1-4])/.exec(s);
  var h = /H\s*([12])/.exec(s);
  var period = q ? parseInt(q[1], 10) : (h ? parseInt(h[1], 10) * 2 : 0);

  var fy = /FY\s*'?\s*(\d{2,4})/.exec(s);
  var cy = /CY\s*'?\s*(\d{2,4})/.exec(s) || /\b(20\d{2})\b/.exec(s);
  var m = fy || cy;
  if (!m) return null;

  var year = parseInt(m[1], 10);
  if (year < 100) year += 2000;
  return year * 10 + period;
}

// Quarter-over-quarter change per company, on reported values (same currency and
// unit by construction — a currency change between quarters yields null).
function computeDeltas(records) {
  var byCompany = {};
  (records || []).forEach(function (r) {
    var name = r.company || 'Unknown';
    (byCompany[name] = byCompany[name] || []).push(r);
  });

  var out = [];
  Object.keys(byCompany).forEach(function (name) {
    var rows = byCompany[name].slice().sort(function (a, b) {
      var ka = quarterSortKey(a.quarter), kb = quarterSortKey(b.quarter);
      if (ka == null || kb == null) return 0;
      return ka - kb;
    });
    for (var i = 1; i < rows.length; i++) {
      var prev = rows[i - 1], cur = rows[i];
      // Two records for the same company and quarter are the same filing reached
      // two ways, not a quarter's movement — comparing them would invent a delta.
      var kPrev = quarterSortKey(prev.quarter), kCur = quarterSortKey(cur.quarter);
      if (kPrev != null && kCur != null && kPrev >= kCur) continue;
      if (kPrev == null && kCur == null && String(prev.quarter) === String(cur.quarter)) continue;
      // Compare the basis, not its spelling: an extraction that returns "Crores"
      // where another returned "Crore" has not changed units.
      var sameBasis =
        String((prev.currency || {}).code || '').toUpperCase() === String((cur.currency || {}).code || '').toUpperCase() &&
        unitKey((prev.currency || {}).unit) === unitKey((cur.currency || {}).unit);
      var metrics = {};
      for (var m = 0; m < CORE_KEYS.length; m++) {
        var k = CORE_KEYS[m];
        var a = prev.core ? prev.core[k] : null;
        var b = cur.core ? cur.core[k] : null;
        if (!sameBasis || !isNum(a) || !isNum(b)) { metrics[k] = null; continue; }
        metrics[k] = { from: a, to: b, abs: b - a, pct: a === 0 ? null : ((b - a) / Math.abs(a)) * 100 };
      }
      out.push({ company: name, from_quarter: prev.quarter, to_quarter: cur.quarter, metrics: metrics });
    }
  });
  return out;
}

/* ---------------------------------------------------------------- prompts -- */

// The guardrails live here, not in the caller: never fabricate a quote, never
// estimate a number, detect currency and unit explicitly from the source.
var EXTRACTION_SYSTEM = [
  'You extract financial data from Indian tyre-sector quarterly filings into a fixed JSON schema.',
  '',
  'Rules, in order of importance:',
  '1. Never fabricate a quote. Every value in core_quotes must be a short span copied',
  '   character-for-character from the source text. If you cannot copy an exact span',
  '   supporting a figure, return "" for that quote and null for that figure.',
  '2. Never estimate, derive, annualize, or infer a number. If the filing does not state',
  '   it, the value is null. A margin you computed yourself is not a reported margin.',
  '3. Detect currency and unit explicitly from the source (e.g. "INR"/"Crore",',
  '   "USD"/"Million"). Do not assume. If the source does not say, use null.',
  '4. Report figures exactly as stated, in the source\'s own unit. Do not rescale.',
  '5. outlook fields are paraphrased management commentary — no verbatim quotes there.',
  '6. Segment values are the share or value as reported; null when not broken out.',
  '',
  'Return one JSON object and nothing else. No markdown fence, no commentary.'
].join('\n');

// Section 4 / Stage 2 flags the 60,000-char truncation as a risk on a full
// quarterly report. We keep a much larger budget and, when we must cut, we keep
// the financial-statement region rather than blindly taking the first N chars.
var SOURCE_CHAR_BUDGET = 400000;

var FINANCIAL_SECTION_HINTS = [
  'statement of profit and loss', 'profit and loss', 'financial results',
  'balance sheet', 'cash flow', 'segment', 'ebitda', 'revenue from operations',
  'total income', 'earnings per share', 'unaudited', 'audited'
];

// Keep the densest financial region when a filing exceeds the budget. Scores
// fixed-size windows by how many statement markers they contain and keeps the
// best contiguous span, plus the head of the document for company/quarter context.
function selectFinancialText(text, budget) {
  var src = String(text == null ? '' : text);
  var cap = budget || SOURCE_CHAR_BUDGET;
  if (src.length <= cap) return { text: src, truncated: false, strategy: 'full' };

  var lower = src.toLowerCase();
  var head = Math.min(4000, Math.floor(cap * 0.05));
  var body = cap - head;
  var step = Math.max(1000, Math.floor(body / 20));

  var bestStart = 0;
  var bestScore = -1;
  for (var start = 0; start + body <= src.length; start += step) {
    var windowText = lower.slice(start, start + body);
    var score = 0;
    for (var h = 0; h < FINANCIAL_SECTION_HINTS.length; h++) {
      var hint = FINANCIAL_SECTION_HINTS[h];
      var idx = windowText.indexOf(hint);
      while (idx !== -1) { score++; idx = windowText.indexOf(hint, idx + hint.length); }
    }
    if (score > bestScore) { bestScore = score; bestStart = start; }
  }

  var kept = src.slice(0, head) + '\n\n[... document trimmed to the financial-statement section ...]\n\n' +
             src.slice(bestStart, bestStart + body);
  return { text: kept, truncated: true, strategy: 'financial-section', kept_from: bestStart, source_length: src.length };
}

function buildExtractionPrompt(sourceText, hints) {
  var h = hints || {};
  var sel = selectFinancialText(sourceText, h.budget);
  var lines = [];
  if (h.company) lines.push('Expected company: ' + h.company + ' (correct it if the filing disagrees).');
  if (h.quarter) lines.push('Expected quarter: ' + h.quarter + ' (correct it if the filing disagrees).');
  var user = [
    lines.join('\n'),
    '',
    'Extract into exactly this schema:',
    SCHEMA_HINT,
    '',
    'Source filing text:',
    '"""',
    sel.text,
    '"""'
  ].join('\n');
  return { system: EXTRACTION_SYSTEM, user: user, selection: sel };
}

var QA_SYSTEM = [
  'You answer questions about Indian tyre companies using ONLY the reviewed records provided below.',
  '',
  'Rules:',
  '1. Answer only from the provided records. These records are the whole world.',
  '2. If the records do not contain the answer, say so plainly — do not fall back on',
  '   general knowledge about these companies, and do not guess.',
  '3. Whenever you cite a number, show the record\'s stored quote for that figure',
  '   alongside it, with the company and quarter. A number with no quote in the record',
  '   should be reported as unverified.',
  '4. Cross-company comparisons are expected. Compare only figures on the same currency',
  '   and unit basis; if the bases differ, say so instead of converting silently.',
  '5. Null means "not reported in that filing", which is different from zero.',
  '',
  'You also know the structure of the workbook this dashboard exports, and may answer',
  'questions about it directly:',
  '- "Core Financials": one row per company, one column per core metric, current quarter.',
  '- "Segments": channel (replacement/OEM/export) and product-category breakdowns.',
  '- "Outlook": commentary, raw-material trend, and capex per company.',
  '- "Sources & Quotes": every figure with its exact source quote, keyed COMPANY|QUARTER|metric,',
  '  which is what each Core Financials cell comment points at.'
].join('\n');

// Records are serialized whole so cross-company questions work; the filter is
// applied by the caller only when the question clearly scopes to one company.
function buildQAPrompt(records, question, opts) {
  var o = opts || {};
  // A record a human looked at and rejected is a wrong record. It must not reach
  // the model at all, let alone under a heading calling it reviewed.
  var all = records || [];
  var usable = all.filter(function (r) { return !(r.review && r.review.status === 'rejected'); });
  var excluded = all.length - usable.length;
  var payload = usable.map(function (r) {
    return {
      company: r.company,
      quarter: r.quarter,
      source: r.source,
      currency: r.currency,
      review_status: r.review && r.review.status,
      core: r.core,
      quotes: r.quotes,
      segments: r.segments,
      outlook: r.outlook
    };
  });
  var approved = payload.filter(function (r) { return r.review_status === 'approved'; }).length;
  var header = 'Records available to answer from: ' + payload.length +
    ' (' + approved + ' human-approved, ' + (payload.length - approved) + ' still pending review).' +
    (excluded ? ' ' + excluded + ' rejected record(s) were withheld.' : '');
  var user = [
    header,
    'A record still pending review has not been checked by a person — say so when you rely on one.',
    '',
    JSON.stringify(payload, null, o.pretty === false ? 0 : 1),
    '',
    'Question: ' + String(question == null ? '' : question)
  ].join('\n');
  return { system: QA_SYSTEM, user: user, record_count: payload.length, excluded_rejected: excluded };
}

// Models occasionally wrap JSON in a fence or add a sentence around it despite
// instructions. Recover the object rather than failing the whole extraction.
function parseModelJSON(text) {
  var s = String(text == null ? '' : text).trim();
  var fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (e) { /* fall through to brace scan */ }

  var start = s.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in model output');
  var depth = 0, inStr = false, esc = false;
  for (var i = start; i < s.length; i++) {
    var ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON object in model output');
}

/* --------------------------------------------------------------- workbook -- */

// Builds a renderer-agnostic model of the four-sheet workbook. The dashboard
// feeds this to SheetJS; tests assert on it directly without a spreadsheet.
// Every populated Core Financials cell carries a comment pointing at its
// COMPANY|metric row in "Sources & Quotes", so a reader can verify any number
// without leaving the workbook.
function buildWorkbookModel(records, opts) {
  var o = opts || {};
  // A record a human rejected is a wrong record: it is withheld unconditionally,
  // not merely when the reviewedOnly toggle is on. reviewedOnly then narrows
  // further, to records a person has positively approved.
  var rows = (records || []).filter(function (r) {
    return !(r.review && r.review.status === 'rejected');
  });
  if (o.reviewedOnly) {
    rows = rows.filter(function (r) { return r.review && r.review.status === 'approved'; });
  }
  rows.sort(function (a, b) { return String(a.company || '').localeCompare(String(b.company || '')); });

  var DASH = '—';
  var comments = [];
  var colLetter = function (n) {
    var s = '';
    n = n + 1;
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  // A figure is only uniquely addressable once the quarter is part of its key —
  // storage holds more than one quarter as soon as anyone backfills.
  var refFor = function (r, key) {
    return (r.company || 'Unknown') + '|' + (r.quarter || 'Unknown') + '|' + key;
  };

  /* Core Financials: companies as rows, metrics as columns. */
  var coreHeader = ['Company', 'Quarter', 'Currency', 'Unit', 'Source'];
  CORE_METRICS.forEach(function (m) { coreHeader.push(m.label); });
  var coreAoa = [coreHeader];
  var META_COLS = coreHeader.length - CORE_METRICS.length;

  rows.forEach(function (r, rowIdx) {
    var line = [
      r.company || DASH,
      r.quarter || DASH,
      (r.currency && r.currency.code) || DASH,
      (r.currency && r.currency.unit) || DASH,
      r.source || DASH
    ];
    CORE_METRICS.forEach(function (m, mi) {
      var v = r.core ? r.core[m.key] : null;
      line.push(isNum(v) ? v : DASH);
      if (isNum(v)) {
        var ref = refFor(r, m.key);
        var quote = (r.quotes && r.quotes[m.key]) || '';
        comments.push({
          sheet: 'Core Financials',
          addr: colLetter(META_COLS + mi) + (rowIdx + 2),
          ref: ref,
          text: quote
            ? 'Source quote (' + ref + '): "' + quote + '"'
            : 'No source quote stored for ' + ref + ' — unverified.'
        });
      }
    });
    coreAoa.push(line);
  });

  /* Segments: channel + product-category breakdowns. */
  var segHeader = ['Company', 'Quarter'];
  CHANNEL_KEYS.forEach(function (k) { segHeader.push('Channel: ' + k); });
  PRODUCT_KEYS.forEach(function (k) { segHeader.push('Product: ' + k); });
  var segAoa = [segHeader];
  rows.forEach(function (r) {
    var line = [r.company || DASH, r.quarter || DASH];
    var ch = (r.segments && r.segments.channels) || {};
    var pc = (r.segments && r.segments.product_categories) || {};
    CHANNEL_KEYS.forEach(function (k) { line.push(isNum(ch[k]) ? ch[k] : DASH); });
    PRODUCT_KEYS.forEach(function (k) { line.push(isNum(pc[k]) ? pc[k] : DASH); });
    segAoa.push(line);
  });

  /* Outlook: paraphrased management commentary. */
  var outAoa = [['Company', 'Quarter', 'Commentary', 'Raw Material Trend', 'Capex']];
  rows.forEach(function (r) {
    var ol = r.outlook || {};
    outAoa.push([
      r.company || DASH,
      r.quarter || DASH,
      ol.commentary || DASH,
      ol.rm_trend || DASH,
      ol.capex || DASH
    ]);
  });

  /* Sources & Quotes: the audit sheet every Core Financials cell points at. */
  var srcAoa = [['Ref', 'Company', 'Quarter', 'Metric', 'Value', 'Currency', 'Unit', 'Source Quote', 'Verification', 'Source']];
  rows.forEach(function (r) {
    var vmap = {};
    if (r.verification && r.verification.checks) {
      r.verification.checks.forEach(function (c) { vmap[c.key] = c.status; });
    }
    CORE_METRICS.forEach(function (m) {
      var v = r.core ? r.core[m.key] : null;
      var q = (r.quotes && r.quotes[m.key]) || '';
      if (!isNum(v) && !q) return;
      srcAoa.push([
        refFor(r, m.key),
        r.company || DASH,
        r.quarter || DASH,
        m.label,
        isNum(v) ? v : DASH,
        (r.currency && r.currency.code) || DASH,
        (r.currency && r.currency.unit) || DASH,
        q || DASH,
        vmap[m.key] || (q ? 'unchecked' : 'unquoted'),
        r.source || DASH
      ]);
    });
  });

  return {
    generated_for: rows.length,
    sheets: [
      { name: 'Core Financials', aoa: coreAoa, widths: [22, 12, 10, 10, 26].concat(CORE_METRICS.map(function () { return 16; })), freeze: 'F2' },
      { name: 'Segments',        aoa: segAoa,  widths: [22, 12].concat(CHANNEL_KEYS.concat(PRODUCT_KEYS).map(function () { return 16; })), freeze: 'C2' },
      { name: 'Outlook',         aoa: outAoa,  widths: [22, 12, 70, 40, 40], freeze: 'C2', wrap: [2, 3, 4] },
      { name: 'Sources & Quotes', aoa: srcAoa, widths: [26, 22, 12, 22, 14, 10, 10, 80, 14, 40], freeze: 'B2', wrap: [7] }
    ],
    comments: comments
  };
}

/* ----------------------------------------------------------------- export -- */

var TyreCore = {
  SCHEMA_HINT: SCHEMA_HINT,
  CORE_METRICS: CORE_METRICS,
  CORE_KEYS: CORE_KEYS,
  CHANNEL_KEYS: CHANNEL_KEYS,
  PRODUCT_KEYS: PRODUCT_KEYS,
  OUTLOOK_KEYS: OUTLOOK_KEYS,
  FX_TO_INR: FX_TO_INR,
  QUOTE_MATCH_THRESHOLD: QUOTE_MATCH_THRESHOLD,
  SOURCE_CHAR_BUDGET: SOURCE_CHAR_BUDGET,
  EXTRACTION_SYSTEM: EXTRACTION_SYSTEM,
  QA_SYSTEM: QA_SYSTEM,
  STORAGE_KEY: 'tyre-records-v2',

  isNum: isNum,
  fxToInr: fxToInr,
  toInrCrore: toInrCrore,
  formatMetric: formatMetric,
  recordId: recordId,
  recToStoredShape: recToStoredShape,
  validateStored: validateStored,
  normalizeForMatch: normalizeForMatch,
  quoteMatchScore: quoteMatchScore,
  verifyQuotes: verifyQuotes,
  quarterSortKey: quarterSortKey,
  computeDeltas: computeDeltas,
  selectFinancialText: selectFinancialText,
  buildExtractionPrompt: buildExtractionPrompt,
  buildQAPrompt: buildQAPrompt,
  parseModelJSON: parseModelJSON,
  buildWorkbookModel: buildWorkbookModel
};

if (typeof window !== 'undefined') { window.TyreCore = TyreCore; }
if (typeof globalThis !== 'undefined') { globalThis.TyreCore = TyreCore; }
/* ==== TYRE-CORE:END ==== */
