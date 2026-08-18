// The manual trigger, end to end (build spec, Section 8).
//
// One press, all nine companies, fully offline, no API key: records.json in the
// documented shape plus the written report, and exit code 0.
//
// The run is invoked from a temporary working directory and everything it wrote
// is removed afterwards, including the run directory it opened under runs/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { COMPANIES } from '../pipeline/config/companies.mjs';
import { TyreCore } from '../pipeline/lib/core.mjs';

const run = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'pipeline/run.mjs');

// No key and no Firecrawl key: this must be the path a reviewer gets on a laptop
// with nothing configured.
const OFFLINE_ENV = { ...process.env };
delete OFFLINE_ENV.ANTHROPIC_API_KEY;
delete OFFLINE_ENV.FIRECRAWL_API_KEY;

async function runCli(args, cwd) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd, env: OFFLINE_ENV });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('a full offline run over the whole roster writes records and a report', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-run-'));
  const recordsPath = join(workDir, 'records.json');
  let runDir = null;
  t.after(async () => {
    await rm(workDir, { recursive: true, force: true });
    if (runDir) await rm(runDir, { recursive: true, force: true });
  });

  const { code, stdout, stderr } = await runCli(['--quarter=Q1 FY26', '--out=records.json'], workDir);

  assert.equal(code, 0, `exit ${code}\n${stderr}`);
  assert.ok(existsSync(recordsPath), 'records.json landed where --out asked for it');

  const payload = JSON.parse(await readFile(recordsPath, 'utf8'));
  runDir = join(REPO_ROOT, 'runs', payload.run_id);

  assert.deepEqual(Object.keys(payload).sort(), [
    'extractor', 'generated_at', 'mode', 'model', 'quarter', 'records', 'run_id'
  ]);
  assert.equal(payload.quarter, 'Q1 FY26');
  assert.equal(payload.mode, 'fixture');
  assert.equal(payload.extractor, 'offline');
  assert.equal(payload.model, null, 'no model is named when no model was called');
  assert.ok(!Number.isNaN(Date.parse(payload.generated_at)));

  assert.equal(payload.records.length, COMPANIES.length, 'a record per company');
  assert.deepEqual(
    payload.records.map((r) => r.company).sort(),
    COMPANIES.map((c) => c.name).sort()
  );

  const ids = new Set();
  for (const record of payload.records) {
    assert.deepEqual(TyreCore.validateStored(record), [], `${record.company} is not well-formed`);
    assert.equal(record.quarter, 'Q1 FY26');
    assert.ok(record.source.startsWith('fixture:'), `${record.company}: ${record.source}`);
    assert.ok(!Number.isNaN(Date.parse(record.retrieved_at)));

    assert.equal(record.review.status, 'pending', 'nothing is accepted without a human');
    assert.equal(record.review.reviewer, null);

    assert.deepEqual(Object.keys(record.core), TyreCore.CORE_KEYS);
    assert.deepEqual(Object.keys(record.quotes), TyreCore.CORE_KEYS);
    assert.deepEqual(Object.keys(record.segments.channels), TyreCore.CHANNEL_KEYS);
    assert.deepEqual(Object.keys(record.segments.product_categories), TyreCore.PRODUCT_KEYS);
    assert.deepEqual(Object.keys(record.outlook), TyreCore.OUTLOOK_KEYS);

    assert.equal(record.verification.ok, true, `${record.company}: quotes did not verify`);
    assert.equal(record.verification.failed, 0);
    assert.ok(record.verification.verified > 0);

    assert.ok(TyreCore.isNum(record.core.revenue), `${record.company}: no revenue extracted`);
    assert.equal(record.currency.fx_to_inr, TyreCore.FX_TO_INR[record.currency.code]);

    assert.ok(!ids.has(record.id), `duplicate record id ${record.id}`);
    ids.add(record.id);
  }

  // Currency is read off each filing, never assumed. This holds for any roster:
  // every record must carry the basis its own filing stated, with the fx rate the
  // shared contract defines for that currency.
  const byCompany = new Map(payload.records.map((r) => [r.company, r]));
  for (const record of payload.records) {
    assert.ok(record.currency.code, `${record.company}: currency code must be read from the filing`);
    assert.ok(record.currency.unit, `${record.company}: currency unit must be read from the filing`);
    assert.equal(
      record.currency.fx_to_inr,
      TyreCore.fxToInr(record.currency.code),
      `${record.company}: fx must come from the contract's table, not be invented`
    );
  }

  // Goodyear India reports to its parent in USD Million, so while it is on the
  // roster it is the case that proves a non-INR basis survives the run intact
  // rather than being quietly normalised to rupees. Guarded, so trimming the
  // roster changes coverage without breaking the build.
  const KNOWN_BASIS = {
    'Goodyear India': { code: 'USD', unit: 'Million', fx_to_inr: 83 },
    'Apollo Tyres': { code: 'INR', unit: 'Crore', fx_to_inr: 1 }
  };
  for (const [name, currency] of Object.entries(KNOWN_BASIS)) {
    const record = byCompany.get(name);
    if (record) assert.deepEqual(record.currency, currency, `${name}: reported basis`);
  }

  // Every stored quote is genuinely in the filing text this run retrieved.
  for (const record of payload.records) {
    const company = COMPANIES.find((c) => c.name === record.company);
    const sourceText = await readFile(join(runDir, 'sources', `${company.id}.txt`), 'utf8');
    for (const key of TyreCore.CORE_KEYS) {
      const quote = record.quotes[key];
      if (quote) assert.ok(sourceText.includes(quote), `${record.company}.${key}: quote is not in the retrieved text`);
    }
  }

  const report = await readFile(join(runDir, 'report.md'), 'utf8');
  assert.ok(report.startsWith(`# Tyre pipeline run — ${payload.run_id}`));
  assert.ok(report.includes('PENDING REVIEW'), 'the report says outright that nothing is trusted yet');
  assert.ok(report.includes(`${COMPANIES.length} of ${COMPANIES.length}** companies produced a record`));
  assert.ok(report.includes('No company failed.'));
  for (const company of COMPANIES) {
    assert.ok(report.includes(company.name), `${company.name} is missing from the report`);
  }

  assert.ok(stdout.includes(`${COMPANIES.length} of ${COMPANIES.length} companies produced a record`), stdout);
  assert.ok(stdout.includes(recordsPath), 'the operator is told where the records went');
  assert.ok(stdout.includes(TyreCore.STORAGE_KEY), 'and how to get them into the dashboard');
  assert.ok(stderr.includes('no ANTHROPIC_API_KEY set'), 'the offline fallback is stated, not silent');
});

test('a subset run touches only the companies asked for', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-run-'));
  let runDir = null;
  t.after(async () => {
    await rm(workDir, { recursive: true, force: true });
    if (runDir) await rm(runDir, { recursive: true, force: true });
  });

  // Taken from the roster rather than named, so this keeps testing the subset
  // behaviour whatever the roster happens to contain.
  const [first, second, ...rest] = COMPANIES;
  const asked = [first, second];

  const { code } = await runCli([`--companies=${asked.map((c) => c.id).join(',')}`, '--out=subset.json'], workDir);
  assert.equal(code, 0);

  const payload = JSON.parse(await readFile(join(workDir, 'subset.json'), 'utf8'));
  runDir = join(REPO_ROOT, 'runs', payload.run_id);

  assert.deepEqual(payload.records.map((r) => r.company), asked.map((c) => c.name));
  for (const skipped of rest) {
    assert.ok(
      !existsSync(join(runDir, 'sources', `${skipped.id}.txt`)),
      `no filing should have been retrieved for ${skipped.name}, which was not asked for`
    );
  }
});

test('bad arguments fail before any work is done', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-run-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const unknownCompany = await runCli(['--companies=pirelli'], workDir);
  assert.equal(unknownCompany.code, 1);
  assert.match(unknownCompany.stderr, /unknown company: pirelli/);

  const badMode = await runCli(['--mode=staging'], workDir);
  assert.equal(badMode.code, 1);
  assert.match(badMode.stderr, /--mode must be 'fixture' or 'live'/);

  const badFile = await runCli(['--file=apollo'], workDir);
  assert.equal(badFile.code, 1);
  assert.match(badFile.stderr, /--file expects <company-id>:<path>/);

  const liveWithoutKey = await runCli(['--mode=live', '--companies=apollo'], workDir);
  assert.equal(liveWithoutKey.code, 1);
  assert.match(liveWithoutKey.stderr, /live mode needs an API key/);

  const help = await runCli(['--help'], workDir);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Tyre intelligence pipeline — manual run/);
});
