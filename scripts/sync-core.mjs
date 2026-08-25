#!/usr/bin/env node
// Copies the shared source files into the dashboard between their markers, so the
// single-file dashboard and the Node pipeline share one contract and one renderer.
//
//   node scripts/sync-core.mjs           write the dashboard
//   node scripts/sync-core.mjs --check   exit 1 if the dashboard is out of date
//
// Each block is a plain browser script that the dashboard inlines verbatim and
// Node loads through a vm shim. Editing the copy inside the dashboard is a test
// failure rather than a mystery: test/core-sync.test.mjs runs --check.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASH_PATH = join(root, 'dashboard/tyre_comparison_dashboard.html');

/** Every block kept in sync, in the order the dashboard loads them. */
export const BLOCKS = [
  { name: 'core', source: join(root, 'pipeline/lib/core-source.js'), marker: 'TYRE-CORE' },
  { name: 'deck', source: join(root, 'pipeline/lib/deck-source.js'), marker: 'TYRE-DECK' }
];

function markers(marker) {
  return { begin: `/* ==== ${marker}:BEGIN ====`, end: `/* ==== ${marker}:END ==== */` };
}

/** Pull one inlined block out of a file by its markers. */
export function extractBlock(text, marker) {
  const { begin, end } = markers(marker);
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start === -1 || stop === -1) {
    throw new Error(`missing the ${marker}:BEGIN/END markers`);
  }
  if (stop < start) {
    throw new Error(`${marker}:END appears before ${marker}:BEGIN`);
  }
  return text.slice(start, stop + end.length);
}

/** Back-compat for callers that only ever wanted the core block. */
export function extractCoreBlock(html) {
  return extractBlock(html, 'TYRE-CORE');
}

/** Which blocks in the dashboard differ from their canonical source. */
export function diffBlocks() {
  const html = readFileSync(DASH_PATH, 'utf8');
  return BLOCKS.map((block) => {
    const canonical = extractBlock(readFileSync(block.source, 'utf8'), block.marker);
    const current = extractBlock(html, block.marker);
    return { ...block, canonical, current, inSync: canonical === current };
  });
}

function main() {
  const check = process.argv.includes('--check');
  let html = readFileSync(DASH_PATH, 'utf8');
  const blocks = diffBlocks();
  const stale = blocks.filter((b) => !b.inSync);

  if (!stale.length) {
    console.log(`${blocks.length} block${blocks.length === 1 ? '' : 's'} in sync (${blocks.map((b) => b.name).join(', ')})`);
    return;
  }
  if (check) {
    for (const b of stale) {
      console.error(`dashboard ${b.marker} block is out of date — run \`npm run sync:core\``);
    }
    process.exit(1);
  }
  for (const b of stale) {
    html = html.replace(b.current, () => b.canonical);
    console.log(`dashboard ${b.marker} block updated from ${b.source.replace(`${root}/`, '')}`);
  }
  writeFileSync(DASH_PATH, html, 'utf8');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
