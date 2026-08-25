// The three routes that work without an API key.
//
// The key arrives only if the project is approved, so every claim made before
// approval has to be demonstrable without one. These are the routes that make
// that possible, and the property each of them must not lose:
//
//   --retrieve-only   answers "does this source hand over a filing" and stops
//                     before extraction, producing no records at all.
//   --emit-prompt     writes exactly what would have been sent, and sends nothing.
//   --response        reads an answer a person carried back by hand and puts it
//                     through the same verification an API answer goes through.
//
// The last one is the one worth being careful about: carrying the answer by hand
// must not become a way around the quote gate. The adversarial cases below are
// the point of this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { COMPANY_IDS } from '../pipeline/config/companies.mjs';
import { extractRecordFromResponse, extractRecordOffline } from '../pipeline/lib/extract.mjs';
import { fixturePath } from '../pipeline/fixtures/index.mjs';

const run = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'pipeline/run.mjs');

const OFFLINE_ENV = { ...process.env };
delete OFFLINE_ENV.ANTHROPIC_API_KEY;
delete OFFLINE_ENV.FIRECRAWL_API_KEY;

// Whichever company is listed first — nothing here should depend on which.
const SUBJECT = COMPANY_IDS[0];

async function runCli(args, cwd) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd, env: OFFLINE_ENV });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

/** A model answer in the schema the prompt asks for, derived from the fixture. */
async function genuineAnswer(id = SUBJECT) {
  const sourceText = await readFile(fixturePath(id), 'utf8');
  const offline = await extractRecordOffline({ sourceText, company: id, quarter: 'Q1 FY26' });
  assert.ok(offline.ok, 'the fixture extracts cleanly to begin with');
  return { sourceText, answer: JSON.parse(offline.raw) };
}

/* ------------------------------------------------- extractRecordFromResponse -- */

test('a pasted answer is verified against the source and accepted when it holds up', async () => {
  const { sourceText, answer } = await genuineAnswer();
  const result = extractRecordFromResponse({
    sourceText,
    responseText: JSON.stringify(answer),
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });

  assert.ok(result.ok, result.error || 'expected the answer to be accepted');
  assert.ok(result.verification.checked > 0, 'quotes were actually checked, not waved through');
  assert.equal(result.verification.failed, 0);
  assert.equal(result.extractor, 'claude-manual', 'the record says it was carried, not called');
  assert.equal(result.record.verification.extractor, 'claude-manual');
});

test('a fabricated quote is rejected on the way back in, exactly as on a live run', async () => {
  const { sourceText, answer } = await genuineAnswer();
  answer.core_quotes.revenue =
    'Revenue from operations for the quarter stood at INR 9,999.99 crore, a record for the company.';
  answer.core.revenue = 9999.99;

  const result = extractRecordFromResponse({
    sourceText,
    responseText: JSON.stringify(answer),
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });

  assert.equal(result.ok, false, 'a quote that is not in the filing must not be storable by hand');
  assert.match(result.error, /revenue/);
  assert.ok(
    result.verification.checks.some((c) => c.key === 'revenue' && c.status === 'not_found'),
    'the failure names the field and why'
  );
});

test('a real quote carrying a figure that is not in it is rejected too', async () => {
  const { sourceText, answer } = await genuineAnswer();
  // The quote stays word-for-word from the filing; only the figure is swapped, which
  // is the comparative-column mistake the value check exists for.
  answer.core.revenue = Number(answer.core.revenue) + 1234.5;

  const result = extractRecordFromResponse({
    sourceText,
    responseText: JSON.stringify(answer),
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });

  assert.equal(result.ok, false, 'a genuine quote must not launder a figure it does not contain');
  assert.ok(
    result.verification.checks.some((c) => c.key === 'revenue' && c.status === 'value_not_in_quote'),
    'the status names the likely cause rather than just failing'
  );
});

test('a fenced answer with chat chatter around it is still read', async () => {
  const { sourceText, answer } = await genuineAnswer();
  const responseText = [
    "Here's the extraction for that filing:",
    '',
    '```json',
    JSON.stringify(answer, null, 2),
    '```',
    '',
    'Let me know if you want the segment breakdown expanded.'
  ].join('\n');

  const result = extractRecordFromResponse({
    sourceText,
    responseText,
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });
  assert.ok(result.ok, result.error || 'a pasted chat answer is the expected input shape');
});

test('an unreadable or empty answer fails with an instruction, not a stack trace', async () => {
  const { sourceText } = await genuineAnswer();

  const empty = extractRecordFromResponse({ sourceText, responseText: '   ', company: 'A', quarter: 'Q1 FY26' });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/i);

  const prose = extractRecordFromResponse({
    sourceText,
    responseText: 'I was unable to find the financial statements in that document.',
    company: 'A',
    quarter: 'Q1 FY26'
  });
  assert.equal(prose.ok, false);
  assert.match(prose.error, /JSON/i);
  assert.equal(prose.record, null);
});

test('a response with no source text to check against is refused', () => {
  const result = extractRecordFromResponse({
    sourceText: '',
    responseText: '{"company":"A"}',
    company: 'A',
    quarter: 'Q1 FY26'
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no source text/i);
});

/* --------------------------------------------------------------------- cli -- */

test('--retrieve-only stops after Stage 1 and produces no records', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-retrieve-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli(
    ['--retrieve-only', `--companies=${SUBJECT}`, '--out=records.json'],
    workDir
  );

  assert.equal(code, 0, `exit ${code}\n${stderr}`);
  assert.match(stdout, /Stage 1 only/);
  assert.match(stderr, /extraction: skipped/);

  const payload = JSON.parse(await readFile(join(workDir, 'records.json'), 'utf8'));
  t.after(() => rm(join(REPO_ROOT, 'runs', payload.run_id), { recursive: true, force: true }));
  assert.deepEqual(payload.records, [], 'a retrieval check must not produce records');
  assert.equal(payload.extractor, 'stopped-after-retrieval');
  assert.equal(payload.model, null, 'no model was involved, so none is claimed');
});

test('--emit-prompt writes the prompt and the command to carry the answer back', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-prompt-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli(
    ['--emit-prompt', `--companies=${SUBJECT}`, '--out=records.json'],
    workDir
  );
  assert.equal(code, 0, `exit ${code}\n${stderr}`);

  const payload = JSON.parse(await readFile(join(workDir, 'records.json'), 'utf8'));
  const runDir = join(REPO_ROOT, 'runs', payload.run_id);
  t.after(() => rm(runDir, { recursive: true, force: true }));

  assert.deepEqual(payload.records, [], 'writing a prompt must not produce a record');

  const promptPath = join(runDir, 'prompts', `${SUBJECT}.txt`);
  assert.ok(existsSync(promptPath), 'the prompt is on disk');
  const prompt = await readFile(promptPath, 'utf8');
  assert.match(prompt, /Never fabricate a quote/, 'the guardrails travel with it');
  assert.match(prompt, /INSTRUCTIONS \(system prompt\)/);
  assert.match(prompt, /FILING \(user message\)/);

  const readme = await readFile(join(runDir, 'prompts', 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`--response=${SUBJECT}:`), 'the way back is written down');
  assert.match(readme, /--file=/, 'and it names the exact text the answer will be checked against');
  assert.match(stdout, /prompts written, no model called/);
});

test('a carried answer completes the round trip through the CLI', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-roundtrip-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const { answer } = await genuineAnswer();
  const answerPath = join(workDir, 'answer.json');
  await writeFile(answerPath, `\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\`\n`, 'utf8');

  const { code, stderr } = await runCli(
    [
      `--companies=${SUBJECT}`,
      `--file=${SUBJECT}:${fixturePath(SUBJECT)}`,
      `--response=${SUBJECT}:${answerPath}`,
      '--out=records.json'
    ],
    workDir
  );
  assert.equal(code, 0, `exit ${code}\n${stderr}`);

  const payload = JSON.parse(await readFile(join(workDir, 'records.json'), 'utf8'));
  t.after(() => rm(join(REPO_ROOT, 'runs', payload.run_id), { recursive: true, force: true }));

  assert.equal(payload.records.length, 1);
  assert.equal(payload.extractor, 'manual');
  const record = payload.records[0];
  assert.equal(record.verification.extractor, 'claude-manual');
  assert.equal(record.verification.failed, 0);
  assert.equal(record.review.status, 'pending', 'a carried answer is still only a candidate');
});

test('a carried answer with a fabricated quote fails the run and stores nothing', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-roundtrip-bad-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const { answer } = await genuineAnswer();
  answer.core_quotes.pat = 'Profit after tax rose to INR 4,242.42 crore on the back of a one-time gain.';
  answer.core.pat = 4242.42;
  const answerPath = join(workDir, 'answer.json');
  await writeFile(answerPath, JSON.stringify(answer), 'utf8');

  const { code, stdout } = await runCli(
    [
      `--companies=${SUBJECT}`,
      `--file=${SUBJECT}:${fixturePath(SUBJECT)}`,
      `--response=${SUBJECT}:${answerPath}`,
      '--out=records.json'
    ],
    workDir
  );

  assert.equal(code, 1, 'a run that stored nothing must not report success');
  assert.match(stdout, /0 of 1 companies produced a record/);

  const payload = JSON.parse(await readFile(join(workDir, 'records.json'), 'utf8'));
  t.after(() => rm(join(REPO_ROOT, 'runs', payload.run_id), { recursive: true, force: true }));
  assert.deepEqual(payload.records, [], 'nothing unverified reaches records.json');
});

test('the key-free routes are refused in combination rather than silently ignored', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-guards-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const both = await runCli(['--retrieve-only', '--emit-prompt'], workDir);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /pick one/);

  const promptAndResponse = await runCli(['--emit-prompt', `--response=${SUBJECT}:x.json`], workDir);
  assert.equal(promptAndResponse.code, 1);
  assert.match(promptAndResponse.stderr, /two commands/);

  const retrieveAndResponse = await runCli(['--retrieve-only', `--response=${SUBJECT}:x.json`], workDir);
  assert.equal(retrieveAndResponse.code, 1);
  assert.match(retrieveAndResponse.stderr, /stops before extraction/);
});

test('live mode without a key names the key-free routes instead of just refusing', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-livekey-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const { code, stderr } = await runCli(['--mode=live', `--companies=${SUBJECT}`], workDir);
  assert.equal(code, 1);
  assert.match(stderr, /--retrieve-only/);
  assert.match(stderr, /--emit-prompt/);
  assert.match(stderr, /--response=/);
});

/* ------------------------------------------ regressions from the review pass -- */

test('an answer for the wrong company is refused, not verified against the wrong filing', async () => {
  const sourceText = await readFile(fixturePath(SUBJECT), 'utf8');
  const { answer } = await genuineAnswer();
  answer.company = 'Some Other Tyre Company';

  const result = extractRecordFromResponse({
    sourceText,
    responseText: JSON.stringify(answer),
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });

  assert.equal(result.ok, false, 'carrying answers by hand means carrying them to the wrong place');
  assert.match(result.error, /answer is for/);
  assert.equal(result.record, null);
});

test('a tidier spelling of the same company is not a mismatch', async () => {
  const sourceText = await readFile(fixturePath(SUBJECT), 'utf8');
  const { answer } = await genuineAnswer();
  answer.company = 'Apollo Tyres Limited';

  const result = extractRecordFromResponse({
    sourceText,
    responseText: JSON.stringify(answer),
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });
  assert.ok(result.ok, result.error || 'the prompt invites the model to correct the name it was given');
});

test('an answer for the wrong quarter is refused', async () => {
  const sourceText = await readFile(fixturePath(SUBJECT), 'utf8');
  const { answer } = await genuineAnswer();
  answer.quarter = 'Q3 FY24';

  const result = extractRecordFromResponse({
    sourceText,
    responseText: JSON.stringify(answer),
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Q3 FY24/);
});

test('a figure with no quote at all fails the carried route too', async () => {
  const sourceText = await readFile(fixturePath(SUBJECT), 'utf8');
  const { answer } = await genuineAnswer();
  answer.core_quotes = {};   // twenty-one figures, no quotes anywhere

  const result = extractRecordFromResponse({
    sourceText,
    responseText: JSON.stringify(answer),
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });
  assert.equal(result.ok, false, 'unsupported figures must not be storable');
  assert.match(result.error, /no quote at all/i);
});

test('the failure names the real reason, and carries the correction to send back', async () => {
  const sourceText = await readFile(fixturePath(SUBJECT), 'utf8');
  const { answer } = await genuineAnswer();
  answer.core.revenue = Number(answer.core.revenue) + 1234.5;   // quote is real, figure is not

  const result = extractRecordFromResponse({
    sourceText,
    responseText: JSON.stringify(answer),
    company: 'Apollo Tyres',
    quarter: 'Q1 FY26'
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not contain that figure/i,
    '"quotes not found in the source" sent the reader looking for the wrong problem');
  assert.match(result.error, /CORRECTION/, 'the correction text is in the error, not somewhere the report never printed');
});

test('the same company named twice on the command line is an error, not a silent pick', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-dupe-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const dupe = await runCli([`--companies=${SUBJECT}`, `--response=${SUBJECT}:a.json`, `--response=${SUBJECT}:b.json`], workDir);
  assert.equal(dupe.code, 1);
  assert.match(dupe.stderr, /given twice/);

  const dupeFile = await runCli([`--companies=${SUBJECT}`, `--file=${SUBJECT}:a.txt`, `--file=${SUBJECT}:b.txt`], workDir);
  assert.equal(dupeFile.code, 1);
  assert.match(dupeFile.stderr, /given twice/);
});

test('a carried run is not reported as the offline extractor', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'tyre-label-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const { answer } = await genuineAnswer();
  const answerPath = join(workDir, 'answer.json');
  await writeFile(answerPath, JSON.stringify(answer), 'utf8');

  const { code, stdout } = await runCli([
    `--companies=${SUBJECT}`,
    `--file=${SUBJECT}:${fixturePath(SUBJECT)}`,
    `--response=${SUBJECT}:${answerPath}`,
    '--out=records.json'
  ], workDir);
  assert.equal(code, 0);
  assert.match(stdout, /by hand/, 'provenance is the thing a reader of this report most needs right');
  assert.doesNotMatch(stdout, /deterministic offline extractor/);

  const payload = JSON.parse(await readFile(join(workDir, 'records.json'), 'utf8'));
  t.after(() => rm(join(REPO_ROOT, 'runs', payload.run_id), { recursive: true, force: true }));
});
