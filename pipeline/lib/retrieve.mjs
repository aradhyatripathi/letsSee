// Stage 1 — filing retrieval (build spec, Section 4).
//
// One company per call. Every failure is captured and returned in the result, so
// a batch run over all nine companies never aborts because one investor-relations
// page is awkward — the runner reports which company needs a manual upload and
// carries on with the rest.
//
// Retrieval is only ever entered because a person triggered a run (Section 0,
// boundary 1). There is nothing in this module that starts itself.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { fixturePath } from '../fixtures/index.mjs';
import { TyreCore } from './core.mjs';
import { extractPdfText, looksLikePdf } from './pdf.mjs';

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v1/scrape';
const DEFAULT_TIMEOUT_MS = 30000;

// Investor-relations sites routinely refuse the default Node fetch agent.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Below this, a "successful" fetch is really a cookie wall, a consent page or a
// JavaScript shell — worth failing over to the next strategy rather than sending
// it to the extractor.
const MIN_USEFUL_CHARS = 400;

// The most we will pull off the wire, or off disk, for one filing.
//
// run.mjs promises that a failure on one company is recorded and the run
// continues — "one awkward investor-relations page must never cost the other
// eight". That promise does not survive an unbounded read: the whole response was
// buffered before anything looked at its size, so 200 MB from a hostile or merely
// broken IR page became about 7 GB of resident memory once the string copies in
// htmlToText were counted, and the process aborted. A heap abort is not an
// exception; no per-company try/catch sees it, and records.json and report.md are
// never written at all. Refusing the read fails one company, which is the
// behaviour that was promised.
//
// 64 MB is far above a real filing. A 200-page annual report PDF runs around
// 30 MB, and a results page is a few hundred kilobytes.
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.text', '']);

/**
 * Retrieve one company's filing text.
 *
 * @param {{id:string, name:string, sources?:Array<{type:string,url:string}>}} company
 * @param {object} [options]
 * @param {string} [options.quarter]        Quarter label, recorded on the result.
 * @param {'fixture'|'live'} [options.mode] 'fixture' (default, fully offline) or
 *                                          'live' (Firecrawl then HTTP, never a fixture).
 * @param {string} [options.runDir]         Run directory; the text is written to
 *                                          <runDir>/sources/<id>.txt when given.
 * @param {string} [options.file]           Operator-supplied local filing for this
 *                                          company (.txt/.md/.pdf) — the manual-upload
 *                                          fallback. Tried first in either mode.
 * @param {string} [options.firecrawlKey]   Firecrawl API key; without it that strategy
 *                                          is skipped rather than attempted and failed.
 * @param {number} [options.timeoutMs]      Per-request timeout, default 30000.
 * @returns {Promise<{ok:boolean, text:string, source:(string|null), strategy:(string|null),
 *                    bytes:number, error:(string|null), path:(string|null),
 *                    company:string, quarter:(string|null), attempts:Array<object>}>}
 */
export async function retrieveFiling(company, options = {}) {
  const {
    quarter = null,
    mode = 'fixture',
    runDir = null,
    file = null,
    firecrawlKey = null,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  const result = {
    ok: false,
    text: '',
    source: null,
    strategy: null,
    bytes: 0,
    error: null,
    path: null,
    company: company.name,
    quarter,
    attempts: []
  };

  let plan;
  try {
    plan = planStrategies(company, { mode, file, firecrawlKey, quarter });
  } catch (err) {
    result.error = err.message;
    return result;
  }

  for (const step of plan) {
    const startedAt = Date.now();
    try {
      const got = await runStrategy(step, { timeoutMs, firecrawlKey });
      result.attempts.push({
        strategy: step.strategy,
        target: step.target,
        ok: true,
        error: null,
        ms: Date.now() - startedAt
      });
      result.ok = true;
      // One place for every strategy. A PDF text string may be UTF-16BE, and decoding it
      // code unit by code unit turns the byte pair FF FF in a filing into U+FFFF — a
      // character XML cannot carry, which would travel into a quote and then into a
      // workbook or a deck part and quietly truncate it.
      result.text = TyreCore.sanitizeText(got.text);
      result.source = got.source;
      result.strategy = step.strategy;
      result.bytes = got.bytes;
      break;
    } catch (err) {
      result.attempts.push({
        strategy: step.strategy,
        target: step.target,
        ok: false,
        error: err.message,
        ms: Date.now() - startedAt
      });
    }
  }

  if (!result.ok) {
    result.error = summariseFailure(company, result.attempts, mode, quarter);
    return result;
  }

  if (runDir) {
    try {
      result.path = await writeRunCopy(runDir, company.id, result.text);
    } catch (err) {
      result.ok = false;
      result.error = `retrieved ${result.bytes} bytes via ${result.strategy} but could not write the run copy: ${err.message}`;
    }
  }

  return result;
}

/* ---------------------------------------------------------------- planning -- */

function planStrategies(company, { mode, file, firecrawlKey, quarter }) {
  if (mode !== 'fixture' && mode !== 'live') {
    throw new Error(`unknown retrieval mode '${mode}' (expected 'fixture' or 'live')`);
  }

  const plan = [];
  if (file) plan.push({ strategy: 'file', target: resolve(file), file: resolve(file) });

  if (mode === 'fixture') {
    plan.push({ strategy: 'fixture', target: fixturePath(company.id, quarter) });
    return plan;
  }

  // A live run must never silently return fixture text — a record sourced from a
  // synthetic filing that claims to be live would be a lie in the workbook.
  const sources = company.sources || [];
  if (!sources.length && !file) {
    throw new Error(
      `${company.name}: no source URLs configured and no --file given; add a source in pipeline/config/companies.mjs or supply a manual upload`
    );
  }
  for (const src of sources) {
    if (firecrawlKey) plan.push({ strategy: 'firecrawl', target: src.url, url: src.url });
    plan.push({ strategy: 'http', target: src.url, url: src.url });
  }
  return plan;
}

function runStrategy(step, ctx) {
  switch (step.strategy) {
    case 'file': return fromFile(step.file);
    case 'fixture': return fromFixture(step.target);
    case 'firecrawl': return fromFirecrawl(step.url, ctx.firecrawlKey, ctx.timeoutMs);
    case 'http': return fromHttp(step.url, ctx.timeoutMs);
    default: throw new Error(`unreachable strategy ${step.strategy}`);
  }
}

function summariseFailure(company, attempts, mode, quarter) {
  const detail = attempts.map((a) => `${a.strategy} (${a.target}): ${a.error}`).join('; ');
  const hint = mode === 'live'
    ? ' — download the filing by hand and re-run with a --file path for this company'
    : ` — expected a fixture at ${fixturePath(company.id, quarter)}`;
  return `${company.name}: every retrieval strategy failed. ${detail}${hint}`;
}

/* -------------------------------------------------------------- strategies -- */

async function fromFixture(path) {
  const buf = await readFile(path);
  const text = buf.toString('utf8');
  if (!text.trim()) throw new Error(`fixture ${path} is empty`);
  // Quarter and file, not just the file: two quarters of the same company are both
  // `ceat.txt`, and a record whose source cannot say which one it came from is not
  // traceable.
  const parts = path.split(/[\\/]/).slice(-2);
  return { text, bytes: buf.length, source: `fixture:${parts.join('/')}` };
}

async function fromFile(path) {
  const { size } = await stat(path);
  if (size > MAX_SOURCE_BYTES) {
    throw new Error(
      `${path} is ${(size / (1024 * 1024)).toFixed(1)} MB, past the ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))} MB limit for one filing — ` +
      'save just the financial-statement pages, or paste the text into a .txt'
    );
  }
  const buf = await readFile(path);
  const ext = extname(path).toLowerCase();

  if (ext === '.pdf' || looksLikePdf(buf)) {
    const parsed = extractPdfText(buf);
    if (!parsed.ok) throw new Error(`${path}: ${parsed.error}`);
    return { text: parsed.text, bytes: buf.length, source: `file:${path}` };
  }

  if (!TEXT_EXTENSIONS.has(ext)) {
    throw new Error(`${path}: unsupported file type '${ext}' — supply a .txt, .md or .pdf filing`);
  }

  const text = buf.toString('utf8');
  if (!text.trim()) throw new Error(`${path} is empty`);
  return { text, bytes: buf.length, source: `file:${path}` };
}

async function fromFirecrawl(url, key, timeoutMs) {
  const res = await request(FIRECRAWL_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ url, formats: ['markdown'] })
  }, timeoutMs);

  // Firecrawl is a third party returning us a document, so its response is bounded
  // like any other. It has never sent anything close to this.
  const body = (await readCapped(res, FIRECRAWL_ENDPOINT, MAX_SOURCE_BYTES)).toString('utf8');
  if (!res.ok) {
    throw new Error(`firecrawl returned HTTP ${res.status} for ${url}: ${clip(body, 300)}`);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`firecrawl returned a non-JSON body for ${url}: ${clip(body, 200)}`);
  }

  if (payload && payload.success === false) {
    throw new Error(`firecrawl reported failure for ${url}: ${payload.error || clip(body, 200)}`);
  }

  const data = payload && typeof payload.data === 'object' && payload.data !== null ? payload.data : payload;
  const markdown = data && data.markdown;
  if (typeof markdown !== 'string') {
    const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
    throw new Error(
      `firecrawl response for ${url} had no 'markdown' string — the API shape has changed or the scrape returned nothing (fields present: ${keys || 'none'})`
    );
  }
  if (markdown.trim().length < MIN_USEFUL_CHARS) {
    throw new Error(`firecrawl returned only ${markdown.trim().length} characters of markdown for ${url}`);
  }

  return { text: markdown, bytes: Buffer.byteLength(markdown, 'utf8'), source: url };
}

async function fromHttp(url, timeoutMs) {
  const res = await request(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      'accept-language': 'en-IN,en;q=0.9'
    },
    redirect: 'follow'
  }, timeoutMs);

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''} for ${url}`.trim());

  const buf = await readCapped(res, url, MAX_SOURCE_BYTES);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('pdf') || looksLikePdf(buf)) {
    const parsed = extractPdfText(buf);
    if (!parsed.ok) {
      throw new Error(`PDF at ${url} could not be read (${parsed.error}) — download it and re-run with --file`);
    }
    return { text: parsed.text, bytes: buf.length, source: url };
  }

  const raw = buf.toString('utf8');
  const looksHtml = contentType.includes('html') || /<\s*(html|body|div|table)\b/i.test(raw.slice(0, 4000));
  const text = looksHtml ? htmlToText(raw) : raw;

  if (text.trim().length < MIN_USEFUL_CHARS) {
    throw new Error(
      `${url} yielded only ${text.trim().length} characters of text — the page is most likely rendered client-side; use Firecrawl or a manual --file upload`
    );
  }

  return { text, bytes: buf.length, source: url };
}

/**
 * Read a response body, stopping at `limit` rather than after it.
 *
 * `res.arrayBuffer()` has already allocated everything by the time it returns, so
 * a check on the result is a check made too late. This reads the stream and gives
 * up the moment the total passes the limit — the declared Content-Length is used
 * only as an early exit, because a server is free to lie about it or omit it.
 */
async function readCapped(res, url, limit) {
  const tooBig = (size) => new Error(
    `${url} returned ${(size / (1024 * 1024)).toFixed(1)} MB, past the ${Math.round(limit / (1024 * 1024))} MB limit for one filing — ` +
    'point the source at the results PDF or the filing page rather than a whole archive, or download it and re-run with --file'
  );

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooBig(declared);
  if (!res.body) return Buffer.from(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw tooBig(total);
      chunks.push(value);
    }
  } finally {
    // Let the socket go whether we finished or walked away from it.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

async function request(url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
    const cause = err.cause && err.cause.message ? ` (${err.cause.message})` : '';
    throw new Error(`request to ${url} failed: ${err.message}${cause}`);
  }
}

/* ------------------------------------------------------------- run output -- */

// Section 0, boundary 2: the retrieved filing text is working space for the run
// that is happening right now. runs/ is gitignored, nothing here syncs or uploads
// it, and nothing deletes or re-reads it on a schedule. What leaves this pipeline
// is the reviewed record, not the source document.
async function writeRunCopy(runDir, id, text) {
  const dir = join(runDir, 'sources');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.txt`);
  await writeFile(path, text, 'utf8');
  return path;
}

/* ---------------------------------------------------------- html -> text -- */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', hellip: '…', bull: '•',
  middot: '·', deg: '°', times: '×', minus: '−',
  rupee: '₹', inr: '₹', euro: '€', pound: '£', yen: '¥',
  copy: '©', reg: '®', trade: '™'
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Flatten an HTML page to plain text for extraction.
 *
 * Table cells are separated by a space rather than a newline so that a figure
 * stays on the same line as the label in the cell beside it — the extractor and
 * the quote verifier both depend on that adjacency.
 */
export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|iframe|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(td|th)\s*>/gi, ' ');
  s = s.replace(/<\/(p|div|tr|table|thead|tbody|tfoot|li|ul|ol|section|article|header|footer|h[1-6]|blockquote|pre)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
