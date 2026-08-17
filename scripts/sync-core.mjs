#!/usr/bin/env node
// Copies pipeline/lib/core-source.js into the dashboard between the TYRE-CORE
// markers, so the single-file dashboard and the Node pipeline share one contract.
//
//   node scripts/sync-core.mjs           write the dashboard
//   node scripts/sync-core.mjs --check   exit 1 if the dashboard is out of date

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PATH = join(root, 'pipeline/lib/core-source.js');
const DASH_PATH = join(root, 'dashboard/tyre_comparison_dashboard.html');

const BEGIN = '/* ==== TYRE-CORE:BEGIN ====';
const END = '/* ==== TYRE-CORE:END ==== */';

/** Pull the inlined core block out of the dashboard HTML. */
export function extractCoreBlock(html) {
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error('dashboard is missing the TYRE-CORE:BEGIN/END markers');
  }
  return html.slice(start, end + END.length);
}

function canonicalCore() {
  const src = readFileSync(CORE_PATH, 'utf8');
  return extractCoreBlock(src);
}

function main() {
  const check = process.argv.includes('--check');
  const core = canonicalCore();
  const html = readFileSync(DASH_PATH, 'utf8');
  const current = extractCoreBlock(html);

  if (current === core) {
    console.log('core block in sync');
    return;
  }
  if (check) {
    console.error('dashboard core block is out of date — run `npm run sync:core`');
    process.exit(1);
  }
  writeFileSync(DASH_PATH, html.replace(current, core), 'utf8');
  console.log('dashboard core block updated from pipeline/lib/core-source.js');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
