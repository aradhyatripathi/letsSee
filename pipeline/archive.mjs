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

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TyreCore } from './lib/core.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = join(REPO_ROOT, 'archive');

// A quote is a short span of a filing, and it belongs here — it is what makes a figure
// auditable. A filing is not, and boundary 2 turns on that difference. Nothing enforced
// it before: a whole document is trivially an exact substring of itself, so a record
// carrying one as its "quote" verified at a perfect score and archived cleanly.
const MAX_STRING_CHARS = 2000;
const MAX_RECORD_CHARS = 200000;

/** Short stable hash, for telling apart names that slug to the same thing. */
function shortHash(value) {
  var h = 5381;
  const s = String(value == null ? '' : value);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

/** The longest string anywhere in a record, and where it was. */
function longestString(record) {
  let worst = { len: 0, path: null };
  (function walk(node, path) {
    if (typeof node === 'string') {
      if (node.length > worst.len) worst = { len: node.length, path: path || '(root)' };
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  })(record, '');
  return worst;
}

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

Only records a person approved are archived, and a record that has since been
rejected is taken back out. Nothing longer than a quote is accepted at all. That is the line Section 0 draws:
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
  // A name with no ASCII alphanumerics — every Devanagari name, for instance — slugs to
  // the same fallback, and two of them would then be the same file. Names in that case
  // carry a hash of the original so they stay distinct and stay stable.
  const base = slug(record.company, '');
  const name = base || `company-${shortHash(record.company)}`;
  return join(dir, slug(record.quarter, 'unknown-quarter'), `${name}.json`);
}

/**
 * Everything in the archive, oldest quarter first then by company.
 *
 * Reading re-checks what writing checked. The archive is a directory on disk that
 * anything can write to, and --list and --export used to print "every record was approved
 * before it was archived" over whatever files happened to be there — pointed at the wrong
 * directory it would vouch for records nobody had ever reviewed. A file that is not an
 * approved, well-formed record is reported as a problem rather than returned as a record.
 *
 * @returns {Promise<{records: Array, problems: Array<{path:string, reason:string}>}>}
 */
export async function readArchive(dir) {
  const records = [];
  const problems = [];
  if (!existsSync(dir)) return { records, problems };

  for (const quarter of (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    const quarterDir = join(dir, quarter.name);
    for (const entry of await readdir(quarterDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(quarterDir, entry.name);
      let parsed;
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
      } catch (err) {
        problems.push({ path, reason: `not readable JSON — ${err.message}` });
        continue;
      }
      const reason = archiveRejectionReason(parsed);
      if (reason) problems.push({ path, reason });
      else records.push(parsed);
    }
  }

  records.sort((a, b) => {
    const ka = TyreCore.quarterSortKey(a.quarter) ?? 0;
    const kb = TyreCore.quarterSortKey(b.quarter) ?? 0;
    return ka - kb || String(a.company || '').localeCompare(String(b.company || ''));
  });
  return { records, problems };
}

/** Why a record may not be archived, or null when it may. One rule, used both ways. */
export function archiveRejectionReason(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not a record object';
  const status = TyreCore.reviewStatus(record);
  if (status !== 'approved') return status;
  const problems = TyreCore.validateStored(record);
  if (problems.length) return `malformed: ${problems.join('; ')}`;

  const worst = longestString(record);
  if (worst.len > MAX_STRING_CHARS) {
    return `${worst.path} holds ${worst.len.toLocaleString('en-US')} characters — that is a document, not a quote (limit ${MAX_STRING_CHARS})`;
  }
  const size = JSON.stringify(record).length;
  if (size > MAX_RECORD_CHARS) {
    return `the record serialises to ${size.toLocaleString('en-US')} characters (limit ${MAX_RECORD_CHARS})`;
  }
  return null;
}

/** Comparable content, ignoring which run produced it and when. */
function contentOf(record) {
  return JSON.stringify([
    record.company, record.quarter, record.currency,
    record.core, record.quotes, record.segments, record.outlook
  ]);
}

/**
 * Add approved records to the archive, and take out records that are no longer approved.
 *
 * @returns {Promise<{added:Array, unchanged:Array, changed:Array, removed:Array,
 *                    skipped:Array, failed:Array, collisions:Array}>}
 */
export async function addToArchive(records, dir, { force = false } = {}) {
  const result = { added: [], unchanged: [], changed: [], removed: [], skipped: [], failed: [], collisions: [] };

  for (const record of records || []) {
    if (!record || typeof record !== 'object') {
      result.skipped.push({ record, reason: 'not a record object' });
      continue;
    }

    let path;
    try {
      path = recordPath(dir, record);
    } catch (err) {
      result.failed.push({ record, path: null, error: err.message });
      continue;
    }

    // A record approved and archived, then rejected on re-review, used to stay in the
    // archive and keep being exported while the run printed a line implying the
    // rejection had taken effect. A rejection now takes the archived copy out, which is
    // the only reading of "reviewed output" that survives someone changing their mind.
    if (TyreCore.isRejected(record)) {
      if (existsSync(path)) {
        try {
          await rm(path);
          result.removed.push({ record, path });
        } catch (err) {
          result.failed.push({ record, path, error: err.message });
        }
      } else {
        result.skipped.push({ record, reason: 'rejected' });
      }
      continue;
    }

    const reason = archiveRejectionReason(record);
    if (reason) {
      result.skipped.push({ record, reason });
      continue;
    }

    try {
      if (existsSync(path)) {
        const existing = JSON.parse(await readFile(path, 'utf8'));
        // Two different companies resolving to one filename must never end with one
        // silently overwriting the other, --force or not.
        if (String(existing.company || '') !== String(record.company || '')) {
          result.collisions.push({ record, path, occupant: existing.company || '(unnamed)' });
          continue;
        }
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
    } catch (err) {
      // One unwritable filename used to abort the loop, so approved records after it were
      // never archived and no summary was printed at all.
      result.failed.push({ record, path, error: err.message });
    }
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

  // --records with --list or --export used to be silently discarded, and the --list form
  // exited 0, so an operator could believe a record had been archived when nothing had.
  if (flags.records && (flags.list || flags.export)) {
    process.stderr.write(
      '--records adds to the archive; --list and --export read it. Run them as two commands ' +
      'so it is clear which one happened.\n'
    );
    return 1;
  }

  if (flags.list || (!flags.records && !flags.export)) {
    const { records: archived, problems } = await readArchive(dir);
    if (!archived.length && !problems.length) {
      process.stdout.write(`The archive at ${dir} is empty.\n\nAdd to it with:\n  node pipeline/archive.mjs --records=<path>\n`);
      return 0;
    }
    process.stdout.write(`${dir}\n  ${archived.length} approved record${archived.length === 1 ? '' : 's'}\n\n`);
    for (const [quarter, companies] of summarizeQuarters(archived)) {
      process.stdout.write(`  ${quarter}: ${companies.sort().join(', ')}\n`);
    }
    if (problems.length) {
      process.stdout.write(`\n  ${problems.length} file${problems.length === 1 ? '' : 's'} in this directory ${problems.length === 1 ? 'is' : 'are'} not an approved record and ${problems.length === 1 ? 'was' : 'were'} not counted:\n`);
      for (const p of problems) {
        process.stdout.write(`    ! ${p.path.replace(`${REPO_ROOT}/`, '')} — ${p.reason}\n`);
      }
    }
    return problems.length && !archived.length ? 1 : 0;
  }

  if (flags.export) {
    const { records: archived, problems } = await readArchive(dir);
    if (!archived.length) {
      process.stderr.write(
        `The archive at ${dir} holds no approved records — nothing to export.\n` +
        (problems.length ? `  ${problems.length} file(s) there are not approved records; run --list to see why.\n` : '')
      );
      return 1;
    }
    if (problems.length) {
      process.stderr.write(`Note: ${problems.length} file(s) in ${dir} were skipped because they are not approved records. Run --list for the detail.\n`);
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
      '  Every record in this file was checked on the way out: approved, well-formed, and no field long enough to be a document.\n'
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
  lines.push(`  ${result.added.length} written, ${result.unchanged.length} already archived unchanged` +
    (result.removed.length ? `, ${result.removed.length} removed` : ''));
  for (const { record, path } of result.added) {
    lines.push(`    + ${record.company} ${record.quarter} -> ${path.replace(`${REPO_ROOT}/`, '')}`);
  }
  for (const { record, path } of result.removed) {
    lines.push(`    - ${record.company} ${record.quarter} — rejected on re-review, taken out of ${path.replace(`${REPO_ROOT}/`, '')}`);
  }
  if (result.collisions.length) {
    lines.push('');
    lines.push(`  ${result.collisions.length} name collision${result.collisions.length === 1 ? '' : 's'} — nothing was overwritten:`);
    for (const { record, path, occupant } of result.collisions) {
      lines.push(`    ! ${record.company} would land on ${path.replace(`${REPO_ROOT}/`, '')}, which holds ${occupant}`);
    }
    lines.push('    Give one of them a distinguishable name in pipeline/config/companies.mjs.');
  }
  if (result.failed.length) {
    lines.push('');
    lines.push(`  ${result.failed.length} could not be written:`);
    for (const { record, error } of result.failed) {
      lines.push(`    x ${(record && record.company) || 'unknown'} — ${error}`);
    }
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
  if (result.failed.length || result.collisions.length) return 1;
  return result.added.length || result.unchanged.length || result.removed.length ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`${err.stack || err.message}\n`); process.exitCode = 1; }
  );
}

export { main };
