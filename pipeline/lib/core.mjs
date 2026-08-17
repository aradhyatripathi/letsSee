// Loads the shared core (pipeline/lib/core-source.js) for Node.
//
// core-source.js is a plain browser script — no imports, no exports — because the
// same text is inlined into the dashboard. Rather than keep a second, divergent
// ES-module copy, we evaluate that one file in a throwaway context and re-export
// what it defines. One source of truth; scripts/sync-core.mjs keeps the copy
// inside the dashboard byte-identical, and test/core-sync.test.mjs fails if it
// ever drifts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));

export const CORE_SOURCE_PATH = join(here, 'core-source.js');
export const CORE_SOURCE = readFileSync(CORE_SOURCE_PATH, 'utf8');

const sandbox = { window: undefined, globalThis: undefined };
vm.createContext(sandbox);
vm.runInContext(CORE_SOURCE, sandbox, { filename: 'core-source.js' });

if (!sandbox.TyreCore) {
  throw new Error('core-source.js did not define TyreCore');
}

/** The shared data contract: schema, transforms, verification, prompts, workbook. */
export const TyreCore = sandbox.TyreCore;
export default TyreCore;
