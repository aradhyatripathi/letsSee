#!/usr/bin/env node
// The manual trigger (build spec, Section 0 boundary 1, Section 4, Section 8).
//
// A person runs this. It retrieves, extracts and verifies one quarter's filings
// for one company or all nine, writes the records and a report, prints what
// happened, and exits. There is no scheduler, no watcher, no retry loop and no
// path by which this file runs itself — "run all nine in one press" is still a
// person pressing once.
//
// A failure on one company is recorded and the run continues (Section 4, Stages
// 1 and 2): one awkward investor-relations page must never cost the other eight.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPANIES, QUARTER_DEFAULT, findCompany, selectCompanies } from './config/companies.mjs';
import { TyreCore } from './lib/core.mjs';
import { extractRecord, extractRecordOffline } from './lib/extract.mjs';
import { retrieveFiling } from './lib/retrieve.mjs';
import { summarizeForConsole, writeRunReport } from './lib/report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const KNOWN_MODELS = ['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-5'];
const DEFAULT_CONCURRENCY = 3;

const USAGE = `
Tyre intelligence pipeline — manual run.

  node pipeline/run.mjs [options]        (or: npm run run:pipeline -- [options])

Retrieves one quarter's filing for each selected company, extracts the shared
record schema, verifies every quote against the retrieved text, and writes the
records plus a report into runs/<run-id>/. Runs once and exits.

Options
  --companies=apollo,mrf   Subset to run. Default: all ${COMPANIES.length} companies.
  --quarter="Q1 FY26"      Quarter label. Default: ${QUARTER_DEFAULT}.
  --mode=fixture|live      fixture (offline sample filings, default) or live (network).
  --offline-extract        Use the deterministic extractor instead of the Claude API.
                           Implied in fixture mode when ANTHROPIC_API_KEY is not set.
  --model=<id>             Extraction model. Default: ${DEFAULT_MODEL}.
                           Also available: ${KNOWN_MODELS.slice(1).join(', ')}.
  --file=<id>:<path>       Manual upload fallback for one company (.txt/.md/.pdf).
                           Repeatable; tried before any network source.
  --out=<path>             Records file. Default: runs/<run-id>/records.json.
  --concurrency=N          Companies in flight at once. Default: ${DEFAULT_CONCURRENCY}.
  --help                   This text.

Environment
  ANTHROPIC_API_KEY        Required for API extraction. Live mode refuses to start
                           without it rather than quietly producing fixture data.
  FIRECRAWL_API_KEY        Optional. When set, live retrieval tries Firecrawl before
                           a direct fetch.

Examples
  node pipeline/run.mjs                                   # all companies, offline, one press
  node pipeline/run.mjs --companies=apollo --mode=live
  node pipeline/run.mjs --file=goodyear:~/Downloads/goodyear-q1fy26.pdf

Exit code 0 when at least one record was produced, 1 when none were.
`.trim();

const BOOLEAN_FLAGS = new Set(['help', 'offline-extract']);
const VALUE_FLAGS = new Set(['companies', 'quarter', 'mode', 'model', 'file', 'out', 'concurrency']);

/* -------------------------------------------------------------------- cli -- */

function parseArgs(argv) {
  const flags = { file: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument '${token}' — every option starts with --`);
    }
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();

    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new Error(`--${name} is a switch and takes no value`);
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new Error(`unknown option --${name}`);
    }

    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (name === 'file') flags.file.push(value);
    else flags[name] = value;
  }
  return flags;
}

function resolveOptions(flags) {
  const companyIds = String(flags.companies || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const companies = selectCompanies(companyIds);

  const mode = flags.mode || 'fixture';
  if (mode !== 'fixture' && mode !== 'live') {
    throw new Error(`--mode must be 'fixture' or 'live', got '${mode}'`);
  }

  const model = flags.model || DEFAULT_MODEL;
  const concurrency = flags.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(flags.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got '${flags.concurrency}'`);
  }

  const files = new Map();
  for (const spec of flags.file) {
    const split = spec.indexOf(':');
    if (split < 1) throw new Error(`--file expects <company-id>:<path>, got '${spec}'`);
    const id = spec.slice(0, split).trim();
    const path = spec.slice(split + 1).trim();
    if (!path) throw new Error(`--file expects <company-id>:<path>, got '${spec}'`);
    const company = findCompany(id);
    if (!company) throw new Error(`--file names an unknown company '${id}'`);
    if (!companies.some((c) => c.id === company.id)) {
      throw new Error(`--file names ${company.name}, which is not in --companies — add it or drop the file`);
    }
    files.set(company.id, expandHome(path));
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || null;
  let offlineExtract = flags['offline-extract'] === true;
  let offlineImplied = false;
  if (!offlineExtract && !apiKey) {
    if (mode === 'live') {
      throw new Error(
        'live mode needs an API key for extraction.\n' +
        '  Set it:              export ANTHROPIC_API_KEY=sk-ant-...\n' +
        '  Or extract offline:  node pipeline/run.mjs --mode=live --offline-extract\n' +
        'Refusing to start rather than retrieving live filings and silently producing ' +
        'deterministic placeholder records that look like model output.'
      );
    }
    offlineExtract = true;
    offlineImplied = true;
  }

  return {
    companies,
    quarter: flags.quarter || QUARTER_DEFAULT,
    mode,
    model,
    concurrency,
    files,
    apiKey,
    offlineExtract,
    offlineImplied,
    firecrawlKey: (process.env.FIRECRAWL_API_KEY || '').trim() || null,
    out: flags.out ? resolve(process.cwd(), expandHome(flags.out)) : null
  };
}

function expandHome(path) {
  if (path === '~') return process.env.HOME || path;
  if (path.startsWith('~/') && process.env.HOME) return join(process.env.HOME, path.slice(2));
  return path;
}

/* --------------------------------------------------------------- one company -- */

async function processCompany(company, opts, runDir) {
  const startedAt = Date.now();
  const entry = {
    id: company.id,
    name: company.name,
    ok: false,
    stage: 'retrieval',
    error: null,
    retrieval: null,
    extraction: null,
    verification: null,
    issues: [],
    record: null,
    duration_ms: 0
  };

  const retrieval = await retrieveFiling(company, {
    quarter: opts.quarter,
    mode: opts.mode,
    runDir,
    file: opts.files.get(company.id) || null,
    firecrawlKey: opts.firecrawlKey
  });
  const retrievedAt = new Date().toISOString();

  entry.retrieval = {
    ok: retrieval.ok,
    strategy: retrieval.strategy,
    source: retrieval.source,
    bytes: retrieval.bytes,
    path: retrieval.path || null,
    error: retrieval.error,
    attempts: retrieval.attempts || []
  };

  if (!retrieval.ok) {
    entry.error = retrieval.error || `${company.name}: retrieval failed with no error reported`;
    entry.duration_ms = Date.now() - startedAt;
    return entry;
  }

  entry.stage = 'extraction';
  const engine = opts.offlineExtract ? 'offline' : 'api';
  const args = {
    sourceText: retrieval.text,
    company: company.name,
    quarter: opts.quarter,
    source: retrieval.source
  };
  const extraction = opts.offlineExtract
    ? await extractRecordOffline(args)
    : await extractRecord({ ...args, apiKey: opts.apiKey, model: opts.model });

  entry.extraction = {
    ok: extraction.ok,
    engine,
    error: extraction.error || null,
    attempts: extraction.attempts || []
  };

  if (!extraction.ok || !extraction.record) {
    entry.error = extraction.error || `${company.name}: extraction returned no record and no error`;
    entry.duration_ms = Date.now() - startedAt;
    return entry;
  }

  const verification = extraction.verification || TyreCore.verifyQuotes(extraction.record, retrieval.text);
  const record = finalizeRecord(extraction.record, {
    source: retrieval.source,
    retrievedAt,
    verification
  });

  entry.ok = true;
  entry.stage = 'done';
  entry.verification = verification;
  entry.record = record;
  entry.issues = TyreCore.validateStored(record);
  entry.duration_ms = Date.now() - startedAt;
  return entry;
}

// The extractor may hand back either the model's own schema shape (core_quotes)
// or an already-stored record (quotes). Normalize here so exactly one shape is
// ever written to records.json, and stamp on the run-level provenance the
// extractor cannot know: where the text came from, when, and how it verified.
function finalizeRecord(raw, { source, retrievedAt, verification }) {
  const record = raw.core_quotes
    ? TyreCore.recToStoredShape(raw, { source, retrieved_at: retrievedAt })
    : raw;

  record.source = record.source || source;
  record.id = record.id || TyreCore.recordId(record.company, record.quarter, record.source);
  record.retrieved_at = record.retrieved_at || retrievedAt;
  record.review = record.review || { status: 'pending', reviewer: null, reviewed_at: null, note: null };
  record.verification = verification;
  return record;
}

/* -------------------------------------------------------------------- run -- */

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function progressLine(entry, index, total) {
  const tag = `[${String(index + 1).padStart(String(total).length, ' ')}/${total}]`;
  if (!entry.ok) {
    return `${tag} ${entry.name}: FAILED at ${entry.stage} — ${entry.error}`;
  }
  const v = entry.verification;
  const values = TyreCore.CORE_KEYS.filter((k) => TyreCore.isNum(entry.record.core[k])).length;
  const quotes = `${v.verified} verified, ${v.failed} not found, ${v.unquoted} unquoted`;
  return `${tag} ${entry.name}: ${entry.retrieval.strategy} → ${values} metrics, ${quotes}`;
}

async function main(argv) {
  let flags;
  let opts;
  try {
    flags = parseArgs(argv);
    if (flags.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    opts = resolveOptions(flags);
  } catch (err) {
    process.stderr.write(`${err.message}\n\nRun with --help for the full option list.\n`);
    return 1;
  }

  const startedAt = new Date();
  // Milliseconds are kept so two runs started in the same second cannot land in
  // the same directory and overwrite each other's records.
  const runId = startedAt.toISOString().replace(/:/g, '').replace('.', '-');
  const runDir = join(REPO_ROOT, 'runs', runId);
  const recordsPath = opts.out || join(runDir, 'records.json');
  const reportPath = join(runDir, 'report.md');
  await mkdir(runDir, { recursive: true });

  const log = (line) => process.stderr.write(`${line}\n`);
  log(`Run ${runId} — ${opts.quarter} — ${opts.companies.length} compan${opts.companies.length === 1 ? 'y' : 'ies'}`);
  log(`  retrieval: ${opts.mode}${opts.mode === 'live' && opts.firecrawlKey ? ' (Firecrawl first)' : ''}`);
  log(`  extraction: ${opts.offlineExtract ? `offline deterministic extractor${opts.offlineImplied ? ' (no ANTHROPIC_API_KEY set)' : ''}` : `Claude API, ${opts.model}`}`);
  if (opts.files.size) {
    log(`  manual uploads: ${[...opts.files.entries()].map(([id, path]) => `${id} → ${path}`).join(', ')}`);
  }
  if (!opts.offlineExtract && !KNOWN_MODELS.includes(opts.model)) {
    log(`  note: '${opts.model}' is not one of ${KNOWN_MODELS.join(', ')} — sending it through as given`);
  }
  log(`  working directory: ${runDir}`);
  log('');

  let done = 0;
  const total = opts.companies.length;
  const companies = await mapWithConcurrency(opts.companies, opts.concurrency, async (company) => {
    let entry;
    try {
      entry = await processCompany(company, opts, runDir);
    } catch (err) {
      // Nothing in the per-company path is expected to throw, but one company
      // taking the whole run down is exactly the failure mode Section 4 rules out.
      entry = {
        id: company.id,
        name: company.name,
        ok: false,
        stage: 'unexpected',
        error: `${err.message}\n${err.stack || ''}`.trim(),
        retrieval: null,
        extraction: null,
        verification: null,
        issues: [],
        record: null,
        duration_ms: 0
      };
    }
    log(progressLine(entry, done++, total));
    return entry;
  });

  const records = companies.filter((c) => c.record).map((c) => c.record);
  const finishedAt = new Date();

  const runResult = {
    run_id: runId,
    quarter: opts.quarter,
    mode: opts.mode,
    model: opts.offlineExtract ? null : opts.model,
    extractor: opts.offlineExtract ? 'offline' : 'api',
    generated_at: finishedAt.toISOString(),
    started_at: startedAt.toISOString(),
    duration_ms: finishedAt - startedAt,
    run_dir: runDir,
    records_path: recordsPath,
    report_path: reportPath,
    companies,
    records
  };

  await mkdir(dirname(recordsPath), { recursive: true });
  await writeFile(
    recordsPath,
    `${JSON.stringify(
      {
        run_id: runResult.run_id,
        quarter: runResult.quarter,
        mode: runResult.mode,
        model: runResult.model,
        extractor: runResult.extractor,
        generated_at: runResult.generated_at,
        records
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeRunReport(runResult, reportPath);

  log('');
  process.stdout.write(`${summarizeForConsole(runResult)}\n`);
  return records.length ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
