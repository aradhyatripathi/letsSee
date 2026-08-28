#!/usr/bin/env node
// Build the four-sheet Excel workbook from a records file.
//
// The workbook is the build spec's primary output artefact (Section 5). The dashboard's
// Export button renders the identical file from the identical code; this exists so the
// deliverable can be produced without opening a browser at all, and so `npm run demo` can
// show it.
//
// Approved-only by default, for the same reason the deck is: a workbook circulates.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TyreCore } from './lib/core.mjs';
import { expandHome } from './lib/userpath.mjs';
import { approvalSourceNote } from './lib/report.mjs';
import { TyreXlsx } from './lib/xlsx.mjs';

const USAGE = `
Build the four-sheet workbook from reviewed records.

  node pipeline/workbook.mjs --records=<path> [options]
  (or: npm run workbook -- --records=<path>)

Options
  --records=<path>     Records JSON: a run's records.json, a dashboard export, or a bare
                       array of records. Required.
  --out=<path>         Where to write the .xlsx. Default: alongside --records.
  --include-pending    Include records nobody has reviewed yet. Off by default; every row
                       carries its review state either way.
  --help               This text.

Records a reviewer rejected are never included, with or without --include-pending.

Sheets: Core Financials, Segments, Outlook, Sources & Quotes. Every populated Core
Financials cell carries a comment holding the source quote behind the figure, keyed to a
row of Sources & Quotes, so a number can be checked without leaving the file.
`.trim();

const BOOLEAN_FLAGS = new Set(['help', 'include-pending']);
const VALUE_FLAGS = new Set(['records', 'out']);

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
  const model = TyreCore.buildWorkbookModel(records, { reviewedOnly });

  if (!model.generated_for) {
    const rejected = records.filter((r) => TyreCore.isRejected(r)).length;
    const unapproved = records.length - rejected;
    process.stderr.write(
      'No records qualify for the workbook.\n' +
      `  ${records.length} record${records.length === 1 ? '' : 's'} in ${recordsPath}\n` +
      (rejected ? `  ${rejected} rejected in review (never included)\n` : '') +
      (reviewedOnly && unapproved
        ? `  ${unapproved} not yet approved — review in the dashboard, or pass --include-pending\n`
        : '') +
      'Nothing was written.\n'
    );
    return 1;
  }

  const outPath = flags.out
    ? resolve(process.cwd(), expandHome(flags.out))
    : join(dirname(recordsPath), 'workbook.xlsx');
  await mkdir(dirname(outPath), { recursive: true });
  const bytes = TyreXlsx.writeXlsx(model);
  await writeFile(outPath, bytes);

  const unreviewed = model.sheets[0].aoa.slice(1).filter((row) => row[2] === 'NOT REVIEWED').length;
  process.stdout.write(
    `${outPath}\n` +
    `  ${model.sheets.length} sheets · ${(bytes.length / 1024).toFixed(0)} KB\n` +
    `  ${model.generated_for} record${model.generated_for === 1 ? '' : 's'} · ${model.comments.length} cell comments carrying the source quote\n` +
    approvalSourceNote(model.generated_for - unreviewed, recordsPath) +
    (unreviewed ? `\n${unreviewed} row${unreviewed === 1 ? '' : 's'} say NOT REVIEWED. This is a draft.\n` : '')
  );
  return 0;
}

// Windows gives process.argv[1] as C:\path\to\file.mjs while import.meta.url is
// file:///C:/path/to/file.mjs, so comparing the two as strings is never true there —
// and the failure is silent: the CLI exits 0 having done nothing. Compare resolved
// paths instead, which is what scripts/serve.mjs already did.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`${err.stack || err.message}\n`); process.exitCode = 1; }
  );
}

export { main };
