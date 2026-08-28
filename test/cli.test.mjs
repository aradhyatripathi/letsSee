// The command-line tools, run the way a person runs them.
//
// This file exists because of a bug that survived a green suite. Five entry points
// decided whether they had been run directly by comparing import.meta.url against a
// string built as `file://` + process.argv[1] — never true on Windows, so main()
// never ran and `npm run workbook` exited 0 having produced nothing at all. No test
// caught it, and no test could have: every other test imports these modules and calls
// their exported functions, and none of them had ever been started as a process.
//
// So these spawn the real thing, with real arguments, and look at what comes back on
// stdout and what appears on disk. They are slower than an import and worth it: this
// is the only layer where "the program ran at all" is a claim under test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TyreCore } from '../pipeline/lib/core.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a repo script the way npm would, and hand back everything it did. */
function run(script, args = [], opts = {}) {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, script), ...args], {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...opts.env }
  });
  return {
    code: result.status,
    out: result.stdout || '',
    err: result.stderr || '',
    all: `${result.stdout || ''}${result.stderr || ''}`
  };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tyre-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One approved record, so the approved-only tools have something to work with. */
function approvedRecordsFile(dir, company = 'CEAT') {
  const rec = TyreCore.recToStoredShape({
    company,
    quarter: 'Q1 FY26',
    currency: { code: 'INR', unit: 'Crore', fx_to_inr: 1 },
    core: Object.fromEntries(TyreCore.CORE_KEYS.map((k, i) => [k, 100 + i])),
    core_quotes: Object.fromEntries(TyreCore.CORE_KEYS.map((k) => [k, 'Revenue from operations 100.00']))
  }, { source: 'fixture:q1-fy26/ceat.txt' });
  rec.review = { status: 'approved', reviewer: 'Test Reviewer', reviewed_at: '2026-08-25T09:00:00Z', note: null };
  rec.verification = { ok: true, checked: 21, verified: 21, failed: 0, unquoted: 0, checks: [] };

  const path = join(dir, 'records.json');
  writeFileSync(path, JSON.stringify({ records: [rec] }), 'utf8');
  return path;
}

// The bug in one assertion: a tool that runs must SAY something. A silent exit 0 is
// the exact signature of main() never having been reached.
const EVERY_CLI = [
  'pipeline/run.mjs',
  'pipeline/deck.mjs',
  'pipeline/workbook.mjs',
  'pipeline/archive.mjs',
  'scripts/sync-core.mjs',
  'scripts/pin-cdn.mjs',
  'scripts/demo.mjs',
  'scripts/serve.mjs'
];

test('every command-line tool actually runs when started as a process', () => {
  for (const script of EVERY_CLI) {
    // --help where there is one, --check where that is the read-only mode; serve and
    // demo would otherwise do real work, so they get the flag that makes them talk.
    const args = script === 'scripts/sync-core.mjs' || script === 'scripts/pin-cdn.mjs' ? ['--check'] : ['--help'];
    const { out, err, all } = run(script, args);
    assert.ok(
      all.trim().length > 0,
      `${script} produced no output at all — that is what a main() that never ran looks like`
    );
    void out; void err;
  }
});

test('the workbook tool writes a workbook', (t) => {
  const dir = tempDir(t);
  const records = approvedRecordsFile(dir);
  const out = join(dir, 'book.xlsx');

  const { code, all } = run('pipeline/workbook.mjs', [`--records=${records}`, `--out=${out}`]);
  assert.equal(code, 0, all);
  assert.ok(existsSync(out), 'no file was written');

  const bytes = readFileSync(out);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'not a ZIP, so not an xlsx');
  assert.match(all, /sheets/, 'the tool did not report what it produced');
});

test('the deck tool writes a deck', (t) => {
  const dir = tempDir(t);
  const records = approvedRecordsFile(dir);
  const out = join(dir, 'deck.pptx');

  const { code, all } = run('pipeline/deck.mjs', [`--records=${records}`, `--out=${out}`]);
  assert.equal(code, 0, all);
  assert.ok(existsSync(out), 'no file was written');
  assert.deepEqual([...readFileSync(out).subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.match(all, /slides/);
});

test('the archive tool archives, and says where', (t) => {
  const dir = tempDir(t);
  const records = approvedRecordsFile(dir);
  const archive = join(dir, 'archive');

  const { code, all } = run('pipeline/archive.mjs', [`--records=${records}`, `--dir=${archive}`]);
  assert.equal(code, 0, all);
  assert.match(all, /1 written/);
  assert.ok(existsSync(join(archive, 'q1-fy26', 'ceat.json')), 'the record is not on disk');
});

// A tool that refuses has to refuse out loud, with the flag that would change its
// mind. This is the demo's own next step, so a silent version would strand someone
// following the printed instructions.
test('an approved-only tool refuses unapproved records and names the way through', (t) => {
  const dir = tempDir(t);
  const records = approvedRecordsFile(dir);
  const pending = JSON.parse(readFileSync(records, 'utf8'));
  pending.records[0].review = { status: 'pending', reviewer: null, reviewed_at: null, note: null };
  const pendingPath = join(dir, 'pending.json');
  writeFileSync(pendingPath, JSON.stringify(pending), 'utf8');

  for (const script of ['pipeline/workbook.mjs', 'pipeline/deck.mjs']) {
    const out = join(dir, 'should-not-exist');
    const { code, all } = run(script, [`--records=${pendingPath}`, `--out=${out}`]);
    assert.equal(code, 1, `${script} should refuse`);
    assert.ok(!existsSync(out), `${script} wrote a file it said it would not`);
    assert.match(all, /not yet approved/, `${script} did not say why`);
    assert.match(all, /--include-pending/, `${script} did not name the flag that changes its mind`);
  }
});

// The demo is the first thing anyone runs and the thing a presentation is built on.
// It has to work from a clean checkout with no arguments, no key and no network.
test('the demo runs end to end and produces both artefacts', () => {
  // The demo writes into the repo's own gitignored demo-output/, which is the point:
  // it is the folder the printed next steps tell the reader to look in.
  const { code, all } = run('scripts/demo.mjs');
  assert.equal(code, 0, all);

  // It says what it did, in the order it did it.
  for (const marker of [/records/i, /pptx/i, /xlsx/i]) {
    assert.match(all, marker, 'the demo did not mention one of its own outputs');
  }
});
