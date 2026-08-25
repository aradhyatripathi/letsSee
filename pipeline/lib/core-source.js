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

/* --------------------------------------------------------------- text safety -- */

// Everything this project writes is XML underneath — .xlsx and .pptx both are — so a
// character XML 1.0 cannot carry is not a cosmetic problem. It makes the part
// not-well-formed, and the readers that notice do not report an error: they open the file
// and silently drop content from that point on.
//
// Such characters reach us from real input. A PDF text string may be UTF-16BE, and
// pdf.mjs decodes it code unit by code unit, so the byte pair FF FF in a filing becomes
// U+FFFF and travels into a quote or a commentary field without anything objecting.
//
// This is applied where text enters (retrieval) and again where a record is stored, so no
// stored record can carry something the outputs cannot represent. The deck renderer keeps
// its own copy of the same rule deliberately: it is the last line before bytes are
// written, and a format guarantee should not depend on an upstream step having run.
function sanitizeText(value) {
  var str = String(value == null ? '' : value);
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      var next = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) { out += str.charAt(i) + str.charAt(i + 1); i++; }
      continue;                                   // lone high surrogate
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;     // lone low surrogate
    if (c === 0xfffe || c === 0xffff) continue;   // not characters
    if (c === 0x7f) continue;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    out += str.charAt(i);
  }
  return out;
}

/** Every string in a record, cleaned. Structure and numbers are untouched. */
function sanitizeRecordText(node) {
  if (typeof node === 'string') return sanitizeText(node);
  if (Array.isArray(node)) return node.map(sanitizeRecordText);
  if (node && typeof node === 'object') {
    var out = {};
    for (var k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) out[k] = sanitizeRecordText(node[k]);
    }
    return out;
  }
  return node;
}

/* ------------------------------------------------------------ review state -- */

// One place decides what a record's review state is.
//
// Every output used to compare `r.review.status === 'rejected'` at its own call site,
// which meant a status of 'Rejected' or ' rejected ' — trivially present in a file
// written by anything other than this dashboard — sailed past every one of those filters
// and put a record a person had thrown out into the workbook, the deck and the model's
// context. The comparison is normalised here instead, once, and everything asks this.
//
// Anything unrecognisable is 'pending': never approved, so it cannot reach an
// approved-only export, and never silently treated as a rejection either.
function reviewStatus(record) {
  if (!record || typeof record !== 'object') return 'pending';
  var raw = record.review && record.review.status;
  var s = String(raw == null ? '' : raw).trim().toLowerCase();
  return s === 'approved' || s === 'rejected' ? s : 'pending';
}

function isApproved(record) { return reviewStatus(record) === 'approved'; }
function isRejected(record) { return reviewStatus(record) === 'rejected'; }

// A records array can arrive from a file. Anything that is not an object cannot be
// filtered, formatted or verified, and dropping it here beats a TypeError three frames
// down inside a workbook renderer.
function usableRecords(records) {
  return (records || []).filter(function (r) { return r && typeof r === 'object'; });
}

/* -------------------------------------------------------- stored transform -- */

// Extraction output -> stored shape. Field-for-field, no invention: anything the
// model did not report stays null, and quotes stay exactly as returned.
function recToStoredShape(rec, opts) {
  var o = opts || {};
  // Cleaned on the way in, so no stored record can carry a character the workbook, the
  // deck or the archive cannot represent.
  var r = sanitizeRecordText(rec || {});
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

// The normalized and tokenized source, computed once.
//
// Normalizing runs five regex passes over the whole filing and tokenizing splits
// the result, and verifyQuotes calls the matcher once per metric — so a record
// with 21 quotes did all of that 21 times against a source that had not changed.
// On a 400,000-character filing that is most of the wall clock in verification,
// and in the browser it is the review screen not painting.
function prepareSource(sourceText) {
  var normalized = normalizeForMatch(sourceText);
  var tokens = [];
  var split = normalized.split(' ');
  for (var i = 0; i < split.length; i++) if (split[i]) tokens.push(split[i]);
  return { normalized: normalized, tokens: tokens };
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
function quoteMatchScore(sourceText, quote, prepared) {
  var nq = normalizeForMatch(quote);
  if (!nq) return 0;
  var source = prepared || prepareSource(sourceText);
  var ns = source.normalized;
  if (!ns) return 0;
  if (ns.indexOf(nq) !== -1) return 1;

  var qt = tokenize(quote);
  if (!qt.length) return 0;
  var st = source.tokens;
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

// A quote is a span, not a document.
//
// Without this bound the central safety property is vacuous. quoteMatchScore's
// fast path asks whether the normalized quote appears in the normalized source,
// and a document is trivially a substring of itself — so a record whose "quote"
// for PAT is the whole filing scores 1 and is marked verified, and
// quoteContainsValue then only has to find the figure somewhere in those
// thousands of characters. A filing stating PAT of 300 crore will happily
// "verify" a reported PAT of 4321 because 4321 is the headcount two lines down.
//
// pipeline/archive.mjs already knew this and refused such a record at the
// archive (MAX_STRING_CHARS). That was the wrong place: everything between
// extraction and the archive — the reviewer's green badge, the deck's "N of N
// quotes verified" footnote, the workbook's Verification column, the quote the
// Q&A model is told to cite — had already repeated the claim.
//
// 400 characters: the quotes the offline extractor produces from the fixtures
// run 22-84 characters (median 66), and a P&L caption with three comparative
// columns and a long line label is comfortably under 200. Anything past 400 is
// not a citation of a figure, whatever else it may be.
var MAX_QUOTE_CHARS = 400;

// The absolute cap is not the whole rule, because it is only a citation relative
// to the thing cited. A 199-character "filing" quoted in full is 199 characters —
// inside the cap, and still evidence of nothing: the figure is "in the quote"
// only in the sense that it is somewhere in the document.
//
// Half is deliberately loose. A real quote is a line out of a filing, so it runs
// a few percent of the source at most; the fixtures come to 1-2%. The bound is
// set where no honest quote can reach it, so that it only ever fires on a quote
// that is standing in for the document.
var MAX_QUOTE_SOURCE_SHARE = 0.5;

// Is this a citation of a line, or a stand-in for the document? Returns the
// reason it is not a citation, or '' when it is one — phrased for the reviewer,
// because they are the person who has to act on it.
function oversizeReason(quote, sourceText) {
  var len = quote.length;
  if (len > MAX_QUOTE_CHARS) {
    return len + ' characters — a section of the filing, not the line reporting the figure (the limit is ' + MAX_QUOTE_CHARS + ')';
  }
  var sourceLen = String(sourceText == null ? '' : sourceText).length;
  if (sourceLen && len > sourceLen * MAX_QUOTE_SOURCE_SHARE) {
    return 'the quote is ' + Math.round((len / sourceLen) * 100) + '% of the whole document, so it points at no particular figure in it';
  }
  return '';
}

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
  var prepared = prepareSource(sourceText);

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

    // Size is checked before matching, not after: an oversized quote is not a
    // low-scoring quote, it is a quote that would score 1 for the wrong reason.
    // Checking first also keeps the matcher's cost bounded by MAX_QUOTE_CHARS
    // rather than by whatever length a filing hands us.
    var status;
    var score;
    var detail = oversizeReason(quote, sourceText);
    if (detail) {
      status = 'quote_too_long';
      score = 0;
    } else {
      score = quoteMatchScore(sourceText, quote, prepared);
      if (score < threshold) status = 'not_found';
      else if (hasValue && !quoteContainsValue(quote, value)) status = 'value_not_in_quote';
      else status = 'verified';
    }
    if (status !== 'verified') failed++;
    var check = { key: k, value: hasValue ? value : null, quote: quote, score: Math.round(score * 1000) / 1000, status: status };
    if (detail) check.detail = detail;
    checks.push(check);
  }

  return {
    // A figure reported with no quote at all is a failure, not a note in the margin.
    // The prompt's own rule is that a figure you cannot quote is returned as null, so an
    // unquoted figure is the model breaking that rule — and counting it as acceptable
    // meant a record of twenty-one fabricated numbers with no quotes anywhere reported
    // ok: true and was stored.
    ok: failed === 0 && unquoted === 0,
    threshold: threshold,
    checked: checks.length,
    verified: checks.filter(function (c) { return c.status === 'verified'; }).length,
    failed: failed,
    not_found: checks.filter(function (c) { return c.status === 'not_found'; }).length,
    value_not_in_quote: checks.filter(function (c) { return c.status === 'value_not_in_quote'; }).length,
    quote_too_long: checks.filter(function (c) { return c.status === 'quote_too_long'; }).length,
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
  '   character-for-character from the source text — the line that reports the figure,',
  '   at most ' + MAX_QUOTE_CHARS + ' characters. A longer span is rejected: quoting a whole section',
  '   proves nothing about which number in it you meant. If you cannot copy an exact',
  '   span supporting a figure, return "" for that quote and null for that figure.',
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
  var all = usableRecords(records);
  var usable = all.filter(function (r) { return !isRejected(r); });
  var excluded = all.length - usable.length;
  var payload = usable.map(function (r) {
    return {
      company: r.company,
      quarter: r.quarter,
      source: r.source,
      currency: r.currency,
      review_status: reviewStatus(r),
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
// Keys that make an object one of ours rather than some other JSON in the text.
var SCHEMA_KEYS = ['company', 'quarter', 'currency', 'core', 'core_quotes', 'quotes', 'segments', 'outlook'];

function looksLikeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (var i = 0; i < SCHEMA_KEYS.length; i++) {
    if (Object.prototype.hasOwnProperty.call(value, SCHEMA_KEYS[i])) return true;
  }
  return false;
}

// Every balanced region in the text for one bracket pair, as { at, text }, outermost
// only, ignoring brackets inside strings. `unterminated` says an opener never closed,
// which is worth telling the operator apart from "there was no JSON here at all".
function balancedRegions(s, open, close) {
  var out = [];
  var depth = 0, start = -1, inStr = false, esc = false, unterminated = false;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) { if (depth === 0) start = i; depth++; }
    else if (ch === close) {
      depth--;
      if (depth === 0 && start !== -1) { out.push({ at: start, text: s.slice(start, i + 1) }); start = -1; }
      if (depth < 0) depth = 0;
    }
  }
  if (depth > 0) unterminated = true;
  out.unterminated = unterminated;
  return out;
}

/**
 * Recover the record object from a model's answer.
 *
 * The answer may arrive as a bare object, inside a fence, or — on the hand-carried
 * route — pasted out of a whole chat, where the model may have answered once and then
 * corrected itself. Taking the first object found meant the superseded draft won and the
 * correction was silently discarded, so candidates are tried from the END of the text
 * backwards: the last thing the model said is what the person meant to hand over.
 */
function parseModelJSON(text) {
  var s = String(text == null ? '' : text);
  var candidates = [];

  var fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  var m;
  while ((m = fence.exec(s)) !== null) candidates.push({ at: m.index, text: m[1].trim() });
  var objects = balancedRegions(s, '{', '}');
  objects.forEach(function (r) { candidates.push(r); });
  candidates.push({ at: -1, text: s.trim() });

  // An array of records is refused before anything else. The object scan would otherwise
  // reach inside one and return whichever element it happened to land on — quietly
  // picking one filing out of several is worse than refusing to pick.
  var arrays = balancedRegions(s, '[', ']');
  for (var a = 0; a < arrays.length; a++) {
    var whole;
    try { whole = JSON.parse(arrays[a].text); } catch (e) { continue; }
    if (Array.isArray(whole) && whole.some(looksLikeRecord)) {
      throw new Error(
        'the answer is a JSON array of ' + whole.length + ' object(s); this schema is one object ' +
        'per filing, so send the object for this company on its own'
      );
    }
  }

  candidates.sort(function (a, b) { return b.at - a.at; });

  var sawObject = false;
  for (var i = 0; i < candidates.length; i++) {
    var parsed;
    try { parsed = JSON.parse(candidates[i].text); } catch (e) { continue; }
    if (Array.isArray(parsed)) continue;
    if (looksLikeRecord(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') sawObject = true;
  }

  if (sawObject) {
    throw new Error('found JSON, but no object carrying the schema (expected company/quarter/core/core_quotes)');
  }
  if (objects.unterminated) {
    throw new Error('unterminated JSON object in model output — the answer looks cut off');
  }
  throw new Error('no JSON object found in model output');
}

/* --------------------------------------------------------------- workbook -- */

// Builds a renderer-agnostic model of the four-sheet workbook. The dashboard
// feeds this to TyreXlsx; tests assert on it directly without opening a spreadsheet.
// Every populated Core Financials cell carries a comment pointing at its
// COMPANY|metric row in "Sources & Quotes", so a reader can verify any number
// without leaving the workbook.
function buildWorkbookModel(records, opts) {
  var o = opts || {};
  // A record a human rejected is a wrong record: it is withheld unconditionally,
  // not merely when the reviewedOnly toggle is on. reviewedOnly then narrows
  // further, to records a person has positively approved.
  var rows = usableRecords(records).filter(function (r) { return !isRejected(r); });
  if (o.reviewedOnly) {
    rows = rows.filter(isApproved);
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
  // A workbook that does not say which rows a person checked lets an unreviewed figure
  // sit in the same table as a reviewed one, indistinguishable, in the file that
  // circulates furthest. The column is present whether or not reviewedOnly is set,
  // because "all of these are approved" is exactly the assumption a reader would make.
  var coreHeader = ['Company', 'Quarter', 'Review', 'Currency', 'Unit', 'Source'];
  CORE_METRICS.forEach(function (m) { coreHeader.push(m.label); });
  var coreAoa = [coreHeader];
  var META_COLS = coreHeader.length - CORE_METRICS.length;

  rows.forEach(function (r, rowIdx) {
    var line = [
      r.company || DASH,
      r.quarter || DASH,
      reviewLabel(r),
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
  var srcAoa = [['Ref', 'Company', 'Quarter', 'Review', 'Metric', 'Value', 'Currency', 'Unit', 'Source Quote', 'Verification', 'Source']];
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
        reviewLabel(r),
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
      { name: 'Core Financials', aoa: coreAoa, widths: [22, 12, 22, 10, 10, 26].concat(CORE_METRICS.map(function () { return 16; })), freeze: 'G2' },
      { name: 'Segments',        aoa: segAoa,  widths: [22, 12].concat(CHANNEL_KEYS.concat(PRODUCT_KEYS).map(function () { return 16; })), freeze: 'C2' },
      { name: 'Outlook',         aoa: outAoa,  widths: [22, 12, 70, 40, 40], freeze: 'C2', wrap: [2, 3, 4] },
      { name: 'Sources & Quotes', aoa: srcAoa, widths: [26, 22, 12, 22, 22, 14, 10, 10, 80, 14, 40], freeze: 'B2', wrap: [8] }
    ],
    comments: comments
  };
}

/* ----------------------------------------------------------------- export -- */


/* -------------------------------------------------------------- deck model -- */

// Slide groupings. Between them these name all 21 core metrics exactly once,
// which is asserted in the tests: a metric added to CORE_METRICS and forgotten
// here would quietly never reach the deck.
var DECK_SECTIONS = [
  { title: 'Headline comparison',      keys: ['revenue', 'ebitda', 'ebitda_margin', 'pat'] },
  { title: 'Profitability and returns', keys: ['net_margin', 'roe', 'roce'] },
  { title: 'Leverage and liquidity',   keys: ['debt_equity', 'current_ratio', 'quick_ratio', 'interest_coverage'] },
  { title: 'Balance sheet',            keys: ['total_assets', 'total_liabilities', 'total_equity', 'cash'] },
  { title: 'Cash generation',          keys: ['ocf', 'capex_amt', 'fcf'] },
  { title: 'Working capital',          keys: ['inv_turnover', 'dso', 'dpo'] }
];

/**
 * The deck as data: sheets of strings, no rendering, no file format.
 *
 * Same review rule as the workbook, for the same reason — a deck circulates
 * further than a spreadsheet does, so a record a person rejected must not be in
 * it under any option. `reviewedOnly` then narrows to positively approved.
 *
 * Figures are shown as reported, never converted. When the selected records do
 * not share one currency the unit moves into its own column and the slide says
 * so, because a column of numbers in three currencies read as one ranking is the
 * most plausible way this deck could mislead someone.
 */
function buildDeckModel(records, opts) {
  var o = opts || {};
  var all = usableRecords(records);
  var rejected = all.filter(isRejected);
  var rows = all.filter(function (r) { return !isRejected(r); });
  if (o.reviewedOnly) {
    rows = rows.filter(isApproved);
  }
  rows.sort(function (a, b) { return String(a.company || '').localeCompare(String(b.company || '')); });

  var DASH = '—';
  var metricByKey = {};
  CORE_METRICS.forEach(function (m) { metricByKey[m.key] = m; });

  // Once an archive exists the input spans several quarters, and a comparison
  // table built from all of them would list each company once per quarter and
  // read as though they were different companies. The comparison slides are one
  // quarter — the latest, unless asked for another — and the extra quarters
  // become the trend slides at the end, which is the point of keeping them.
  var history = rows.slice();
  var quarters = uniqueStrings(history.map(function (r) { return r.quarter; }))
    .sort(function (a, b) { return (quarterSortKey(a) || 0) - (quarterSortKey(b) || 0); });
  var quarter = o.quarter || quarters[quarters.length - 1] || 'no quarter';
  // A record with no quarter cannot join a quarter's comparison, but it must not simply
  // disappear either — it is counted and named on the provenance slide instead.
  var undated = history.filter(function (r) { return !String(r.quarter || '').trim(); });
  if (quarters.length) {
    rows = history.filter(function (r) { return String(r.quarter || '') === quarter; });
  }

  // A record with no currency is its own case, not a silent member of whatever the others
  // reported. Folding it in let the deck state "figures in INR Crore" over a figure whose
  // unit nobody knows.
  var currencies = uniqueStrings(rows.map(function (r) {
    return currencyLabelOf(r) || 'currency not stated';
  }));
  var oneCurrency = currencies.length === 1 && currencies[0] !== 'currency not stated'
    ? currencies[0]
    : null;

  var approved = rows.filter(isApproved);
  var pending = rows.filter(function (r) { return reviewStatus(r) === 'pending'; });
  var reviewers = uniqueStrings(approved.map(function (r) { return r.review && r.review.reviewer; }));

  var tally = { verified: 0, not_found: 0, value_not_in_quote: 0, quote_too_long: 0, unquoted: 0, checked: 0 };
  rows.forEach(function (r) {
    var v = r.verification;
    if (!v) return;
    tally.checked += v.checked || 0;
    tally.verified += v.verified || 0;
    tally.unquoted += v.unquoted || 0;
    (v.checks || []).forEach(function (c) {
      if (c.status === 'not_found') tally.not_found++;
      if (c.status === 'value_not_in_quote') tally.value_not_in_quote++;
      if (c.status === 'quote_too_long') tally.quote_too_long++;
    });
  });

  // The counts are scoped explicitly, because they used to mix scopes: `total` counted the
  // focus quarter while `rejected_withheld` counted the whole input, so they did not add
  // up and a reader could not tell why.
  var provenance = {
    input_records: all.length,
    total: rows.length,
    quarter: quarter,
    archived_quarters: quarters,
    other_quarters_held_back: history.length - rows.length - undated.length,
    undated_withheld: undated.length,
    approved: approved.length,
    pending: pending.length,
    rejected_withheld: rejected.length,
    reviewers: reviewers,
    currencies: currencies,
    quarters: quarters,
    verification: tally
  };

  var slides = [];

  slides.push({
    kind: 'title',
    title: 'Indian tyre sector — ' + quarter,
    subtitle: rows.length
      ? rows.length + ' compan' + (rows.length === 1 ? 'y' : 'ies') + (oneCurrency ? ' · figures in ' + oneCurrency : '')
      : 'No records selected',
    footnote: 'Generated from reviewed filing extracts. Every figure traces to a quote from the filing it came from.'
  });

  if (!rows.length) {
    slides.push({
      kind: 'bullets',
      title: 'Nothing to show',
      bullets: [
        'No records were available for this deck.',
        rejected.length
          ? rejected.length + ' record' + (rejected.length === 1 ? ' was' : 's were') + ' withheld because a reviewer rejected ' + (rejected.length === 1 ? 'it' : 'them') + '.'
          : 'Import a run and review it first — a deck is built from reviewed records, not from raw extractions.'
      ]
    });
    return { title: 'Indian tyre sector — ' + quarter, quarter: quarter, generated_at: o.generatedAt || null, provenance: provenance, slides: slides };
  }

  slides.push({
    kind: 'bullets',
    title: 'How to read this deck',
    bullets: [
      'Every figure was copied from a company filing by an extraction step that must quote its source. A figure whose quote could not be found in the filing is not in this deck.',
      provenance.approved + ' of ' + provenance.total + ' records were approved by a person' + (reviewers.length ? ' (' + reviewers.join(', ') + ')' : '') + '.' +
        (provenance.pending ? ' ' + provenance.pending + ' are still pending review and are marked on their slide.' : ''),
      provenance.rejected_withheld
        ? provenance.rejected_withheld + ' record' + (provenance.rejected_withheld === 1 ? '' : 's') + ' rejected in review ' + (provenance.rejected_withheld === 1 ? 'is' : 'are') + ' withheld from this deck entirely.'
        : 'No record was rejected in review.',
      oneCurrency
        ? 'All figures are in ' + oneCurrency + ', as reported. Nothing has been converted or rescaled.'
        : 'Figures are in each company’s own reporting currency, shown per row. They are NOT converted, so the columns are not directly comparable.',
      'Blank cells (' + DASH + ') mean the filing did not state that figure. They are not zeros.',
      heldBackNote(provenance, quarter, DASH)
    ].filter(Boolean),
    footnote: 'Quote coverage: ' + tally.verified + ' verified, ' + tally.unquoted + ' reported without a quote, across ' + tally.checked + ' checks.'
  });

  DECK_SECTIONS.forEach(function (section) {
    var columns = ['Company'];
    if (!oneCurrency) columns.push('Currency');
    section.keys.forEach(function (k) {
      var m = metricByKey[k];
      columns.push(m ? m.label : k);
    });

    var body = rows.map(function (r) {
      var line = [companyLabel(r)];
      if (!oneCurrency) line.push(currencyLabelOf(r) || DASH);
      section.keys.forEach(function (k) {
        var v = r.core ? r.core[k] : null;
        // The unit is carried once per row by the Currency column, or once per
        // slide by the subtitle. Repeating it in every cell only crowds the table.
        line.push(isNum(v) ? formatMetric(v, metricByKey[k], null) : DASH);
      });
      return line;
    });

    pushTableSlides(slides, {
      title: section.title,
      subtitle: quarter + (oneCurrency ? ' · figures in ' + oneCurrency : ' · figures in each company’s own currency'),
      columns: columns,
      rows: body,
      footnote: [
        oneCurrency ? null : 'Currencies differ across rows — do not read across as a ranking.',
        pendingNote(rows)
      ].filter(Boolean).join(' ') || null
    });
  });

  pushTableSlides(slides, {
    title: 'Channel mix',
    subtitle: quarter + ' · as reported; blank where not broken out',
    columns: ['Company'].concat(CHANNEL_KEYS.map(titleCase)),
    rows: rows.map(function (r) {
      var ch = (r.segments && r.segments.channels) || {};
      return [companyLabel(r)].concat(CHANNEL_KEYS.map(function (k) {
        return isNum(ch[k]) ? String(ch[k]) : DASH;
      }));
    }),
    footnote: pendingNote(rows)
  });

  pushTableSlides(slides, {
    title: 'Product mix',
    subtitle: quarter + ' · as reported; blank where not broken out',
    columns: ['Company'].concat(PRODUCT_KEYS),
    rows: rows.map(function (r) {
      var pc = (r.segments && r.segments.product_categories) || {};
      return [companyLabel(r)].concat(PRODUCT_KEYS.map(function (k) {
        return isNum(pc[k]) ? String(pc[k]) : DASH;
      }));
    }),
    footnote: pendingNote(rows)
  });

  if (quarters.length > 1) {
    [
      { key: 'revenue', title: 'Revenue by quarter' },
      { key: 'ebitda_margin', title: 'EBITDA margin by quarter' }
    ].forEach(function (trend) {
      var metric = metricByKey[trend.key];
      var companies = uniqueStrings(history.map(function (r) { return r.company; })).sort();
      var body = companies.map(function (name) {
        var line = [name];
        quarters.forEach(function (q) {
          var found = null;
          history.forEach(function (r) {
            if (String(r.company || '') === name && String(r.quarter || '') === q) found = r;
          });
          var v = found && found.core ? found.core[trend.key] : null;
          line.push(isNum(v) ? formatMetric(v, metric, null) : DASH);
        });
        return line;
      });
      // The claim has to be computed, not assumed: with reviewedOnly off, history holds
      // unreviewed records from earlier quarters too, and a slide asserting that every
      // figure on it was approved would be stating something false.
      var unreviewedInHistory = history.filter(function (r) { return !isApproved(r); }).length;
      pushTableSlides(slides, {
        title: trend.title,
        subtitle: quarters.length + ' quarters · as reported, never converted',
        columns: ['Company'].concat(quarters),
        rows: body,
        footnote: (unreviewedInHistory
          ? unreviewedInHistory + ' of these ' + history.length + ' records have not been reviewed by a person.'
          : 'Every figure here was approved by a person.') +
          ' A blank means that quarter is not present for that company.'
      });
    });
  }

  pushBulletSlides(slides, {
    title: 'Outlook — raw materials',
    subtitle: 'Paraphrased management commentary, not quoted',
    bullets: rows.map(function (r) {
      return companyLabel(r) + ': ' + (clipText((r.outlook && r.outlook.rm_trend) || '', 220) || 'no raw-material commentary in the filing');
    })
  });

  pushBulletSlides(slides, {
    title: 'Outlook — capex and guidance',
    subtitle: 'Paraphrased management commentary, not quoted',
    bullets: rows.map(function (r) {
      return companyLabel(r) + ': ' + (clipText((r.outlook && r.outlook.capex) || '', 220) || 'no capex commentary in the filing');
    })
  });

  rows.forEach(function (r) {
    var v = r.verification || {};
    var status = isApproved(r)
      ? 'Approved' + (r.review && r.review.reviewer ? ' by ' + r.review.reviewer : '')
      : 'PENDING REVIEW — not yet checked by a person';
    var pairs = CORE_METRICS.filter(function (m) { return isNum(r.core && r.core[m.key]); })
      .map(function (m) { return [m.label, formatMetric(r.core[m.key], m, r.currency)]; });
    // Twenty-one metrics down one column would be unreadable at slide size, so
    // they run down two columns instead: rows 1..n/2 on the left, the rest right.
    var lines = pairTwoUp(pairs, DASH);

    slides.push({
      kind: 'table',
      title: r.company || 'Unknown company',
      subtitle: (r.quarter || quarter) + ' · ' + (currencyLabelOf(r) || 'currency not stated') + ' · ' + status,
      columns: ['Metric', 'As reported', 'Metric', 'As reported'],
      align: ['l', 'r', 'l', 'r'],
      rows: lines.length ? lines : [['—', 'No figures were extracted from this filing', '', '']],
      footnote: [
        (v.verified || 0) + ' of ' + (v.checked || 0) + ' quotes verified against the filing',
        r.outlook && r.outlook.commentary ? clipText(r.outlook.commentary, 200) : null,
        r.source ? 'Source: ' + r.source : null
      ].filter(Boolean).join(' · ')
    });
  });

  slides.push({
    kind: 'bullets',
    title: 'What this deck cannot tell you',
    bullets: [
      'Quote verification proves a figure was copied from the filing. It does not prove the right table was read — standalone results where consolidated were wanted, or a segment sub-total read as a group total, would pass every automatic check.',
      'That is what the human review step is for, and why there is no auto-accept path at any scale.',
      provenance.pending
        ? provenance.pending + ' record' + (provenance.pending === 1 ? '' : 's') + ' in this deck ' + (provenance.pending === 1 ? 'has' : 'have') + ' not been reviewed yet and should be treated as a draft.'
        : 'Every record in this deck has been reviewed and approved by a person.',
      tally.unquoted
        ? tally.unquoted + ' figure' + (tally.unquoted === 1 ? ' was' : 's were') + ' reported without any quote at all. Those are the first ones to check.'
        : 'Every figure in this deck arrived with a quote.',
      'Figures are as reported by each company. Different companies close their books differently; this deck does not restate them onto a common basis.'
    ]
  });

  return {
    title: 'Indian tyre sector — ' + quarter,
    subtitle: slides[0].subtitle,
    quarter: quarter,
    generated_at: o.generatedAt || null,
    provenance: provenance,
    slides: slides
  };
}

// A slide holds about a dozen table rows before the type gets too small to read
// from the back of a room. Anything longer continues on the next slide rather
// than being silently cut — the roster is deliberately not a fixed size.
var MAX_TABLE_ROWS = 12;
var MAX_BULLETS = 8;

// The footnote repeats on every continuation slide rather than appearing once at the end.
// It carries the caveats — that the columns are in different currencies and are not a
// ranking, that a starred company has not been reviewed — and a caveat that appears only
// on the last of three slides is worse than none: the reader looking at slide one sees a
// clean table and no warning at all.
function pushTableSlides(slides, spec) {
  var chunks = chunk(spec.rows, MAX_TABLE_ROWS);
  if (!chunks.length) chunks = [[]];
  chunks.forEach(function (part, i) {
    slides.push({
      kind: 'table',
      title: i === 0 ? spec.title : spec.title + ' (cont.)',
      subtitle: spec.subtitle || null,
      columns: spec.columns,
      align: spec.align || null,
      rows: part,
      footnote: footnoteFor(spec.footnote, chunks.length, i)
    });
  });
}

function pushBulletSlides(slides, spec) {
  var chunks = chunk(spec.bullets, MAX_BULLETS);
  if (!chunks.length) chunks = [[]];
  chunks.forEach(function (part, i) {
    slides.push({
      kind: 'bullets',
      title: i === 0 ? spec.title : spec.title + ' (cont.)',
      subtitle: spec.subtitle || null,
      bullets: part,
      footnote: footnoteFor(spec.footnote, chunks.length, i)
    });
  });
}

function footnoteFor(footnote, total, index) {
  var parts = [];
  if (footnote) parts.push(footnote);
  if (total > 1) parts.push('Slide ' + (index + 1) + ' of ' + total + ' for this table.');
  return parts.length ? parts.join(' ') : null;
}

function chunk(list, size) {
  var out = [];
  for (var i = 0; i < (list || []).length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// [[a,1],[b,2],[c,3]] with a dash filler -> [[a,1,c,3],[b,2,'—','']]
function pairTwoUp(pairs, dash) {
  var half = Math.ceil(pairs.length / 2);
  var out = [];
  for (var i = 0; i < half; i++) {
    var left = pairs[i];
    var right = pairs[i + half];
    out.push([left[0], left[1], right ? right[0] : '', right ? right[1] : '']);
  }
  return out;
}

// Anything the deck declined to show is said out loud on the slide that explains the
// deck, rather than being silently absent.
function heldBackNote(p, quarter, dash) {
  var parts = [];
  if (p.other_quarters_held_back) {
    parts.push(p.other_quarters_held_back + ' record' + (p.other_quarters_held_back === 1 ? '' : 's') +
      ' from other quarters are not on the comparison slides — those compare ' + quarter + ' only.');
  }
  if (p.undated_withheld) {
    parts.push(p.undated_withheld + ' record' + (p.undated_withheld === 1 ? '' : 's') +
      ' state no quarter and could not be placed, so ' + (p.undated_withheld === 1 ? 'it is' : 'they are') +
      ' not shown anywhere in this deck.');
  }
  return parts.length ? parts.join(' ') : null;
}

// What the review column says. Spelled out rather than a tick, because this ends up in a
// spreadsheet someone reads a month later with no other context.
function reviewLabel(r) {
  var status = reviewStatus(r);
  if (status === 'approved') {
    var who = r.review && r.review.reviewer;
    return who ? 'Approved by ' + who : 'Approved';
  }
  return 'NOT REVIEWED';
}

function companyLabel(r) {
  var name = r.company || 'Unknown';
  return isApproved(r) ? name : name + ' *';
}

// The asterisk is the only thing separating a reviewed figure from an unreviewed
// one on a slide someone will read out of context, so it says what it means on
// every slide that uses it rather than only in the preamble.
function pendingNote(rows) {
  var n = rows.filter(function (r) { return !isApproved(r); }).length;
  return n ? '* not yet reviewed by a person — treat as draft.' : null;
}

function currencyLabelOf(r) {
  if (!r.currency) return '';
  return [r.currency.code, r.currency.unit].filter(Boolean).join(' ');
}

function uniqueStrings(values) {
  var seen = {};
  var out = [];
  (values || []).forEach(function (v) {
    var s = v == null ? '' : String(v).trim();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out;
}

function titleCase(s) {
  var str = String(s || '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function clipText(value, max) {
  var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!s || s.length <= max) return s;
  // Back off one unit when the cut would land between the halves of an astral
  // character, which would otherwise leave a lone surrogate in the text.
  var cut = max - 1;
  var last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + '…';
}

var TyreCore = {
  SCHEMA_HINT: SCHEMA_HINT,
  CORE_METRICS: CORE_METRICS,
  CORE_KEYS: CORE_KEYS,
  CHANNEL_KEYS: CHANNEL_KEYS,
  PRODUCT_KEYS: PRODUCT_KEYS,
  OUTLOOK_KEYS: OUTLOOK_KEYS,
  FX_TO_INR: FX_TO_INR,
  QUOTE_MATCH_THRESHOLD: QUOTE_MATCH_THRESHOLD,
  MAX_QUOTE_CHARS: MAX_QUOTE_CHARS,
  SOURCE_CHAR_BUDGET: SOURCE_CHAR_BUDGET,
  EXTRACTION_SYSTEM: EXTRACTION_SYSTEM,
  QA_SYSTEM: QA_SYSTEM,
  STORAGE_KEY: 'tyre-records-v2',

  isNum: isNum,
  sanitizeText: sanitizeText,
  reviewStatus: reviewStatus,
  isApproved: isApproved,
  isRejected: isRejected,
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
  buildWorkbookModel: buildWorkbookModel,
  buildDeckModel: buildDeckModel,
  DECK_SECTIONS: DECK_SECTIONS
};

if (typeof window !== 'undefined') { window.TyreCore = TyreCore; }
if (typeof globalThis !== 'undefined') { globalThis.TyreCore = TyreCore; }
/* ==== TYRE-CORE:END ==== */
