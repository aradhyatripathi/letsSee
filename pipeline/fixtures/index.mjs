// Offline fixtures for Stage 1.
//
// One .txt per company id per quarter, laid out as
// pipeline/fixtures/<quarter-slug>/<id>.txt. Each is a synthetic quarterly results
// announcement written in the register these companies actually file in. They exist so
// the whole pipeline — retrieval, extraction, quote verification, workbook, deck, Q&A —
// can be run end to end with no network and no API key.
//
// Every quarter gets its own directory, including the default one. The uniformity is
// deliberate: a layout where the current quarter sits at the top level and the others
// hide in subdirectories is the kind of special case that bites whoever adds the third.
//
// Two quarters are present. Where a company's Q1 FY26 filing carries comparative columns,
// the Q4 FY25 fixture restates that column exactly, so the two filings agree about the
// same quarter the way real successive filings do. Where the Q1 FY26 filing is
// single-column, the Q4 FY25 figures are invented to be a plausible predecessor.
//
// Every fixture carries a "SYNTHETIC TEST DATA" marker on its first line. The numbers are
// internally consistent but invented; nothing here is a real filing and no figure should
// be quoted as one.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUARTER_DEFAULT } from '../config/companies.mjs';

export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/** Directory name for a quarter label: 'Q1 FY26' -> 'q1-fy26'. */
export function quarterSlug(quarter) {
  const s = String(quarter == null ? '' : quarter)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'unknown-quarter';
}

/** Absolute path of a company's fixture filing, whether or not it exists yet. */
export function fixturePath(id, quarter) {
  return join(FIXTURES_DIR, quarterSlug(quarter || QUARTER_DEFAULT), `${id}.txt`);
}

/** Every fixture on disk for one quarter, as { id, path }, sorted by id. */
export function listFixtures(quarter) {
  const dir = join(FIXTURES_DIR, quarterSlug(quarter || QUARTER_DEFAULT));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.txt'))
    .sort()
    .map((name) => ({ id: name.slice(0, -4), path: join(dir, name) }));
}

/** Quarter directories that exist, as slugs, sorted. */
export function listFixtureQuarters() {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
