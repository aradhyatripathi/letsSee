// Guards on the dashboard source itself.
//
// The dashboard is one HTML file with no build step, so its behaviour cannot be imported
// and unit-tested the way the pipeline can, and driving it needs a browser this repo
// deliberately does not depend on — the whole suite has to run anywhere with nothing
// installed. What can be checked here is that the specific mistakes a review found are
// not present in the source any more.
//
// Pattern assertions are usually a poor substitute for behavioural ones. These earn their
// place because each corresponds to a defect that was demonstrated in a real browser, and
// each would be reintroduced by an ordinary-looking edit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(REPO_ROOT, 'dashboard/tyre_comparison_dashboard.html'), 'utf8');

// Everything outside the two inlined shared blocks — the dashboard's own code.
function dashboardOnly() {
  return HTML.replace(/\/\* ==== TYRE-(?:CORE|DECK):BEGIN ====[\s\S]*?TYRE-(?:CORE|DECK):END ==== \*\//g, '');
}

test('no inline handler is ever built out of data', () => {
  // A crafted id in an imported file executed the moment the list rendered, which was
  // enough to approve records a reviewer had rejected.
  //
  // Static onclick attributes in the page's own markup are fine — their arguments are
  // literals written here. What is not fine is an onclick assembled by string
  // concatenation, because whatever is concatenated in came from somewhere else.
  const offenders = dashboardOnly()
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /onclick\s*=/.test(line) && /['"]\s*\+|\+\s*['"]/.test(line));

  assert.deepEqual(
    offenders.map((o) => `line ${o.n}: ${o.line.slice(0, 90)}`),
    [],
    'an onclick built by concatenation runs whatever was concatenated into it'
  );
  assert.match(dashboardOnly(), /data-act=/, 'the delegated-listener pattern is what replaced them');
  assert.match(dashboardOnly(), /escAttr\(r\.id\)/, 'and ids reach the DOM escaped');
});

test('every data-id attribute is escaped', () => {
  const raw = dashboardOnly().match(/data-id="'\s*\+\s*([A-Za-z0-9_.]+)/g) || [];
  for (const hit of raw) {
    assert.match(hit, /escAttr/, `unescaped data-id: ${hit}`);
  }
});

test('an imported file cannot approve anything', () => {
  const source = dashboardOnly();
  // The old rule vouched for an incoming approval when content matched a local record.
  // That proves the figures match, not who decided.
  assert.doesNotMatch(source, /const vouched\s*=/, 'the content-only vouching rule is gone');
  assert.match(source, /can never approve anything/i, 'and the replacement says what it does');
  assert.match(source, /status: 'rejected'/, 'a rejection in the file is still honoured');
});

test('currency is validated before anything fills it in', () => {
  const source = dashboardOnly();
  // The position that matters is where the check is ACTED ON, not where its message is
  // written — moving only the guard past the normaliser is exactly the regression, and
  // comparing the message's position would not notice.
  const guardAt = source.indexOf('if (currencyErrs.length)');
  const ensureAt = source.indexOf('ensureCoreShape(inc); ensureCurrency(inc); ensureQuotes(inc);');
  assert.ok(guardAt !== -1, 'the currency guard exists');
  assert.ok(ensureAt !== -1, 'the normalisation step exists');
  assert.ok(
    guardAt < ensureAt,
    'the guard has to return before ensureCurrency runs, or it is checking a currency that was just invented'
  );
});

test('deltas are not computed against rejected records', () => {
  const source = dashboardOnly();
  assert.match(source, /function activeRecords\(\)/);
  const calls = source.match(/computeDeltas\(([^)]*)\)/g) || [];
  const callsOnRawRecords = calls.filter((c) => /computeDeltas\(records\)/.test(c));
  assert.deepEqual(callsOnRawRecords, [], 'a growth number computed against a rejected figure is a wrong growth number');
});

test('both exports go through the shared model, not their own filtering', () => {
  const source = dashboardOnly();
  assert.match(source, /Core\.buildWorkbookModel\(records,/);
  assert.match(source, /Core\.buildDeckModel\(records,/);
  assert.match(source, /TyreDeck\.writePptx\(model\)/);
});

test('the inlined shared blocks are present and are the only copies', () => {
  for (const marker of ['TYRE-CORE', 'TYRE-DECK']) {
    assert.equal((HTML.match(new RegExp(`${marker}:BEGIN`, 'g')) || []).length, 1, `${marker} appears once`);
    assert.equal((HTML.match(new RegExp(`${marker}:END`, 'g')) || []).length, 1);
  }
  assert.doesNotMatch(dashboardOnly(), /function verifyQuotes/, 'the dashboard must not carry its own verifier');
});
