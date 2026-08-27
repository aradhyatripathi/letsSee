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
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TyreCore } from './lib/core.mjs';
import { approvalSourceNote } from './lib/report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A path as the reader should see it: relative to the repo when it is inside it,
// absolute when it is not.
//
// This used to be `path.replace(`${REPO_ROOT}/`, '')`, which is a string operation
// pretending to be a path one. On Windows the separators do not match, so nothing is
// stripped and the full path is printed instead — including the user's name and home
// directory, on screen, in front of whoever they are demonstrating this to. The same
// leak was fixed in what records store; this is the version that reaches the terminal.
function shortPath(path) {
  const rel = relative(REPO_ROOT, path);
  return rel && !rel.startsWith('..') ? rel : path;
}
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

// How deep a record may nest before we stop calling it a record.
//
// A real one is four levels at most (record.segments.channels.replacement). The
// cap exists because this walk used to recurse, and a records file carrying a
// 20,000-deep object overflowed the stack — which mattered far more than it
// sounds: the throw escaped the per-record try/catch, so the whole pass stopped
// at that record. Every record after it went unprocessed, including the rejection
// branch that removes an archived copy, so a record someone had rejected stayed
// in the archive and kept being exported under a line saying everything in the
// file had been checked. V8 parses that depth happily and only detonates here.
const MAX_RECORD_DEPTH = 64;

/**
 * The longest string anywhere in a record, and where it was.
 *
 * Iterative with an explicit stack, and it reports excessive depth rather than
 * dying of it: a structure this deep is malformed, and saying so is the answer.
 */
/**
 * What limit applies to the string at this path.
 *
 * A quote is a span of a filing, and verification already says how long a span may
 * be — so the archive uses the same number rather than a second, looser one. That
 * matters because the old rule was 2,000 for everything: split a filing across the
 * twenty-one quote fields at 1,999 characters each and every field passed, which
 * put the document into the archive after all.
 */
function limitFor(path) {
  if (/^quotes\./.test(path)) return TyreCore.MAX_QUOTE_CHARS;
  if (/^verification\.checks\.\d+\.quote$/.test(path)) return TyreCore.MAX_QUOTE_CHARS;
  return MAX_STRING_CHARS;
}

/**
 * Every string in a record, measured against what that field is for.
 *
 * Iterative with a depth cap, and it reports excessive depth rather than dying of
 * it: a structure this deep is malformed, and saying so is the answer.
 *
 * It reports the total as well as the worst offender. Bounding only the longest
 * string is not a bound on the document: the check passed a record carrying a whole
 * filing spread evenly across its fields, because no single field was long.
 */
function measureStrings(record) {
  const result = { longest: { len: 0, path: null }, total: 0, tooDeep: false, over: [] };
  const stack = [[record, '', 0]];
  while (stack.length) {
    const [node, path, depth] = stack.pop();
    if (typeof node === 'string') {
      const where = path || '(root)';
      result.total += node.length;
      if (node.length > result.longest.len) result.longest = { len: node.length, path: where };
      const limit = limitFor(where);
      if (node.length > limit) result.over.push({ path: where, len: node.length, limit });
    } else if (node && typeof node === 'object') {
      if (depth >= MAX_RECORD_DEPTH) { result.tooDeep = true; continue; }
      for (const [k, v] of Object.entries(node)) stack.push([v, path ? `${path}.${k}` : k, depth + 1]);
    }
  }
  return result;
}

// What an archived record is allowed to be made of. Boundary 2 turns on the archive
// holding reviewed output and nothing else, and an unknown key is the easiest place
// to put something else: a record with the retrieved filing hung off a
// `filing_pages` object passed every check there was, because every check looked
// only at the keys it knew about.
const ARCHIVE_KEYS = new Set([
  'id', 'company', 'quarter', 'source', 'retrieved_at',
  'currency', 'core', 'quotes', 'segments', 'outlook', 'review', 'verification'
]);

// All the text in one record, added up. Twenty-one quotes at their own limit plus
// three outlook paragraphs comes to roughly 20,000; this leaves room above that and
// is still an order of magnitude below any filing.
const MAX_RECORD_TEXT_CHARS = 32000;

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
      // Anything this check throws on is a problem with that file, reported as one.
      // A throw here used to escape readArchive entirely, so a single bad file in the
      // archive directory bricked --list and --export — the precise opposite of this
      // function's contract, which is that a file that is not an approved, well-formed
      // record is reported rather than returned.
      let reason;
      try {
        reason = archiveRejectionReason(parsed);
      } catch (err) {
        reason = `could not be checked — ${err.message}`;
      }
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

  // Depth first: it is the one that used to throw rather than return, so it is the
  // one whose reason a reader most needs to see.
  const text = measureStrings(record);
  if (text.tooDeep) {
    return `it nests more than ${MAX_RECORD_DEPTH} levels deep — a record is four at most, so this is not one`;
  }

  const extra = Object.keys(record).filter((k) => !ARCHIVE_KEYS.has(k));
  if (extra.length) {
    return `it carries ${extra.map((k) => JSON.stringify(k)).join(', ')}, which ${extra.length === 1 ? 'is not a field' : 'are not fields'} of a record — the archive keeps reviewed records, not documents attached to them`;
  }

  if (text.over.length) {
    const worst = text.over.sort((a, b) => b.len - a.len)[0];
    return `${worst.path} holds ${worst.len.toLocaleString('en-US')} characters — that is a document, not a quote (limit ${worst.limit})`;
  }
  if (text.total > MAX_RECORD_TEXT_CHARS) {
    return `its text comes to ${text.total.toLocaleString('en-US')} characters across ${Object.keys(record).length} fields — a filing spread thin is still a filing (limit ${MAX_RECORD_TEXT_CHARS})`;
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

    // From here on, everything about this one record is inside a try. The comment on
    // the write below says one bad record must not abort the loop; it was true of the
    // write and not of the checks, and a record that threw during a check stopped the
    // pass — silently, because the summary is printed after the loop.

    // A record approved and archived, then rejected on re-review, used to stay in the
    // archive and keep being exported while the run printed a line implying the
    // rejection had taken effect. A rejection now takes the archived copy out, which is
    // the only reading of "reviewed output" that survives someone changing their mind.
    try {
      if (TyreCore.isRejected(record)) {
        if (!existsSync(path)) {
          result.skipped.push({ record, reason: 'rejected' });
          continue;
        }
        // A rejection deletes a file, so it has to prove it is about that file.
        //
        // The path is a slug of company and quarter, and slugging is lossy:
        // "APOLLO   TYRES!!" / "q4  fy25" resolves to apollo-tyres.json under
        // q4-fy25 just as "Apollo Tyres" / "Q4 FY25" does. The add branch has
        // guarded against that collision from the start; this branch did not, so
        // a stub carrying nothing but a company, a quarter and the word rejected
        // removed a reviewed record belonging to someone else — and exited 0.
        //
        // The occupant's own company name is the identity that matters, not the
        // filename it happens to live under.
        let occupant;
        try {
          occupant = JSON.parse(await readFile(path, 'utf8'));
        } catch (err) {
          result.failed.push({ record, path, error: `cannot read the archived record to check it — ${err.message}` });
          continue;
        }
        if (String(occupant.company || '') !== String(record.company || '')) {
          result.collisions.push({ record, path, occupant: occupant.company || '(unnamed)', action: 'remove' });
          continue;
        }
        await rm(path);
        result.removed.push({ record, path });
        continue;
      }

      const reason = archiveRejectionReason(record);
      if (reason) {
        result.skipped.push({ record, reason });
        continue;
      }

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
      // never archived and no summary was printed at all. The same is now true of a
      // record that throws while being checked rather than while being written.
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
        process.stdout.write(`    ! ${shortPath(p.path)} — ${p.reason}\n`);
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
    lines.push(`    + ${record.company} ${record.quarter} -> ${shortPath(path)}`);
  }
  for (const { record, path } of result.removed) {
    lines.push(`    - ${record.company} ${record.quarter} — rejected on re-review, taken out of ${shortPath(path)}`);
  }
  if (result.collisions.length) {
    lines.push('');
    lines.push(`  ${result.collisions.length} name collision${result.collisions.length === 1 ? '' : 's'} — nothing was overwritten or deleted:`);
    for (const { record, path, occupant, action } of result.collisions) {
      const verb = action === 'remove' ? 'would delete' : 'would land on';
      lines.push(`    ! ${record.company} ${verb} ${shortPath(path)}, which holds ${occupant}`);
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
      lines.push(`    ! ${record.company} ${record.quarter} — ${shortPath(path)}`);
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
    // The archive is the one thing that outlives a run, and it takes approved records
    // only — so this is the loudest place to say what that approval rests on.
    lines.push(approvalSourceNote(result.added.length + result.unchanged.length, recordsPath).trimEnd());
    lines.push('  Commit the archive to keep the history. Nothing here is written unattended.');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (result.failed.length || result.collisions.length) return 1;
  return result.added.length || result.unchanged.length || result.removed.length ? 0 : 1;
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
