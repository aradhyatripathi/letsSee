#!/usr/bin/env node
// Build the PowerPoint deck from a records file.
//
// The build spec makes a deck a non-goal for its own week (Section 7) while the
// original scoping note asks for one. It is a non-goal, not a boundary: a deck is
// built from records a person has already reviewed, so nothing about it schedules
// a run or retains a scraped document. This is that deck.
//
// Records come from either half of the pipeline — runs/<id>/records.json straight
// out of a run, or the JSON the dashboard exports after review. The dashboard's
// Export Deck button renders the identical slides from the identical code.
//
// Approved-only by default. A deck travels further than a spreadsheet and gets
// read out of context, so the safe default is that everything on it has been
// checked by a person; --include-pending relaxes that and marks every unreviewed
// company with an asterisk on every slide it appears on.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';

import { TyreCore } from './lib/core.mjs';
import { TyreDeck } from './lib/deck.mjs';

const USAGE = `
Build the sector deck from reviewed records.

  node pipeline/deck.mjs --records=<path> [options]
  (or: npm run deck -- --records=<path>)

Options
  --records=<path>     Records JSON: a run's records.json, a dashboard export, or
                       a bare array of records. Required.
  --out=<path>         Where to write the .pptx. Default: alongside --records.
  --quarter="Q1 FY26"  Label for the title slide. Default: taken from the records.
  --include-pending    Include records nobody has reviewed yet, marked with '*'.
                       Off by default: a deck circulates further than a workbook.
  --help               This text.

Records a reviewer rejected are never included, with or without --include-pending.

Examples
  node pipeline/deck.mjs --records=runs/2026-08-25T1200-000Z/records.json --include-pending
  node pipeline/deck.mjs --records=reviewed.json --out=~/Desktop/tyre-q1fy26.pptx
`.trim();

const BOOLEAN_FLAGS = new Set(['help', 'include-pending']);
const VALUE_FLAGS = new Set(['records', 'out', 'quarter']);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument '${token}' — every option starts with --`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new Error(`--${name} is a switch and takes no value`);
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option --${name}`);
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = value;
  }
  return flags;
}

function expandHome(path) {
  if (path === '~') return process.env.HOME || path;
  if (path.startsWith('~/') && process.env.HOME) return join(process.env.HOME, path.slice(2));
  return path;
}

/** Accept a run payload, a dashboard export, or a bare array. */
export function readRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.records)) return payload.records;
  throw new Error('no records found — expected an array, or an object with a "records" array');
}

async function main(argv) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\nRun with --help for the full option list.\n`);
    return 1;
  }
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!flags.records) {
    process.stderr.write(`--records is required.\n\n${USAGE}\n`);
    return 1;
  }

  const recordsPath = resolve(process.cwd(), expandHome(flags.records));
  let records;
  try {
    records = readRecords(JSON.parse(await readFile(recordsPath, 'utf8')));
  } catch (err) {
    process.stderr.write(`could not read records from ${recordsPath} — ${err.message}\n`);
    return 1;
  }

  const reviewedOnly = flags['include-pending'] !== true;
  const model = TyreCore.buildDeckModel(records, {
    reviewedOnly,
    quarter: flags.quarter || null,
    generatedAt: new Date().toISOString()
  });

  // An empty deck is the correct output for "nothing has been reviewed", but it is
  // a confusing file to be handed, so say what happened instead of writing it.
  if (!model.provenance.total) {
    const p = model.provenance;
    const lines = [
      'No records qualify for the deck.',
      `  ${p.input_records} record${p.input_records === 1 ? '' : 's'} in ${recordsPath}`
    ];
    if (p.rejected_withheld) lines.push(`  ${p.rejected_withheld} rejected in review (never included)`);
    if (p.other_quarters_held_back) {
      lines.push(
        `  ${p.other_quarters_held_back} in other quarters — this deck compares ${p.quarter}` +
        (flags.quarter ? ` because --quarter asked for it` : '') +
        `. Available: ${p.archived_quarters.join(', ') || 'none'}`
      );
    }
    if (p.undated_withheld) lines.push(`  ${p.undated_withheld} state no quarter at all`);
    const unapproved = p.input_records - p.rejected_withheld - p.other_quarters_held_back - p.undated_withheld;
    if (reviewedOnly && unapproved > 0) {
      lines.push(`  ${unapproved} not yet approved — review in the dashboard, or pass --include-pending for a draft deck`);
    }
    lines.push('Nothing was written.');
    process.stderr.write(`${lines.join('\n')}\n`);
    return 1;
  }

  const outPath = flags.out
    ? resolve(process.cwd(), expandHome(flags.out))
    : join(dirname(recordsPath), 'deck.pptx');
  await mkdir(dirname(outPath), { recursive: true });
  const bytes = TyreDeck.writePptx(model);
  await writeFile(outPath, bytes);

  const p = model.provenance;
  process.stdout.write(
    `${outPath}\n` +
    `  ${model.slides.length} slides · ${(bytes.length / 1024).toFixed(0)} KB\n` +
    `  ${p.total} compan${p.total === 1 ? 'y' : 'ies'}: ${p.approved} approved${p.pending ? `, ${p.pending} pending (marked *)` : ''}\n` +
    (p.rejected_withheld ? `  ${p.rejected_withheld} rejected record${p.rejected_withheld === 1 ? '' : 's'} withheld\n` : '') +
    (p.currencies.length > 1 ? `  ${p.currencies.length} currencies present — figures are not converted, and the slides say so\n` : '') +
    (p.pending ? '\nThis deck contains records nobody has reviewed. It is a draft.\n' : '')
  );
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`${err.stack || err.message}\n`); process.exitCode = 1; }
  );
}

export { main };
