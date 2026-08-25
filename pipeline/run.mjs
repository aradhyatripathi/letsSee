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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPANIES, QUARTER_DEFAULT, findCompany, selectCompanies } from './config/companies.mjs';
import { TyreCore } from './lib/core.mjs';
import { extractRecord, extractRecordFromResponse, extractRecordOffline } from './lib/extract.mjs';
import { retrieveFiling } from './lib/retrieve.mjs';
import { countFinancialMarkers, countNumbers, summarizeForConsole, writeRunReport } from './lib/report.mjs';

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

Working without an API key
  --retrieve-only          Run Stage 1 and stop. Reports what each company's site
                           actually returned. Needs network, needs no key.
  --emit-prompt            Retrieve, build the real extraction prompt, write it to
                           runs/<run-id>/prompts/ and stop. Paste it into a Claude
                           chat by hand.
  --response=<id>:<path>   Read a pasted JSON answer back in for one company and
                           verify its quotes against this run's retrieved text,
                           exactly as a live extraction would be. Repeatable.
  --no-thinking            Extract without adaptive thinking. On by default: these
                           filings put several comparative columns side by side and
                           picking the wrong one is the failure this design guards
                           against. Turn it off only if the API rejects it.

Environment
  ANTHROPIC_API_KEY        Required for API extraction. Live mode refuses to start
                           without it rather than quietly producing fixture data.
  FIRECRAWL_API_KEY        Optional. When set, live retrieval tries Firecrawl before
                           a direct fetch.

Examples
  node pipeline/run.mjs                                   # all companies, offline, one press
  node pipeline/run.mjs --companies=apollo --mode=live
  node pipeline/run.mjs --file=goodyear:~/Downloads/goodyear-q1fy26.pdf

  # Which investor-relations pages actually work, from a machine with network:
  node pipeline/run.mjs --mode=live --retrieve-only

  # A real filing through real Claude with no key, in two commands:
  node pipeline/run.mjs --companies=ceat --file=ceat:~/Downloads/ceat-q1fy26.pdf --emit-prompt
  node pipeline/run.mjs --companies=ceat --file=ceat:~/Downloads/ceat-q1fy26.pdf --response=ceat:answer.json

Exit code 0 when at least one record was produced, 1 when none were.
`.trim();

const BOOLEAN_FLAGS = new Set(['help', 'offline-extract', 'retrieve-only', 'emit-prompt', 'no-thinking']);
const VALUE_FLAGS = new Set(['companies', 'quarter', 'mode', 'model', 'file', 'response', 'out', 'concurrency']);

/* -------------------------------------------------------------------- cli -- */

function parseArgs(argv) {
  const flags = { file: [], response: [] };
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
    if (name === 'file' || name === 'response') flags[name].push(value);
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

  const files = parsePerCompanyPaths(flags.file, 'file', companies);
  const responses = parsePerCompanyPaths(flags.response, 'response', companies);

  // Three ways to stop early, all of them ways to make progress without a key.
  // They are exclusive because each answers a different question and running two
  // at once would silently drop one of the answers.
  const retrieveOnly = flags['retrieve-only'] === true;
  const emitPrompt = flags['emit-prompt'] === true;
  if (retrieveOnly && emitPrompt) {
    throw new Error('--retrieve-only and --emit-prompt do different things; pick one');
  }
  if (retrieveOnly && responses.size) {
    throw new Error('--retrieve-only stops before extraction, so --response would be ignored');
  }
  if (emitPrompt && responses.size) {
    throw new Error('--emit-prompt writes the prompt to send; --response reads the answer back. Run them as two commands');
  }
  const stopAfter = retrieveOnly ? 'retrieval' : emitPrompt ? 'prompt' : null;

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || null;
  let offlineExtract = flags['offline-extract'] === true;
  let offlineImplied = false;

  // Every company either stops before extraction, has a pasted answer waiting, or
  // is extracted here. Only the last of those needs a key, so the three key-free
  // routes stay open in live mode — which is the whole point of them.
  const needsApi =
    !stopAfter && !offlineExtract && companies.some((c) => !responses.has(c.id));

  if (needsApi && !apiKey) {
    if (mode === 'live') {
      throw new Error(
        'live mode needs an API key to extract, and none of the key-free routes are selected.\n' +
        '  Set a key:             export ANTHROPIC_API_KEY=sk-ant-...\n' +
        '  Retrieve only:         node pipeline/run.mjs --mode=live --retrieve-only\n' +
        '  Print the prompt:      node pipeline/run.mjs --mode=live --emit-prompt\n' +
        '  Read an answer back:   node pipeline/run.mjs --response=<id>:<file.json>\n' +
        '  Extract deterministically: --offline-extract\n' +
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
    responses,
    stopAfter,
    thinking: flags['no-thinking'] === true ? null : { type: 'adaptive' },
    apiKey,
    offlineExtract,
    offlineImplied,
    firecrawlKey: (process.env.FIRECRAWL_API_KEY || '').trim() || null,
    out: flags.out ? resolve(process.cwd(), expandHome(flags.out)) : null
  };
}

// --file and --response share one grammar: <company-id>:<path>, repeatable, and
// rejected up front if the company is not in this run rather than being ignored
// halfway through it.
function parsePerCompanyPaths(specs, flagName, companies) {
  const out = new Map();
  for (const spec of specs) {
    const split = spec.indexOf(':');
    if (split < 1) throw new Error(`--${flagName} expects <company-id>:<path>, got '${spec}'`);
    const id = spec.slice(0, split).trim();
    const path = spec.slice(split + 1).trim();
    if (!path) throw new Error(`--${flagName} expects <company-id>:<path>, got '${spec}'`);
    const company = findCompany(id);
    if (!company) throw new Error(`--${flagName} names an unknown company '${id}'`);
    if (!companies.some((c) => c.id === company.id)) {
      throw new Error(`--${flagName} names ${company.name}, which is not in --companies — add it or drop the ${flagName}`);
    }
    if (out.has(company.id)) {
      throw new Error(
        `--${flagName} was given twice for ${company.name} (${out.get(company.id)} and ${expandHome(path)}). ` +
        'Only one can be used, and silently picking one would be worse than saying so.'
      );
    }
    out.set(company.id, expandHome(path));
  }
  return out;
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
    prompt: null,
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
    attempts: retrieval.attempts || [],
    // Counted here, where the text is, so the report can tell a filing apart from
    // a cookie wall that returned 200 without carrying the whole document around.
    financial_markers: retrieval.ok ? countFinancialMarkers(retrieval.text) : null,
    number_count: retrieval.ok ? countNumbers(retrieval.text) : null
  };

  if (!retrieval.ok) {
    entry.error = retrieval.error || `${company.name}: retrieval failed with no error reported`;
    entry.duration_ms = Date.now() - startedAt;
    return entry;
  }

  // --retrieve-only. Answers "does this company's site actually give us a filing",
  // which is the one question no amount of work in this container can settle, and
  // which a person with an ordinary internet connection can settle in a minute.
  if (opts.stopAfter === 'retrieval') {
    entry.ok = true;
    entry.stage = 'retrieved';
    entry.duration_ms = Date.now() - startedAt;
    return entry;
  }

  const args = {
    sourceText: retrieval.text,
    company: company.name,
    quarter: opts.quarter,
    source: retrieval.source
  };

  // --emit-prompt. Writes exactly what would have gone over the wire, so it can
  // be carried to a Claude chat by hand while there is no key to send it with.
  if (opts.stopAfter === 'prompt') {
    entry.stage = 'prompt';
    const prompt = TyreCore.buildExtractionPrompt(retrieval.text, {
      company: company.name,
      quarter: opts.quarter
    });
    const promptPath = join(runDir, 'prompts', `${company.id}.txt`);
    await mkdir(dirname(promptPath), { recursive: true });
    await writeFile(promptPath, `${promptText(prompt)}\n`, 'utf8');
    entry.prompt = {
      path: promptPath,
      chars: prompt.system.length + prompt.user.length,
      selection: prompt.selection || null,
      source_path: retrieval.path || null
    };
    entry.ok = true;
    entry.duration_ms = Date.now() - startedAt;
    return entry;
  }

  entry.stage = 'extraction';
  const responsePath = opts.responses.get(company.id) || null;
  const engine = responsePath ? 'manual' : opts.offlineExtract ? 'offline' : 'api';

  let extraction;
  if (responsePath) {
    // --response. The answer came back in a person's clipboard rather than an HTTP
    // response; it is verified against this run's retrieved text all the same.
    let responseText;
    try {
      responseText = await readFile(responsePath, 'utf8');
    } catch (err) {
      entry.error = `${company.name}: could not read the response file ${responsePath} — ${err.message}`;
      entry.duration_ms = Date.now() - startedAt;
      return entry;
    }
    extraction = extractRecordFromResponse({ ...args, responseText, origin: responsePath });
  } else if (opts.offlineExtract) {
    extraction = await extractRecordOffline(args);
  } else {
    extraction = await extractRecord({
      ...args,
      apiKey: opts.apiKey,
      model: opts.model,
      thinking: opts.thinking
    });
  }

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

// The API sends the guardrails as a system prompt and the filing as the user
// turn. A chat window has no system slot, so the two are concatenated with a
// visible rule between them — same words, same order, one paste.
function promptText(prompt) {
  return [
    '=== INSTRUCTIONS (system prompt) ===',
    '',
    prompt.system,
    '',
    '=== FILING (user message) ===',
    '',
    prompt.user
  ].join('\n');
}

// Written next to the prompts so the second half of the round trip does not have
// to be remembered or reconstructed — including the source path, because the
// answer is verified against the same text the prompt was built from.
function promptsReadme(runResult, entries) {
  const done = entries.filter((e) => e.ok && e.prompt);
  const lines = [
    '# Extraction prompts — carry these by hand',
    '',
    `Run \`${runResult.run_id}\` · ${runResult.quarter} · ${done.length} compan${done.length === 1 ? 'y' : 'ies'}`,
    '',
    'There is no API key yet, so nothing here was sent anywhere. Each `.txt` below is',
    'exactly what the pipeline would have sent: the same guardrails, the same schema,',
    'the same filing text. You are the transport.',
    '',
    '## For each company',
    '',
    '1. Open the `.txt` file and paste the whole thing into a Claude chat.',
    '2. Copy the JSON object that comes back into a file, say `answer.json`.',
    '   A code fence around it is fine; anything before or after it is fine.',
    '3. Feed it back with the command printed under that company below.',
    '',
    'Step 3 verifies every quote against the same filing text this prompt was built',
    'from. A quote that is not in the filing is rejected there, exactly as it would',
    'be on a live run — carrying the answer by hand does not skip the gate.',
    ''
  ];
  for (const e of done) {
    const src = e.prompt.source_path ? ` --file=${e.id}:${e.prompt.source_path}` : '';
    lines.push(
      `## ${e.name}`,
      '',
      `- prompt: \`${e.prompt.path}\` (${e.prompt.chars.toLocaleString('en-US')} characters)`,
      `- retrieved text: \`${e.prompt.source_path || '(not written to disk)'}\``,
      '',
      '```',
      `node pipeline/run.mjs --companies=${e.id} --quarter=${JSON.stringify(runResult.quarter)}${src} \\`,
      `  --response=${e.id}:<path-to-answer.json>`,
      '```',
      ''
    );
  }
  if (!done.length) {
    lines.push('No prompts were written — every company failed before extraction. See `report.md`.', '');
  }
  return lines.join('\n');
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
  if (entry.stage === 'retrieved') {
    const r = entry.retrieval;
    return `${tag} ${entry.name}: ${r.strategy} → ${r.bytes.toLocaleString('en-US')} characters from ${r.source}`;
  }
  if (entry.stage === 'prompt') {
    return `${tag} ${entry.name}: prompt written — ${entry.prompt.chars.toLocaleString('en-US')} characters to carry`;
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
  if (opts.stopAfter === 'retrieval') {
    log('  extraction: skipped — --retrieve-only stops after Stage 1');
  } else if (opts.stopAfter === 'prompt') {
    log('  extraction: not run — --emit-prompt writes the prompt for a person to carry');
  } else if (opts.responses.size) {
    const carried = [...opts.responses.keys()].join(', ');
    const rest = opts.companies.filter((c) => !opts.responses.has(c.id)).length;
    log(`  extraction: pasted answers for ${carried}${rest ? `; ${rest} other${rest === 1 ? '' : 's'} ${opts.offlineExtract ? 'offline' : `via Claude API, ${opts.model}`}` : ''}`);
  } else {
    log(`  extraction: ${opts.offlineExtract ? `offline deterministic extractor${opts.offlineImplied ? ' (no ANTHROPIC_API_KEY set)' : ''}` : `Claude API, ${opts.model}${opts.thinking ? ', adaptive thinking' : ', thinking off'}`}`);
  }
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
    stop_after: opts.stopAfter,
    model: opts.offlineExtract || opts.stopAfter ? null : opts.model,
    extractor: opts.stopAfter
      ? `stopped-after-${opts.stopAfter}`
      : opts.responses.size
        ? 'manual'
        : opts.offlineExtract
          ? 'offline'
          : 'api',
    generated_at: finishedAt.toISOString(),
    started_at: startedAt.toISOString(),
    duration_ms: finishedAt - startedAt,
    run_dir: runDir,
    records_path: recordsPath,
    report_path: reportPath,
    companies,
    records
  };

  if (opts.stopAfter === 'prompt') {
    await writeFile(join(runDir, 'prompts', 'README.md'), promptsReadme(runResult, companies), 'utf8');
  }

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

  // A stop-early run produces no records by design, so "did anything work" is the
  // count of companies that reached the stopping point rather than the record count.
  if (opts.stopAfter) {
    const reached = companies.filter((c) => c.ok).length;
    if (opts.stopAfter === 'prompt' && reached) {
      process.stdout.write(`\nNext: ${join(runDir, 'prompts', 'README.md')}\n`);
    }
    return reached ? 0 : 1;
  }
  return records.length ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
