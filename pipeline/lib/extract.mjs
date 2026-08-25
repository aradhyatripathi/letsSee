// Stage 2 — extraction and quote verification (build spec, Section 4).
//
// Two routes to the same contract:
//   extractRecord()        — Claude, for a real run.
//   extractRecordOffline() — deterministic regexes, for fixture runs and tests.
//
// Both end in recToStoredShape -> validateStored -> verifyQuotes, so neither can
// produce a record the other would not be allowed to produce. Quote verification
// is the enforcement of "never fabricate a quote": a record whose quotes are not
// traceable to the retrieved source text is returned as a failure with the detail
// attached, never as a record with a warning on it.
//
// Neither route ever sets review.status: extraction produces candidates, Stage 4
// produces accepted records.

import { callMessages, DEFAULT_MODEL } from './anthropic.mjs';
import { TyreCore } from './core.mjs';

const EXTRACTION_MAX_TOKENS = 8000;
const OFFLINE_EXTRACTOR = 'offline-regex';
const MANUAL_EXTRACTOR = 'claude-manual';

/**
 * Extract one filing with Claude, verifying every quote against the source text.
 *
 * Never throws. One company's bad filing comes back as `{ ok: false, error }`
 * so the other eight in the run still complete.
 *
 * @param {object} options
 * @param {string} options.sourceText     Retrieved filing text (Stage 1 output).
 * @param {string} options.company        Expected company name.
 * @param {string} options.quarter        Expected quarter label, e.g. 'Q1 FY26'.
 * @param {string} [options.source]       Where the text came from; stored on the record.
 * @param {string} [options.apiKey]       Falls back to ANTHROPIC_API_KEY.
 * @param {string} [options.model]        Default claude-sonnet-4-6.
 * @param {number} [options.maxTokens]    Output budget, default 8000.
 * @param {number} [options.retries]      Re-extractions after a quote-verification
 *                                        failure, default 1.
 * @param {string} [options.retrievedAt]  ISO timestamp of retrieval; defaults to now.
 * @param {number} [options.timeoutMs]    Per-request timeout.
 * @param {AbortSignal} [options.signal]  Caller cancellation.
 * @returns {Promise<{ok:boolean, record:(object|null), verification:(object|null),
 *                    raw:(string|null), attempts:Array<object>, error:(string|null),
 *                    selection:(object|null), extractor:string}>}
 */
export async function extractRecord({
  sourceText,
  company,
  quarter,
  source = null,
  apiKey = null,
  model = DEFAULT_MODEL,
  maxTokens = EXTRACTION_MAX_TOKENS,
  retries = 1,
  retrievedAt = null,
  timeoutMs = undefined,
  signal = null
} = {}) {
  const who = describe(company, quarter);
  const result = {
    ok: false,
    record: null,
    verification: null,
    raw: null,
    attempts: [],
    error: null,
    selection: null,
    extractor: `claude:${model}`
  };

  try {
    const text = String(sourceText ?? '');
    if (!text.trim()) {
      result.error = `${who}: no source text to extract from`;
      return result;
    }

    const prompt = TyreCore.buildExtractionPrompt(text, { company, quarter });
    // The caller logs this: a trimmed filing is the first thing to suspect when a
    // balance-sheet figure comes back null.
    result.selection = prompt.selection;

    const totalAttempts = Math.max(0, Math.trunc(retries)) + 1;
    const stamp = retrievedAt || new Date().toISOString();
    let correction = null;

    for (let n = 1; n <= totalAttempts; n++) {
      const attempt = { n, model, ok: false, stop_reason: null, usage: null, verification: null, error: null };
      result.attempts.push(attempt);

      const call = await callMessages({
        apiKey,
        model,
        system: prompt.system,
        user: correction ? `${prompt.user}\n\n${correction}` : prompt.user,
        maxTokens,
        timeoutMs,
        signal
      });
      attempt.stop_reason = call.stop_reason;
      attempt.usage = call.usage;

      if (!call.ok) {
        attempt.error = call.error;
        result.error = `${who}: ${call.error}`;
        return result;
      }
      result.raw = call.text;

      let parsed;
      try {
        parsed = TyreCore.parseModelJSON(call.text);
      } catch (err) {
        attempt.error = err.message;
        const truncated =
          call.stop_reason === 'max_tokens'
            ? ` — the response stopped at the ${maxTokens}-token limit, so the JSON is cut off; raise maxTokens`
            : '';
        result.error = `${who}: could not read JSON from the model output (${err.message})${truncated}`;
        return result;
      }

      const { record, problems, verification } = toVerifiedRecord({
        parsed,
        sourceText: text,
        source,
        retrievedAt: stamp,
        extractor: result.extractor
      });
      result.record = record;

      if (problems.length) {
        attempt.error = problems.join('; ');
        result.error = `${who}: the extracted record is not well-formed: ${problems.join('; ')}`;
        return result;
      }

      result.verification = verification;
      attempt.verification = summarise(verification);

      if (verification.ok) {
        attempt.ok = true;
        result.ok = true;
        return result;
      }

      const unfound = verification.checks.filter((c) => c.status === 'not_found');
      attempt.error = `quotes not found in the source: ${unfound.map((c) => c.key).join(', ')}`;
      correction = buildCorrection(unfound, verification.threshold);
    }

    const failing = result.verification.checks.filter((c) => c.status === 'not_found').map((c) => c.key);
    result.error =
      `${who}: quote verification failed after ${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'} — ` +
      `no source span could be found for ${failing.join(', ')}. The record is attached unaccepted; ` +
      're-run this company, or extract it by hand.';
    return result;
  } catch (err) {
    result.error = `${who}: extraction failed: ${err.message}`;
    return result;
  }
}

/**
 * Deterministic, no-API extraction — the route fixture runs and tests take.
 *
 * Every quote is a span sliced out of the source text itself, so verifyQuotes is
 * doing real work on this path too rather than being waved through. Anything the
 * patterns do not find stays null; nothing here computes a figure the filing did
 * not state.
 *
 * @param {object} options
 * @param {string} options.sourceText
 * @param {string} options.company
 * @param {string} options.quarter
 * @param {string} [options.source]
 * @param {string} [options.retrievedAt]
 * @returns {{ok:boolean, record:(object|null), verification:(object|null),
 *            raw:(string|null), attempts:Array<object>, error:(string|null),
 *            selection:null, extractor:string}}
 */
export function extractRecordOffline({ sourceText, company, quarter, source = null, retrievedAt = null } = {}) {
  const who = describe(company, quarter);
  const result = {
    ok: false,
    record: null,
    verification: null,
    raw: null,
    attempts: [],
    error: null,
    selection: null,
    extractor: OFFLINE_EXTRACTOR
  };

  try {
    const text = String(sourceText ?? '');
    if (!text.trim()) {
      result.error = `${who}: no source text to extract from`;
      return result;
    }

    const found = readCoreMetrics(text);
    const parsed = {
      company: company ?? null,
      quarter: quarter ?? readQuarter(text),
      currency: readCurrency(text),
      core: found.core,
      core_quotes: found.quotes,
      segments: readSegments(text),
      outlook: readOutlook(text)
    };
    result.raw = JSON.stringify(parsed, null, 1);

    const { record, problems, verification } = toVerifiedRecord({
      parsed,
      sourceText: text,
      source,
      retrievedAt: retrievedAt || new Date().toISOString(),
      extractor: OFFLINE_EXTRACTOR
    });
    result.record = record;

    if (problems.length) {
      result.attempts.push({ n: 1, extractor: OFFLINE_EXTRACTOR, ok: false, verification: null, error: problems.join('; ') });
      result.error = `${who}: the offline extractor produced a record that is not well-formed: ${problems.join('; ')}`;
      return result;
    }

    result.verification = verification;
    result.attempts.push({
      n: 1,
      extractor: OFFLINE_EXTRACTOR,
      ok: verification.ok,
      verification: summarise(verification),
      error: verification.ok ? null : 'quotes not found in the source'
    });

    if (!verification.ok) {
      const failing = verification.checks.filter((c) => c.status === 'not_found').map((c) => c.key);
      result.error = `${who}: offline quote verification failed for ${failing.join(', ')} — the extraction patterns are matching text that is not in the filing`;
      return result;
    }

    result.ok = true;
    return result;
  } catch (err) {
    result.error = `${who}: offline extraction failed: ${err.message}`;
    return result;
  }
}

/**
 * Ingest a model response that was obtained by hand instead of over HTTP.
 *
 * The key arrives only after the project is approved, so the API route cannot be
 * exercised yet. This is the way around that without loosening anything: the
 * pipeline prints the real prompt (`--emit-prompt`), a person pastes it into a
 * Claude chat along with the real filing, and pastes the JSON answer back here.
 * The person is the transport; nothing else changes. The response goes through
 * the same parseModelJSON -> recToStoredShape -> validateStored -> verifyQuotes
 * path as an API answer, verified against the same retrieved text, so a quote
 * this route cannot find in the filing is rejected exactly as it would be live.
 *
 * The record is stamped `claude-manual` rather than `claude:<model>` so a reader
 * can always tell which records crossed the network and which were carried.
 *
 * @param {object} options
 * @param {string} options.sourceText    The retrieved filing text to verify against.
 * @param {string} options.responseText  The model's raw answer, fenced or bare.
 * @param {string} options.company
 * @param {string} options.quarter
 * @param {string} [options.source]
 * @param {string} [options.retrievedAt]
 * @param {string} [options.origin]      Free note on where the answer came from.
 * @returns {{ok:boolean, record:(object|null), verification:(object|null),
 *            raw:(string|null), attempts:Array<object>, error:(string|null),
 *            selection:null, extractor:string}}
 */
export function extractRecordFromResponse({
  sourceText,
  responseText,
  company,
  quarter,
  source = null,
  retrievedAt = null,
  origin = 'pasted response'
} = {}) {
  const who = describe(company, quarter);
  const extractor = MANUAL_EXTRACTOR;
  const result = {
    ok: false,
    record: null,
    verification: null,
    raw: null,
    attempts: [],
    error: null,
    selection: null,
    extractor
  };

  try {
    const text = String(sourceText ?? '');
    if (!text.trim()) {
      result.error = `${who}: no source text to verify the response against`;
      return result;
    }
    const answer = String(responseText ?? '');
    if (!answer.trim()) {
      result.error = `${who}: the response file is empty`;
      return result;
    }
    result.raw = answer;

    let parsed;
    try {
      parsed = TyreCore.parseModelJSON(answer);
    } catch (err) {
      result.attempts.push({ n: 1, extractor, origin, ok: false, verification: null, error: err.message });
      result.error =
        `${who}: could not read JSON from the response (${err.message}). ` +
        'Paste the whole JSON object the model returned, including its braces — a code fence around it is fine.';
      return result;
    }

    const { record, problems, verification } = toVerifiedRecord({
      parsed,
      sourceText: text,
      source,
      retrievedAt: retrievedAt || new Date().toISOString(),
      extractor
    });
    result.record = record;

    if (problems.length) {
      result.attempts.push({ n: 1, extractor, origin, ok: false, verification: null, error: problems.join('; ') });
      result.error = `${who}: the pasted record is not well-formed: ${problems.join('; ')}`;
      return result;
    }

    result.verification = verification;
    result.attempts.push({
      n: 1,
      extractor,
      origin,
      ok: verification.ok,
      verification: summarise(verification),
      error: verification.ok ? null : 'quotes not found in the source'
    });

    if (!verification.ok) {
      const failing = verification.checks
        .filter((c) => c.status !== 'verified' && c.status !== 'unquoted')
        .map((c) => `${c.key} (${c.status})`);
      result.error =
        `${who}: quote verification failed for ${failing.join(', ')}. ` +
        'The record is attached unaccepted. Re-ask with the correction text the report prints, ' +
        'or check the filing text pasted into the chat is the same one named by --file.';
      return result;
    }

    result.ok = true;
    return result;
  } catch (err) {
    result.error = `${who}: reading the pasted response failed: ${err.message}`;
    return result;
  }
}

/* ------------------------------------------------------- shared post-pass -- */

function toVerifiedRecord({ parsed, sourceText, source, retrievedAt, extractor }) {
  const record = TyreCore.recToStoredShape(parsed, { source, retrieved_at: retrievedAt });
  const problems = TyreCore.validateStored(record);
  if (problems.length) return { record, problems, verification: null };

  const verification = TyreCore.verifyQuotes(record, sourceText);
  verification.extractor = extractor;
  record.verification = verification;
  return { record, problems, verification };
}

function summarise(verification) {
  return {
    ok: verification.ok,
    checked: verification.checked,
    verified: verification.verified,
    failed: verification.failed,
    unquoted: verification.unquoted,
    not_found: verification.checks.filter((c) => c.status === 'not_found').map((c) => c.key)
  };
}

function describe(company, quarter) {
  return [company, quarter].filter(Boolean).join(' ') || 'unknown filing';
}

// Re-sent as an appendix to the original prompt rather than as a second turn:
// these models reject an assistant prefill, and a stateless re-ask keeps the
// source text and the schema in front of the model alongside the correction.
function buildCorrection(unfound, threshold) {
  const lines = unfound.map(
    (c) => `  - ${c.key}: ${JSON.stringify(c.quote)} — matched only ${Math.round(c.score * 100)}% of the source wording`
  );
  return [
    'CORRECTION — your previous answer was rejected before it was stored.',
    '',
    `Every quote is checked against the filing text above; these did not reach the ${Math.round(threshold * 100)}% match required:`,
    ...lines,
    '',
    'Re-extract the whole object. For each field listed, either copy an exact span from',
    'the source filing text character for character, or return "" for its quote and null',
    'for its figure. Do not paraphrase, re-punctuate, reformat a number, or reconstruct a',
    'sentence from what the filing probably said. Leave the fields that were accepted as',
    'they were.',
    '',
    'Return one JSON object and nothing else.'
  ].join('\n');
}

/* ------------------------------------------------- offline pattern matching -- */

// Ordered per metric: the first pattern that matches wins. Each pattern captures
// the figure in group 1, and the whole match becomes the quote — so the stored
// quote is a real span of the filing, which is what verifyQuotes then checks.
//
// These follow the register Indian quarterly results are actually filed in
// (Ind AS line captions, the SEBI LODR ratio disclosures, the EBITDA note). A
// caption they do not cover comes back null rather than guessed.
const METRIC_PATTERNS = {
  revenue: [/Revenue from operations[ \t]+(\(?-?[\d,]+\.\d+\)?)/i],
  // The EBITDA figure lives in a note, not a statement line. Skipping an EBITDA
  // that ends its line skips the note's own heading and starts the quote at the
  // sentence that carries the number.
  ebitda: [
    /EBITDA(?![ \t]*\n)[\s\S]{0,200}?(?:stood at|was|of)[ \t]+(?:INR|Rs\.?|₹|USD|US\$)[ \t]*([\d,]+\.\d+)(?:[ \t]*(?:Crore|Lakh|Million|Billion))?/i
  ],
  ebitda_margin: [/EBITDA margin[\s\S]{0,80}?([\d.]+)[ \t]*%/i],
  pat: [/Profit for the period(?:[ \t]*\([^)\n]*\))?[ \t]+(\(?-?[\d,]+\.\d+\)?)/i],
  roe: [/Return on equity[^\d%\n]{0,80}([\d.]+)[ \t]*%/i],
  roce: [/Return on capital employed[^\d%\n]{0,80}([\d.]+)[ \t]*%/i],
  debt_equity: [/Debt[ -](?:to[ -])?equity ratio[ \t]+([\d.]+)/i],
  current_ratio: [/Current ratio[ \t]+([\d.]+)/i],
  quick_ratio: [/Quick ratio[ \t]+([\d.]+)/i],
  // "Interest service coverage ratio" is the SEBI LODR Regulation 52(4) caption.
  interest_coverage: [/Interest (?:service )?coverage ratio[ \t]+([\d.]+)/i],
  total_assets: [/Total assets[ \t]+([\d,]+\.\d+)/i],
  total_liabilities: [/Total liabilities[ \t]+([\d,]+\.\d+)/i],
  total_equity: [/Total equity[ \t]+([\d,]+\.\d+)/i],
  cash: [/Cash and cash equivalents[^\d\n]{0,80}([\d,]+\.\d+)/i],
  ocf: [/Net cash (?:generated |used )?(?:from|provided by|in) operating activities[ \t]+(\(?-?[\d,]+\.\d+\)?)/i],
  capex_amt: [
    /(?:Purchases? of|Payments for(?:[ \t]+purchase of)?)[ \t]+property,[ \t]+plant and equipment(?:[ \t]*\([^)\n]*\))?[ \t]+([\d,]+\.\d+)/i,
    /Capital expenditure(?:[ \t]*\([^)\n]*\))?[ \t]+([\d,]+\.\d+)/i
  ],
  fcf: [/Free cash flow(?:[ \t]*\([^)\n]*\))?[ \t]+(\(?-?[\d,]+\.\d+\)?)/i],
  inv_turnover: [/Inventory turnover ratio[^\d\n]{0,80}([\d.]+)/i],
  dso: [/(?:Debtor days|days sales outstanding)[^\d\n]{0,80}([\d.]+)/i],
  dpo: [/(?:Creditor days|days payable outstanding)[^\d\n]{0,80}([\d.]+)/i]
};

function readCoreMetrics(text) {
  const core = {};
  const quotes = {};

  for (const key of TyreCore.CORE_KEYS) {
    core[key] = null;
    quotes[key] = '';

    for (const pattern of METRIC_PATTERNS[key] || []) {
      const m = pattern.exec(text);
      if (!m) continue;
      const value = parseAmount(m[1]);
      if (value === null) continue;
      core[key] = value;
      quotes[key] = m[0].trim();
      break;
    }
  }

  return { core, quotes };
}

function parseAmount(raw) {
  const s = String(raw).trim();
  const bracketed = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[(),]/g, ''));
  if (!Number.isFinite(n)) return null;
  return bracketed ? -n : n;
}

const CURRENCY_PATTERN =
  /(?<![A-Za-z])(INR|Rs\.?|₹|USD|US\$|EUR|GBP|JPY)[ \t]*(?:in[ \t]+)?(Crore|Lakh|Million|Billion|Thousand)(?![A-Za-z])/i;

const CURRENCY_CODES = { 'RS.': 'INR', RS: 'INR', '₹': 'INR', 'US$': 'USD' };

function readCurrency(text) {
  const m = CURRENCY_PATTERN.exec(text);
  if (!m) return { code: null, unit: null };
  const raw = m[1].toUpperCase();
  const unit = m[2].toLowerCase();
  return {
    code: CURRENCY_CODES[raw] || raw,
    unit: unit.charAt(0).toUpperCase() + unit.slice(1)
  };
}

function readQuarter(text) {
  const m = /\bQ([1-4])[ \t]*FY[ \t]*'?(\d{2,4})\b/i.exec(text);
  return m ? `Q${m[1]} FY${m[2]}` : null;
}

const CHANNEL_PATTERNS = {
  replacement: /\bReplacement\b[^\d%]{0,200}([\d.]+)[ \t]*%/i,
  oem: /\bOriginal equipment\b[^\d%]{0,200}([\d.]+)[ \t]*%/i,
  export: /\bExports?\b[^\d%]{0,200}([\d.]+)[ \t]*%/i
};

function readSegments(text) {
  const channels = {};
  for (const key of TyreCore.CHANNEL_KEYS) {
    const m = CHANNEL_PATTERNS[key].exec(text);
    channels[key] = m ? parseAmount(m[1]) : null;
  }

  const products = {};
  for (const key of TyreCore.PRODUCT_KEYS) {
    // Filings label the category in prose and put the code in brackets after it,
    // sometimes with the description wrapping across a line.
    const m = new RegExp(`\\(${key}\\)[^\\d%]{0,200}([\\d.]+)[ \\t]*%`, 'i').exec(text);
    products[key] = m ? parseAmount(m[1]) : null;
  }

  return { channels, product_categories: products };
}

const OUTLOOK_TOPICS = {
  rm_trend: /natural rubber|raw material|carbon black|crude|input cost/i,
  capex: /capital expenditure|capex/i
};

function readOutlook(text) {
  const heading = /^[ \t]*MANAGEMENT[ \t]+(?:COMMENTARY|DISCUSSION)[^\n]*\n/im.exec(text);
  const outlook = { commentary: null, rm_trend: null, capex: null };
  if (!heading) return outlook;

  const sentences = splitSentences(text.slice(heading.index + heading[0].length))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 40);
  if (!sentences.length) return outlook;

  outlook.commentary = clip(sentences[0], 400);
  for (const [key, topic] of Object.entries(OUTLOOK_TOPICS)) {
    const hit = sentences.find((s) => topic.test(s));
    if (hit) outlook[key] = clip(hit, 400);
  }
  return outlook;
}

// Split on a full stop that ends a word and starts a new capitalised one, so the
// "Rs. 588.20" and "31 March 2025." forms in these filings stay intact.
function splitSentences(section) {
  return section.split(/(?<=[a-z0-9%)])\.\s+(?=[A-Z])/);
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
