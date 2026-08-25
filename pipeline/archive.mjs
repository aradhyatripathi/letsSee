#!/usr/bin/env node
// The cross-quarter archive of reviewed records.
//
// The original scoping note wants history — a Git/Obsidian store so quarters
// accumulate and trends are visible. The build spec lists a cross-quarter archive
// as a non-goal for its week (Section 7). Read Section 0's second boundary
// carefully and the distinction is the whole design of this file:
//
//   "No unattended storage of scraped source documents. Retrieved filings are
//    processed in the run and written to reviewed output — not archived on a
//    schedule to Drive or anywhere else without a human in the loop."
//
// What is forbidden is archiving the scraped documents, unattended. Reviewed
// output is named as the permitted destination. So this archives records a person
// has approved, one file per company per quarter, committed to the repository by
// that same person — and it refuses anything that is not approved, which is what
// keeps the two apart. Retrieved filing text stays in runs/, gitignored, and
// never comes near this directory.
//
//   node pipeline/archive.mjs --records=runs/<id>/records.json   add to the archive
//   node pipeline/archive.mjs --export=all-quarters.json         read it back out
//   node pipeline/archive.mjs --list                             what is in it

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TyreCore } from './lib/core.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = join(REPO_ROOT, 'archive');

const USAGE = `
The cross-quarter archive of reviewed records.

  node pipeline/archive.mjs --records=<path>     add approved records
  node pipeline/archive.mjs --export=<path>      write every archived record to one file
  node pipeline/archive.mjs --list               show what is archived
  (or: npm run archive -- <options>)

Options
  --records=<path>   Records JSON to add. Only approved records are taken.
  --export=<path>    Write the whole archive as one records file, ready to import
                     into the dashboard so trends span quarters.
  --list             Print the archive contents and exit.
  --dir=<path>       Archive location. Default: archive/
  --force            Overwrite an archived record that has changed. Without it, a
                     changed record is reported and left alone.
  --help             This text.

Only records a person approved are archived. That is the line Section 0 draws:
reviewed output may be kept, scraped filings may not. Retrieved text lives in
runs/, is gitignored, and never reaches this directory.
`.trim();

const BOOLEAN_FLAGS = new Set(['help', 'list', 'force']);
const VALUE_FLAGS = new Set(['records', 'export', 'dir']);

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

/** Filesystem-safe, stable, and readable in a diff. */
export function slug(value, fallback) {
  const s = String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return s || fallback;
}

/** Where one record lives: archive/<quarter>/<company>.json */
export function recordPath(dir, record) {
  return join(dir, slug(record.quarter, 'unknown-quarter'), `${slug(record.company, 'unknown-company')}.json`);
}

/** Every record in the archive, sorted oldest quarter first then by company. */
export async function readArchive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const quarter of (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    const quarterDir = join(dir, quarter.name);
    for (const file of await readdir(quarterDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(await readFile(join(quarterDir, file), 'utf8')));
      } catch (err) {
        throw new Error(`${join(quarterDir, file)} is not readable JSON — ${err.message}`);
      }
    }
  }
  out.sort((a, b) => {
    const ka = TyreCore.quarterSortKey(a.quarter) ?? 0;
    const kb = TyreCore.quarterSortKey(b.quarter) ?? 0;
    return ka - kb || String(a.company || '').localeCompare(String(b.company || ''));
  });
  return out;
}

/** Comparable content, ignoring which run produced it and when. */
function contentOf(record) {
  return JSON.stringify([
    record.company, record.quarter, record.currency,
    record.core, record.quotes, record.segments, record.outlook
  ]);
}

/**
 * Add approved records to the archive.
 * @returns {Promise<{added:Array, unchanged:Array, changed:Array, skipped:Array}>}
 */
export async function addToArchive(records, dir, { force = false } = {}) {
  const result = { added: [], unchanged: [], changed: [], skipped: [] };

  for (const record of records) {
    const status = (record.review && record.review.status) || 'pending';
    if (status !== 'approved') {
      result.skipped.push({ record, reason: status });
      continue;
    }
    const problems = TyreCore.validateStored(record);
    if (problems.length) {
      result.skipped.push({ record, reason: `malformed: ${problems.join('; ')}` });
      continue;
    }

    const path = recordPath(dir, record);
    if (existsSync(path)) {
      const existing = JSON.parse(await readFile(path, 'utf8'));
      if (contentOf(existing) === contentOf(record)) {
        result.unchanged.push({ record, path });
        continue;
      }
      if (!force) {
        result.changed.push({ record, path });
        continue;
      }
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    result.added.push({ record, path });
  }
  return result;
}

function summarizeQuarters(records) {
  const byQuarter = new Map();
  for (const r of records) {
    const q = r.quarter || 'unknown';
    if (!byQuarter.has(q)) byQuarter.set(q, []);
    byQuarter.get(q).push(r.company || 'unknown');
  }
  return [...byQuarter.entries()].sort(
    (a, b) => (TyreCore.quarterSortKey(a[0]) ?? 0) - (TyreCore.quarterSortKey(b[0]) ?? 0)
  );
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

  const dir = flags.dir ? resolve(process.cwd(), flags.dir) : DEFAULT_DIR;

  if (flags.list || (!flags.records && !flags.export)) {
    const archived = await readArchive(dir);
    if (!archived.length) {
      process.stdout.write(`The archive at ${dir} is empty.\n\nAdd to it with:\n  node pipeline/archive.mjs --records=<path>\n`);
      return 0;
    }
    process.stdout.write(`${dir}\n  ${archived.length} approved record${archived.length === 1 ? '' : 's'}\n\n`);
    for (const [quarter, companies] of summarizeQuarters(archived)) {
      process.stdout.write(`  ${quarter}: ${companies.sort().join(', ')}\n`);
    }
    return 0;
  }

  if (flags.export) {
    const archived = await readArchive(dir);
    if (!archived.length) {
      process.stderr.write(`The archive at ${dir} is empty — nothing to export.\n`);
      return 1;
    }
    const out = resolve(process.cwd(), flags.export);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify({
      archive_version: 1,
      exported_at: new Date().toISOString(),
      quarters: summarizeQuarters(archived).map(([q]) => q),
      records: archived
    }, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `${out}\n  ${archived.length} record${archived.length === 1 ? '' : 's'} across ${summarizeQuarters(archived).length} quarter(s)\n` +
      '  Import it in the dashboard to compare quarters. Every record was approved before it was archived.\n'
    );
    return 0;
  }

  const recordsPath = resolve(process.cwd(), flags.records);
  let records;
  try {
    const payload = JSON.parse(await readFile(recordsPath, 'utf8'));
    records = Array.isArray(payload) ? payload : payload.records;
    if (!Array.isArray(records)) throw new Error('expected an array, or an object with a "records" array');
  } catch (err) {
    process.stderr.write(`could not read records from ${recordsPath} — ${err.message}\n`);
    return 1;
  }

  const result = await addToArchive(records, dir, { force: flags.force === true });

  const lines = [dir];
  lines.push(`  ${result.added.length} written, ${result.unchanged.length} already archived unchanged`);
  for (const { record, path } of result.added) {
    lines.push(`    + ${record.company} ${record.quarter} -> ${path.replace(`${REPO_ROOT}/`, '')}`);
  }
  if (result.changed.length) {
    lines.push('');
    lines.push(`  ${result.changed.length} differ${result.changed.length === 1 ? 's' : ''} from what is archived and ${result.changed.length === 1 ? 'was' : 'were'} left alone:`);
    for (const { record, path } of result.changed) {
      lines.push(`    ! ${record.company} ${record.quarter} — ${path.replace(`${REPO_ROOT}/`, '')}`);
    }
    lines.push('    An archived quarter changing usually means a restatement or a re-review.');
    lines.push('    Look at the difference, then re-run with --force to accept it.');
  }
  if (result.skipped.length) {
    lines.push('');
    lines.push(`  ${result.skipped.length} not archived:`);
    for (const { record, reason } of result.skipped) {
      lines.push(`    - ${record.company || 'unknown'} ${record.quarter || ''} — ${reason}`);
    }
    lines.push('    Only approved records are archived: reviewed output may be kept, unreviewed extractions may not.');
  }
  if (result.added.length) {
    lines.push('');
    lines.push('  Commit the archive to keep the history. Nothing here is written unattended.');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return result.added.length || result.unchanged.length ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`${err.stack || err.message}\n`); process.exitCode = 1; }
  );
}

export { main };
