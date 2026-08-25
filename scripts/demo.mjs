#!/usr/bin/env node
// One command that produces everything there is to look at, with no API key and
// no network: `npm run demo`.
//
// It deliberately stops short of approving anything. Every artefact it builds is
// marked a draft, because the one thing this pipeline will not do is manufacture
// a review — and a demo script that ticked the box would be doing exactly that
// while demonstrating a system whose entire argument is that it doesn't. The
// last thing it prints is how to do the review for real.
//
// The filings behind it are synthetic. Every fixture says so on its first line.

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPANIES } from '../pipeline/config/companies.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'demo-output');

// Oldest first. Two quarters rather than one because a single snapshot leaves the
// quarter-on-quarter deltas and the deck's trend slides with nothing to compute.
const QUARTERS = ['Q4 FY25', 'Q1 FY26'];

const BOLD = process.stdout.isTTY ? '\u001b[1m' : '';
const DIM = process.stdout.isTTY ? '\u001b[2m' : '';
const OFF = process.stdout.isTTY ? '\u001b[0m' : '';

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function step(n, total, title) {
  say('');
  say(`${BOLD}[${n}/${total}] ${title}${OFF}`);
}

function run(args, { quiet = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let out = '';
    let err = '';
    if (quiet) {
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
    }
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, out, err }));
  });
}

async function main() {
  const TOTAL = 5;
  say(`${BOLD}Tyre intelligence pipeline — offline demo${OFF}`);
  say(`${DIM}No API key, no network. The filings are synthetic and say so on their first line.${OFF}`);
  say(`${DIM}${COMPANIES.length} companies in the roster: ${COMPANIES.map((c) => c.name).join(', ')}${OFF}`);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  step(1, TOTAL, 'Retrieval check — what each source hands over');
  const retrieval = await run(['pipeline/run.mjs', '--retrieve-only', `--out=${join(OUT_DIR, 'retrieval.json')}`]);
  if (retrieval.code !== 0) {
    say(retrieval.err || retrieval.out);
    throw new Error('the retrieval check failed');
  }
  for (const line of retrieval.out.split('\n').filter((l) => l.trim().startsWith('- '))) say(`  ${line.trim()}`);
  say(`  ${DIM}Against live sites this is the command that answers "which IR pages actually work".${OFF}`);

  step(2, TOTAL, 'Extract, verify every quote, and store — two quarters');
  const recordsPath = join(OUT_DIR, 'records.json');
  const perQuarter = [];
  for (const quarter of QUARTERS) {
    const out = join(OUT_DIR, `records-${quarter.replace(/\W+/g, '-').toLowerCase()}.json`);
    const extract = await run(['pipeline/run.mjs', `--quarter=${quarter}`, `--out=${out}`]);
    if (extract.code !== 0) {
      say(extract.err || extract.out);
      throw new Error(`the ${quarter} run failed`);
    }
    perQuarter.push(JSON.parse(await readFile(out, 'utf8')));
  }
  // Merged so the dashboard and the deck see a history rather than a snapshot: this is
  // what gives the review screen its quarter-on-quarter deltas and the deck its trends.
  const payload = {
    run_id: perQuarter[perQuarter.length - 1].run_id,
    quarter: QUARTERS[QUARTERS.length - 1],
    mode: 'fixture',
    model: null,
    extractor: 'offline',
    generated_at: new Date().toISOString(),
    records: perQuarter.flatMap((p) => p.records)
  };
  await writeFile(recordsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const checks = payload.records.reduce(
    (acc, r) => {
      const v = r.verification || {};
      acc.checked += v.checked || 0;
      acc.verified += v.verified || 0;
      acc.failed += v.failed || 0;
      return acc;
    },
    { checked: 0, verified: 0, failed: 0 }
  );
  say(`  ${payload.records.length} records across ${QUARTERS.length} quarters (${QUARTERS.join(', ')})`);
  say(`  ${checks.verified} of ${checks.checked} quotes verified against the filing they came from, ${checks.failed} rejected`);
  say(`  ${DIM}Every record is review status "pending". Extraction produces candidates, never accepted records.${OFF}`);

  step(3, TOTAL, 'Build the deck — as a draft, because nothing has been reviewed');
  const deckPath = join(OUT_DIR, 'tyre-sector-DRAFT.pptx');
  const deck = await run(['pipeline/deck.mjs', `--records=${recordsPath}`, `--out=${deckPath}`, '--include-pending']);
  say(deck.out.split('\n').filter(Boolean).map((l) => `  ${l.trim()}`).join('\n'));

  step(4, TOTAL, 'Build the workbook — the spec\u2019s primary output, and it needs no network');
  const wbPath = join(OUT_DIR, 'tyre-workbook-DRAFT.xlsx');
  const workbook = await run(['pipeline/workbook.mjs', `--records=${recordsPath}`, `--out=${wbPath}`, '--include-pending']);
  say(workbook.out.split('\n').filter(Boolean).map((l) => `  ${l.trim()}`).join('\n'));
  say(`  ${DIM}Four sheets, and every figure's cell carries the quote behind it as a comment.${OFF}`);

  step(5, TOTAL, 'Try to archive it — and watch it refuse');
  const archive = await run(['pipeline/archive.mjs', `--records=${recordsPath}`, `--dir=${join(OUT_DIR, 'archive')}`]);
  const refused = archive.out.split('\n').filter((l) => /not archived|Only approved/.test(l));
  for (const line of refused.slice(0, 2)) say(`  ${line.trim()}`);
  say(`  ${DIM}The archive takes reviewed output only. That is the boundary, enforced rather than described.${OFF}`);

  say('');
  say(`${BOLD}What just happened${OFF}`);
  say('  A person ran one command. It retrieved, extracted, checked every figure against a');
  say('  quote from its own filing, and produced both output artefacts — with no network and');
  say('  no API key — and then refused to treat any of it as trustworthy, because nobody has');
  say('  looked at it yet.');
  say('');
  say(`${BOLD}Everything is in ${OUT_DIR.replace(`${REPO_ROOT}/`, '')}/${OFF}`);
  say(`  records.json              both quarters, all pending review`);
  say('  tyre-sector-DRAFT.pptx    every company starred — unreviewed — plus trend slides');
  say('  tyre-workbook-DRAFT.xlsx  four sheets, every row marked NOT REVIEWED');
  say('  report.md is in the run directory printed above');
  say('');
  say(`${BOLD}To finish it properly${OFF}`);
  say('  1. npm run serve:dashboard        and open the printed URL');
  say(`  2. Records -> Restore / import JSON -> ${recordsPath.replace(`${REPO_ROOT}/`, '')}`);
  say('  3. Review tab — every figure sits next to the quote behind it. Approve or reject each.');
  say('     Records tab shows quarter-on-quarter movement now that there are two quarters.');
  say('  4. Export the workbook and the deck. Both default to approved records only.');
  say(`  5. ${DIM}npm run archive -- --records=<your export>${OFF}  to keep the quarter.`);
  say('');
  say(`${DIM}Reminder: these are invented numbers in the shape of real filings. Nothing here is a${OFF}`);
  say(`${DIM}reported figure, and no figure should be quoted as one.${OFF}`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`\ndemo failed: ${err.message}\n`);
    process.exitCode = 1;
  }
);
