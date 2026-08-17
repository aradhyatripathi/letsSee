// The guard that stops the two halves of the contract drifting.
//
// pipeline/lib/core-source.js is inlined verbatim into the single-file dashboard
// between the TYRE-CORE markers. If someone edits one copy and not the other, the
// dashboard and the pipeline stop agreeing about the schema, the stored shape and
// the quote threshold — silently, and only in the browser. This test fails first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractCoreBlock } from '../scripts/sync-core.mjs';
import { CORE_SOURCE, CORE_SOURCE_PATH, TyreCore } from '../pipeline/lib/core.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_PATH = join(REPO_ROOT, 'dashboard/tyre_comparison_dashboard.html');

test('the dashboard inlines the core byte-identically', () => {
  const canonical = extractCoreBlock(CORE_SOURCE);
  const inlined = extractCoreBlock(readFileSync(DASHBOARD_PATH, 'utf8'));

  assert.equal(
    inlined,
    canonical,
    `the TYRE-CORE block in ${DASHBOARD_PATH} has drifted from ${CORE_SOURCE_PATH} — run \`npm run sync:core\``
  );
});

test('extractCoreBlock refuses a file without the markers', () => {
  assert.throws(() => extractCoreBlock('<html><body>no core here</body></html>'), /TYRE-CORE:BEGIN\/END markers/);
});

test('the dashboard gets the core through the same object the pipeline does', () => {
  const html = readFileSync(DASHBOARD_PATH, 'utf8');
  const inlined = extractCoreBlock(html);
  const outsideTheBlock = html.replace(inlined, '');

  assert.ok(inlined.includes('window.TyreCore = TyreCore'), 'the block publishes TyreCore to the page');
  assert.ok(
    !outsideTheBlock.includes(TyreCore.STORAGE_KEY),
    `the dashboard should read the storage key off the core object, not keep a second copy of '${TyreCore.STORAGE_KEY}'`
  );
  assert.ok(outsideTheBlock.includes('STORAGE_KEY'), 'the dashboard does persist under the shared key');
});
