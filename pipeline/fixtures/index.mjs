// Offline fixtures for Stage 1.
//
// One .txt per company id in pipeline/config/companies.mjs, each a synthetic
// Q1 FY26 quarterly results announcement written in the register these companies
// actually file in. They exist so the whole pipeline — retrieval, extraction,
// quote verification, workbook, Q&A — can be run end to end with no network and
// no API key.
//
// Every fixture carries a "SYNTHETIC TEST DATA" marker on its first line. The
// numbers are internally consistent but invented; nothing here is a real filing
// and no figure should be quoted as one.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path of a company's fixture filing, whether or not it exists yet. */
export function fixturePath(id) {
  return join(FIXTURES_DIR, `${id}.txt`);
}

/** Every fixture on disk, as { id, path }, sorted by id. */
export function listFixtures() {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.txt'))
    .sort()
    .map((name) => ({ id: name.slice(0, -4), path: join(FIXTURES_DIR, name) }));
}
