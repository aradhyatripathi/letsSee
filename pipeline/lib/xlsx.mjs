// Loads the shared Excel writer (pipeline/lib/xlsx-source.js) for Node.
//
// Same arrangement as core.mjs and deck.mjs: xlsx-source.js is a plain browser script
// because the identical text is inlined into the dashboard, so the Export button and
// `node pipeline/workbook.mjs` cannot drift into producing different files.
//
// TyreCore and TyreDeck are passed in as parameters rather than read off a global. The
// deck block owns the ZIP container — a .xlsx and a .pptx are the same kind of package —
// so this one depends on it, which is why the load order matters here and in the
// dashboard.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { TyreCore } from './core.mjs';
import { TyreDeck } from './deck.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const XLSX_SOURCE_PATH = join(here, 'xlsx-source.js');
export const XLSX_SOURCE = readFileSync(XLSX_SOURCE_PATH, 'utf8');

const defineXlsx = vm.runInThisContext(
  `(function (window, globalThis, TyreCore, TyreDeck) {\n${XLSX_SOURCE}\n;return typeof TyreXlsx === 'undefined' ? null : TyreXlsx;\n})`,
  { filename: XLSX_SOURCE_PATH }
);

const xlsx = defineXlsx(undefined, undefined, TyreCore, TyreDeck);
if (!xlsx) {
  throw new Error(`${XLSX_SOURCE_PATH} did not define TyreXlsx`);
}

/** The shared Excel writer: workbook model in, .xlsx bytes out. */
export const TyreXlsx = xlsx;
export default TyreXlsx;
